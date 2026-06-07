import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.middleware'

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
}
