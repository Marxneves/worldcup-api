import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAdmin } from '../middleware/auth.middleware'
import { fetchResultsFromGlobo } from '../services/scraper.service'
import { recalculatePoints } from '../services/scoring.service'

const copyMemberSchema = z.object({
  userId: z.string(),
  sourcePoolId: z.string(),
  targetPoolId: z.string(),
  asShadow: z.boolean(),
})

const removeMemberSchema = z.object({
  userId: z.string(),
  poolId: z.string(),
})

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

  fastify.get('/pools', { preHandler: requireAdmin }, async () => {
    const pools = await fastify.prisma.pool.findMany({
      include: { _count: { select: { members: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return {
      pools: pools.map(p => ({
        id: p.id,
        name: p.name,
        code: p.code,
        memberCount: p._count.members,
      })),
    }
  })

  fastify.get('/pools/:poolId/members', { preHandler: requireAdmin }, async (request, reply) => {
    const { poolId } = request.params as { poolId: string }
    const members = await fastify.prisma.poolMember.findMany({
      where: { poolId },
      include: { user: true },
      orderBy: { joinedAt: 'asc' },
    })
    if (!members.length) return reply.status(404).send({ error: 'Bolão não encontrado ou sem membros' })
    return {
      members: members.map(m => ({
        userId: m.userId,
        name: m.user.name,
        isShadow: m.isShadow,
      })),
    }
  })

  fastify.post('/copy-member', { preHandler: requireAdmin }, async (request, reply) => {
    const body = copyMemberSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Dados inválidos' })

    const { userId, sourcePoolId, targetPoolId, asShadow } = body.data

    if (sourcePoolId === targetPoolId) {
      return reply.status(400).send({ error: 'Bolão de origem e destino devem ser diferentes' })
    }

    const isMemberOfSource = await fastify.prisma.poolMember.findUnique({
      where: { poolId_userId: { poolId: sourcePoolId, userId } },
    })
    if (!isMemberOfSource) {
      return reply.status(404).send({ error: 'Usuário não é membro do bolão de origem' })
    }

    const alreadyInTarget = await fastify.prisma.poolMember.findUnique({
      where: { poolId_userId: { poolId: targetPoolId, userId } },
    })
    if (alreadyInTarget) {
      return reply.status(409).send({ error: 'Usuário já faz parte do bolão destino' })
    }

    await fastify.prisma.poolMember.create({
      data: { poolId: targetPoolId, userId, isShadow: asShadow },
    })

    const sourcePredictions = await fastify.prisma.prediction.findMany({
      where: { userId, poolId: sourcePoolId, isLocked: true },
    })

    if (sourcePredictions.length > 0) {
      await fastify.prisma.prediction.createMany({
        data: sourcePredictions.map(p => ({
          userId,
          poolId: targetPoolId,
          gameId: p.gameId,
          score1: p.score1,
          score2: p.score2,
          points: p.points,
          isLocked: true,
        })),
        skipDuplicates: true,
      })
    }

    const user = await fastify.prisma.user.findUnique({ where: { id: userId } })
    return {
      message: `${user?.name} copiado para o bolão destino com ${sourcePredictions.length} palpite(s)`,
      copiedPredictions: sourcePredictions.length,
    }
  })

  fastify.delete('/remove-member', { preHandler: requireAdmin }, async (request, reply) => {
    const body = removeMemberSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Dados inválidos' })

    const { userId, poolId } = body.data

    const membership = await fastify.prisma.poolMember.findUnique({
      where: { poolId_userId: { poolId, userId } },
      include: { user: true },
    })
    if (!membership) return reply.status(404).send({ error: 'Membro não encontrado neste bolão' })

    await fastify.prisma.prediction.deleteMany({ where: { userId, poolId } })
    await fastify.prisma.poolMember.delete({ where: { poolId_userId: { poolId, userId } } })

    return { message: `${membership.user.name} removido do bolão` }
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
