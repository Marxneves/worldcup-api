import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAdmin, requireAuth } from '../middleware/auth.middleware'
import { syncLiveResults, clearLiveCache } from '../services/live-scores.service'
import { recalculatePoints } from '../services/scoring.service'
import { advanceBracket, resolveR32Teams } from '../services/bracket.service'

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

const updateMatchDateSchema = z.object({
  matchDate: z.string().datetime(),
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

    if (gameNumber >= 73) {
      await advanceBracket(fastify.prisma, gameNumber, game.team1, game.team2, score1, score2)
    }

    return { message: `Resultado do jogo ${gameNumber} atualizado: ${score1} x ${score2}` }
  })

  fastify.post('/fetch-results', { preHandler: requireAdmin }, async (_, reply) => {
    try {
      clearLiveCache()
      const before = await fastify.prisma.game.count({ where: { score1: { not: null } } })
      await syncLiveResults(fastify.prisma)
      const after = await fastify.prisma.game.count({ where: { score1: { not: null } } })
      const updated = after - before
      return {
        message: updated > 0
          ? `${updated} resultado(s) atualizado(s) via ESPN`
          : 'Nenhum resultado novo encontrado',
      }
    } catch (err) {
      return reply.status(502).send({ error: 'Falha ao sincronizar com a ESPN', detail: String(err) })
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

  fastify.patch('/games/:number/match-date', { preHandler: requireAdmin }, async (request, reply) => {
    const gameNumber = Number((request.params as { number: string }).number)
    const body = updateMatchDateSchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Data inválida' })
    if (isNaN(gameNumber)) return reply.status(400).send({ error: 'Número de jogo inválido' })

    const game = await fastify.prisma.game.findUnique({ where: { number: gameNumber } })
    if (!game) return reply.status(404).send({ error: 'Jogo não encontrado' })

    const updated = await fastify.prisma.game.update({
      where: { id: game.id },
      data: { matchDate: new Date(body.data.matchDate) },
    })

    return { message: `Horário do jogo ${gameNumber} atualizado`, matchDate: updated.matchDate }
  })

  fastify.post('/sync-bracket', { preHandler: requireAdmin }, async () => {
    const resolvedCount = await resolveR32Teams(fastify.prisma)

    // Mapa de avanço: quando o jogo fromGameNumber termina, o vencedor (ou perdedor) vai para o slot toField do toGameNumber
    const BRACKET_MAP: Array<{ from: number; to: number; field: 'team1' | 'team2'; useLoser?: boolean }> = [
      // 16 avos → oitavas
      { from: 73, to: 90, field: 'team1' }, { from: 74, to: 89, field: 'team1' },
      { from: 75, to: 90, field: 'team2' }, { from: 76, to: 91, field: 'team1' },
      { from: 77, to: 89, field: 'team2' }, { from: 78, to: 91, field: 'team2' },
      { from: 79, to: 92, field: 'team1' }, { from: 80, to: 92, field: 'team2' },
      { from: 81, to: 94, field: 'team1' }, { from: 82, to: 94, field: 'team2' },
      { from: 83, to: 93, field: 'team1' }, { from: 84, to: 93, field: 'team2' },
      { from: 85, to: 96, field: 'team1' }, { from: 86, to: 95, field: 'team1' },
      { from: 87, to: 96, field: 'team2' }, { from: 88, to: 95, field: 'team2' },
      // oitavas → quartas
      { from: 89, to: 97, field: 'team1' }, { from: 90, to: 97, field: 'team2' },
      { from: 91, to: 99, field: 'team1' }, { from: 92, to: 99, field: 'team2' },
      { from: 93, to: 98, field: 'team1' }, { from: 94, to: 98, field: 'team2' },
      { from: 95, to: 100, field: 'team1' }, { from: 96, to: 100, field: 'team2' },
      // quartas → semis
      { from: 97, to: 101, field: 'team1' }, { from: 98, to: 101, field: 'team2' },
      { from: 99, to: 102, field: 'team1' }, { from: 100, to: 102, field: 'team2' },
      // semis → final / terceiro lugar
      { from: 101, to: 104, field: 'team1' }, { from: 102, to: 104, field: 'team2' },
      { from: 101, to: 103, field: 'team1', useLoser: true }, { from: 102, to: 103, field: 'team2', useLoser: true },
    ]

    const completed = await fastify.prisma.game.findMany({
      where: { number: { gte: 73 }, score1: { not: null } },
    })

    const gameByNumber = new Map(completed.map(g => [g.number, g]))
    let updatedCount = 0
    const log: string[] = []

    for (const rule of BRACKET_MAP) {
      const source = gameByNumber.get(rule.from)
      if (!source || source.score1 === null) continue

      const advancing = rule.useLoser
        ? (source.score1 > source.score2! ? source.team2 : source.team1)
        : (source.score1 > source.score2! ? source.team1 : source.team2)

      const target = await fastify.prisma.game.findUnique({ where: { number: rule.to } })
      if (!target || target.score1 !== null) continue
      if (target[rule.field] === advancing) continue

      await fastify.prisma.game.update({
        where: { id: target.id },
        data: { [rule.field]: advancing },
      })
      log.push(`J${rule.to}.${rule.field} = ${advancing}`)
      updatedCount++
    }

    return {
      message: updatedCount > 0 || resolvedCount > 0
        ? `${updatedCount} slot(s) do bracket atualizados, ${resolvedCount} placeholder(s) resolvidos`
        : 'Bracket já está em dia',
      updates: log,
    }
  })

  fastify.get('/features', { preHandler: requireAuth }, async (_request, reply) => {
    const setting = await fastify.prisma.setting.findUnique({ where: { key: 'stats_enabled' } })
    return { statsEnabled: setting?.value === 'true' }
  })

  fastify.post('/features', { preHandler: requireAdmin }, async (request, reply) => {
    const schema = z.object({ statsEnabled: z.boolean() })
    const body = schema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Invalid body' })

    await fastify.prisma.setting.upsert({
      where: { key: 'stats_enabled' },
      update: { value: body.data.statsEnabled ? 'true' : 'false' },
      create: { key: 'stats_enabled', value: body.data.statsEnabled ? 'true' : 'false' },
    })
    return { statsEnabled: body.data.statsEnabled }
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
