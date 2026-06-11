import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAuth, requireAdmin } from '../middleware/auth.middleware'

function generateCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

export const poolRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const schema = z.object({ name: z.string().min(2) })
    const body = schema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Nome do bolão inválido' })

    const user = request.user as { id: string }
    let code = generateCode()
    let attempts = 0

    while (attempts < 10) {
      const exists = await fastify.prisma.pool.findUnique({ where: { code } })
      if (!exists) break
      code = generateCode()
      attempts++
    }

    const pool = await fastify.prisma.pool.create({
      data: {
        name: body.data.name,
        code,
        ownerId: user.id,
        members: { create: { userId: user.id } },
      },
    })

    return { pool: { id: pool.id, name: pool.name, code: pool.code } }
  })

  fastify.post('/join', { preHandler: requireAuth }, async (request, reply) => {
    const schema = z.object({ code: z.string().length(6) })
    const body = schema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Código inválido' })

    const user = request.user as { id: string }
    const pool = await fastify.prisma.pool.findUnique({ where: { code: body.data.code.toUpperCase() } })
    if (!pool) return reply.status(404).send({ error: 'Bolão não encontrado' })

    const alreadyMember = await fastify.prisma.poolMember.findUnique({
      where: { poolId_userId: { poolId: pool.id, userId: user.id } },
    })

    if (!alreadyMember) {
      await fastify.prisma.poolMember.create({ data: { poolId: pool.id, userId: user.id } })
    }

    return { pool: { id: pool.id, name: pool.name, code: pool.code } }
  })

  fastify.get('/:code', { preHandler: requireAuth }, async (request, reply) => {
    const { code } = request.params as { code: string }
    const pool = await fastify.prisma.pool.findUnique({
      where: { code: code.toUpperCase() },
      include: { _count: { select: { members: true } } },
    })
    if (!pool) return reply.status(404).send({ error: 'Bolão não encontrado' })
    return { pool: { id: pool.id, name: pool.name, code: pool.code, memberCount: pool._count.members } }
  })

  fastify.get('/my', { preHandler: requireAuth }, async (request) => {
    const user = request.user as { id: string }
    const memberships = await fastify.prisma.poolMember.findMany({
      where: { userId: user.id },
      include: {
        pool: {
          include: {
            _count: { select: { members: true } },
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    })

    return {
      pools: memberships.map(m => ({
        id: m.pool.id,
        name: m.pool.name,
        code: m.pool.code,
        memberCount: m.pool._count.members,
        isOwner: m.pool.ownerId === user.id,
      })),
    }
  })

  fastify.delete('/:code/leave', { preHandler: requireAuth }, async (request, reply) => {
    const { code } = request.params as { code: string }
    const user = request.user as { id: string }

    const pool = await fastify.prisma.pool.findUnique({ where: { code: code.toUpperCase() } })
    if (!pool) return reply.status(404).send({ error: 'Bolão não encontrado' })

    const membership = await fastify.prisma.poolMember.findUnique({
      where: { poolId_userId: { poolId: pool.id, userId: user.id } },
    })
    if (!membership) return reply.status(404).send({ error: 'Você não faz parte deste bolão' })

    await fastify.prisma.poolMember.delete({
      where: { poolId_userId: { poolId: pool.id, userId: user.id } },
    })

    return { message: 'Saiu do bolão com sucesso' }
  })

  fastify.get('/:code/ranking', { preHandler: requireAuth }, async (request, reply) => {
    const { code } = request.params as { code: string }
    const pool = await fastify.prisma.pool.findUnique({ where: { code: code.toUpperCase() } })
    if (!pool) return reply.status(404).send({ error: 'Bolão não encontrado' })

    const members = await fastify.prisma.poolMember.findMany({
      where: { poolId: pool.id },
      include: { user: true },
    })

    const rankings = await Promise.all(
      members.map(async (member) => {
        const predictions = await fastify.prisma.prediction.findMany({
          where: { userId: member.userId, poolId: pool.id, isLocked: true },
          include: { game: true },
        })

        const totalPoints = predictions.reduce((sum, p) => sum + (p.points ?? 0), 0)
        const exactScores = predictions.filter(p => p.points === 3).length
        const correctResults = predictions.filter(p => p.points === 1).length
        const lockedCount = predictions.length

        return {
          userId: member.userId,
          name: member.user.name,
          totalPoints,
          exactScores,
          correctResults,
          lockedCount,
        }
      })
    )

    rankings.sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints
      return b.exactScores - a.exactScores
    })

    return { poolName: pool.name, rankings }
  })

  fastify.get('/:code/daily-summary', { preHandler: requireAdmin }, async (request, reply) => {
    const { code } = request.params as { code: string }
    const { date } = request.query as { date?: string }

    const pool = await fastify.prisma.pool.findUnique({ where: { code: code.toUpperCase() } })
    if (!pool) return reply.status(404).send({ error: 'Bolão não encontrado' })

    // BRT = UTC-3: midnight BRT = 03:00 UTC
    const brtDate = date ?? new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const startUTC = new Date(`${brtDate}T03:00:00Z`)
    const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000)

    const gamesOnDate = await fastify.prisma.game.findMany({
      where: {
        matchDate: { gte: startUTC, lt: endUTC },
        score1: { not: null },
        score2: { not: null },
      },
      orderBy: { number: 'asc' },
    })

    const members = await fastify.prisma.poolMember.findMany({
      where: { poolId: pool.id },
      include: { user: true },
    })

    const gameIds = gamesOnDate.map(g => g.id)

    const gameSummaries = await Promise.all(
      gamesOnDate.map(async (game) => {
        const predictions = await fastify.prisma.prediction.findMany({
          where: { poolId: pool.id, gameId: game.id, isLocked: true },
          include: { user: true },
        })

        const memberPredictions = members.map(member => {
          const prediction = predictions.find(p => p.userId === member.userId)
          return {
            userId: member.userId,
            name: member.user.name,
            score1: prediction?.score1 ?? null,
            score2: prediction?.score2 ?? null,
            points: prediction?.points ?? 0,
          }
        })

        memberPredictions.sort((a, b) => b.points - a.points)

        return {
          number: game.number,
          team1: game.team1,
          team2: game.team2,
          score1: game.score1,
          score2: game.score2,
          matchDate: game.matchDate,
          predictions: memberPredictions,
        }
      })
    )

    const allRankings = await Promise.all(
      members.map(async (member) => {
        const allPredictions = await fastify.prisma.prediction.findMany({
          where: { userId: member.userId, poolId: pool.id, isLocked: true },
        })

        const totalPoints = allPredictions.reduce((sum, p) => sum + (p.points ?? 0), 0)
        const exactScores = allPredictions.filter(p => p.points === 3).length

        const todayPredictions = allPredictions.filter(p => gameIds.includes(p.gameId))
        const todayPoints = todayPredictions.reduce((sum, p) => sum + (p.points ?? 0), 0)
        const previousPoints = totalPoints - todayPoints
        const previousExact = exactScores - todayPredictions.filter(p => p.points === 3).length

        return {
          userId: member.userId,
          name: member.user.name,
          totalPoints,
          exactScores,
          todayPoints,
          previousPoints,
          previousExact,
        }
      })
    )

    const sortedCurrent = [...allRankings].sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints
      return b.exactScores - a.exactScores
    })

    const sortedPrevious = [...allRankings].sort((a, b) => {
      if (b.previousPoints !== a.previousPoints) return b.previousPoints - a.previousPoints
      return b.previousExact - a.previousExact
    })

    const previousPositionMap = new Map(sortedPrevious.map((r, i) => [r.userId, i + 1]))

    const currentRanking = sortedCurrent.map((member, index) => {
      const currentPosition = index + 1
      const previousPosition = previousPositionMap.get(member.userId) ?? currentPosition
      return {
        position: currentPosition,
        previousPosition,
        movement: previousPosition - currentPosition,
        userId: member.userId,
        name: member.name,
        totalPoints: member.totalPoints,
        todayPoints: member.todayPoints,
        exactScores: member.exactScores,
      }
    })

    return {
      date: brtDate,
      poolName: pool.name,
      games: gameSummaries,
      ranking: currentRanking,
    }
  })
}
