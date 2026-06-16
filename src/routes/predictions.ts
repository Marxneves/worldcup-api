import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.middleware'

const savePredictionSchema = z.object({
  poolId: z.string(),
  gameId: z.string(),
  score1: z.number().int().min(0).max(30),
  score2: z.number().int().min(0).max(30),
})

const lockAllSchema = z.object({ poolId: z.string() })

export const predictionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/save', { preHandler: requireAuth }, async (request, reply) => {
    const body = savePredictionSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Dados inválidos' })

    const user = request.user as { id: string }
    const { poolId, gameId, score1, score2 } = body.data

    const isMember = await fastify.prisma.poolMember.findUnique({
      where: { poolId_userId: { poolId, userId: user.id } },
    })
    if (!isMember) return reply.status(403).send({ error: 'Você não faz parte desse bolão' })

    const game = await fastify.prisma.game.findUnique({ where: { id: gameId } })
    if (!game) return reply.status(404).send({ error: 'Jogo não encontrado' })

    if (new Date(game.matchDate) <= new Date()) {
      return reply.status(400).send({ error: 'Este jogo já foi iniciado e não pode mais ser alterado' })
    }

    const existing = await fastify.prisma.prediction.findUnique({
      where: { userId_poolId_gameId: { userId: user.id, poolId, gameId } },
    })
    if (existing?.isLocked) {
      return reply.status(409).send({ error: 'Palpite já confirmado, não pode ser alterado' })
    }

    const prediction = await fastify.prisma.prediction.upsert({
      where: { userId_poolId_gameId: { userId: user.id, poolId, gameId } },
      update: { score1, score2 },
      create: { userId: user.id, poolId, gameId, score1, score2 },
    })

    const shadowMemberships = await fastify.prisma.poolMember.findMany({
      where: { userId: user.id, isShadow: true, NOT: { poolId } },
    })
    for (const shadow of shadowMemberships) {
      const lockedInShadow = await fastify.prisma.prediction.findUnique({
        where: { userId_poolId_gameId: { userId: user.id, poolId: shadow.poolId, gameId } },
        select: { isLocked: true },
      })
      if (lockedInShadow?.isLocked) continue
      await fastify.prisma.prediction.upsert({
        where: { userId_poolId_gameId: { userId: user.id, poolId: shadow.poolId, gameId } },
        update: { score1, score2 },
        create: { userId: user.id, poolId: shadow.poolId, gameId, score1, score2 },
      })
    }

    return { prediction }
  })

  fastify.post('/lock-all', { preHandler: requireAuth }, async (request, reply) => {
    const body = lockAllSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Dados inválidos' })

    const user = request.user as { id: string }
    const { poolId } = body.data

    const isMember = await fastify.prisma.poolMember.findUnique({
      where: { poolId_userId: { poolId, userId: user.id } },
    })
    if (!isMember) return reply.status(403).send({ error: 'Você não faz parte desse bolão' })

    const now = new Date()
    const openGamesCount = await fastify.prisma.game.count({
      where: { matchDate: { gt: now } },
    })
    const filledOpenCount = await fastify.prisma.prediction.count({
      where: { userId: user.id, poolId, game: { matchDate: { gt: now } } },
    })
    if (filledOpenCount < openGamesCount) {
      return reply.status(400).send({
        error: `Preencha todos os ${openGamesCount} jogos disponíveis antes de confirmar`,
      })
    }

    await fastify.prisma.prediction.deleteMany({
      where: { userId: user.id, poolId, game: { matchDate: { lte: now } } },
    })

    await fastify.prisma.prediction.updateMany({
      where: { userId: user.id, poolId },
      data: { isLocked: true },
    })

    return { message: 'Palpites confirmados com sucesso!' }
  })

  fastify.get('/', { preHandler: requireAuth }, async (request) => {
    const { poolId } = request.query as { poolId?: string }
    const user = request.user as { id: string }

    const where: Record<string, unknown> = { userId: user.id }
    if (poolId) where.poolId = poolId

    const predictions = await fastify.prisma.prediction.findMany({
      where,
      include: { game: true },
      orderBy: { game: { number: 'asc' } },
    })

    return { predictions }
  })

  fastify.get('/template', { preHandler: requireAuth }, async (request) => {
    const { excludePoolId } = request.query as { excludePoolId?: string }
    const user = request.user as { id: string }

    const lockedPredictions = await fastify.prisma.prediction.findMany({
      where: {
        userId: user.id,
        isLocked: true,
        ...(excludePoolId ? { NOT: { poolId: excludePoolId } } : {}),
      },
      include: { game: true },
      orderBy: { game: { number: 'asc' } },
    })

    if (!lockedPredictions.length) return { predictions: [] }

    const byPool = new Map<string, typeof lockedPredictions>()
    for (const pred of lockedPredictions) {
      if (!byPool.has(pred.poolId)) byPool.set(pred.poolId, [])
      byPool.get(pred.poolId)!.push(pred)
    }

    const bestPool = [...byPool.values()].sort((a, b) => b.length - a.length)[0]
    return { predictions: bestPool }
  })

  fastify.get('/user/:userId', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    const { poolId } = request.query as { poolId?: string }
    const requester = request.user as { id: string }

    if (!poolId) return reply.status(400).send({ error: 'poolId é necessário' })

    const isMember = await fastify.prisma.poolMember.findUnique({
      where: { poolId_userId: { poolId, userId: requester.id } },
    })
    if (!isMember) return reply.status(403).send({ error: 'Sem acesso a esse bolão' })

    const totalGames = await fastify.prisma.game.count()
    const requesterLockedCount = await fastify.prisma.prediction.count({
      where: { userId: requester.id, poolId, isLocked: true },
    })
    if (requesterLockedCount < totalGames) {
      return reply.status(403).send({ error: 'Confirme seus palpites antes de ver os de outros participantes' })
    }

    const allPredictions = await fastify.prisma.prediction.findMany({
      where: { userId, poolId },
      select: { isLocked: true },
    })
    if (!allPredictions.length || allPredictions.some(p => !p.isLocked)) {
      return reply.status(403).send({ error: 'Palpites ainda não confirmados' })
    }

    const predictions = await fastify.prisma.prediction.findMany({
      where: { userId, poolId },
      include: { game: true },
      orderBy: { game: { number: 'asc' } },
    })
    return { predictions }
  })
}
