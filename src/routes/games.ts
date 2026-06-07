import { FastifyPluginAsync } from 'fastify'
import { requireAuth } from '../middleware/auth.middleware'

export const gameRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { preHandler: requireAuth }, async () => {
    const games = await fastify.prisma.game.findMany({
      orderBy: { number: 'asc' },
    })
    return { games }
  })

  fastify.get('/upcoming', { preHandler: requireAuth }, async () => {
    const now = new Date()
    const games = await fastify.prisma.game.findMany({
      where: {
        matchDate: { gte: now },
        score1: null,
      },
      orderBy: { matchDate: 'asc' },
      take: 8,
    })
    return { games }
  })
}
