import { FastifyPluginAsync } from 'fastify'
import { requireAuth } from '../middleware/auth.middleware'
import { syncLiveResults } from '../services/live-scores.service'

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

  fastify.get('/sync-live', { preHandler: requireAuth }, async (request, reply) => {
    const { mockLive } = request.query as { mockLive?: string }

    if (mockLive && process.env.NODE_ENV !== 'production') {
      const gameNumber = parseInt(mockLive)
      const game = await fastify.prisma.game.findUnique({ where: { number: gameNumber } })
      if (game) {
        return {
          liveScores: [{
            gameNumber,
            score1: 1,
            score2: 0,
            timeElapsed: '67\'',
          }],
        }
      }
    }

    try {
      const liveScores = await syncLiveResults(fastify.prisma)
      return { liveScores }
    } catch {
      return reply.send({ liveScores: [] })
    }
  })
}
