import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAdmin } from '../middleware/auth.middleware'
import { fetchResultsFromGlobo } from '../services/scraper.service'
import { recalculatePoints } from '../services/scoring.service'

const updateResultSchema = z.object({
  gameNumber: z.number().int(),
  score1: z.number().int().min(0),
  score2: z.number().int().min(0),
})

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/results', { preHandler: requireAdmin }, async (request, reply) => {
    const body = updateResultSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Dados inválidos' })

    const { gameNumber, score1, score2 } = body.data
    const game = await fastify.prisma.game.findUnique({ where: { number: gameNumber } })
    if (!game) return reply.status(404).send({ error: 'Jogo não encontrado' })

    await fastify.prisma.game.update({
      where: { id: game.id },
      data: { score1, score2 },
    })

    await recalculatePoints(fastify.prisma, game.id, score1, score2)

    return { message: `Resultado do jogo ${gameNumber} atualizado: ${score1} x ${score2}` }
  })

  fastify.post('/fetch-results', { preHandler: requireAdmin }, async (_, reply) => {
    try {
      const updated = await fetchResultsFromGlobo()
      for (const result of updated) {
        const game = await fastify.prisma.game.findUnique({ where: { number: result.gameNumber } })
        if (!game) continue

        await fastify.prisma.game.update({
          where: { id: game.id },
          data: { score1: result.score1, score2: result.score2, resultFetched: true },
        })
        await recalculatePoints(fastify.prisma, game.id, result.score1, result.score2)
      }
      return { message: `${updated.length} resultado(s) atualizado(s) via scraping` }
    } catch (err) {
      return reply.status(502).send({ error: 'Falha ao buscar resultados do GE Globo', detail: String(err) })
    }
  })

  fastify.get('/make-admin', async (request, reply) => {
    const { secret, phone } = request.query as { secret?: string; phone?: string }
    if (secret !== process.env.ADMIN_SECRET) return reply.status(403).send({ error: 'Acesso negado' })

    const cleanPhone = phone?.replace(/\D/g, '')
    if (!cleanPhone) return reply.status(400).send({ error: 'Celular obrigatório' })

    const user = await fastify.prisma.user.update({
      where: { phone: cleanPhone },
      data: { isAdmin: true },
    })

    return { message: `${user.name} agora é admin` }
  })
}
