import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAdmin, requireAuth } from '../middleware/auth.middleware'
import { syncLiveResults, clearLiveCache } from '../services/live-scores.service'
import { recalculatePoints } from '../services/scoring.service'
import { advanceBracket, resolveR32Teams } from '../services/bracket.service'

interface OddsApiOutcome {
  name: string
  price: number
}

interface OddsApiMarket {
  key: string
  outcomes: OddsApiOutcome[]
}

interface OddsApiBookmaker {
  key: string
  markets: OddsApiMarket[]
}

interface OddsApiEvent {
  id: string
  home_team: string
  away_team: string
  bookmakers: OddsApiBookmaker[]
}

const TEAM_NAME_MAP: Record<string, string> = {
  'USA': 'Estados Unidos', 'United States': 'Estados Unidos',
  'Brazil': 'Brasil', 'Germany': 'Alemanha', 'France': 'França',
  'Spain': 'Espanha', 'Argentina': 'Argentina', 'England': 'Inglaterra',
  'Portugal': 'Portugal', 'Netherlands': 'Holanda', 'Belgium': 'Bélgica',
  'Croatia': 'Croácia', 'Morocco': 'Marrocos', 'Japan': 'Japão',
  'Senegal': 'Senegal', 'Australia': 'Austrália', 'South Korea': 'Coreia do Sul',
  'Mexico': 'México', 'Colombia': 'Colômbia', 'Ecuador': 'Equador',
  'Uruguay': 'Uruguai', 'Chile': 'Chile', 'Peru': 'Peru',
  'Switzerland': 'Suíça', 'Denmark': 'Dinamarca', 'Sweden': 'Suécia',
  'Poland': 'Polônia', 'Serbia': 'Sérvia', 'Austria': 'Áustria',
  'Hungary': 'Hungria', 'Slovakia': 'Eslováquia', 'Slovenia': 'Eslovênia',
  'Czech Republic': 'República Tcheca', 'Turkey': 'Turquia',
  'Ukraine': 'Ucrânia', 'Romania': 'Romênia', 'Greece': 'Grécia',
  'Scotland': 'Escócia', 'Wales': 'País de Gales', 'Albania': 'Albânia',
  'Canada': 'Canadá', 'Saudi Arabia': 'Arábia Saudita', 'Iran': 'Irã',
  'Qatar': 'Catar', 'Tunisia': 'Tunísia', 'Cameroon': 'Camarões',
  'Ghana': 'Gana', 'Nigeria': 'Nigéria', 'Egypt': 'Egito',
  'Algeria': 'Argélia', 'Mali': 'Mali', 'Ivory Coast': 'Costa do Marfim',
  "Côte d'Ivoire": 'Costa do Marfim', 'DR Congo': 'Congo',
  'New Zealand': 'Nova Zelândia', 'Paraguay': 'Paraguai',
  'Venezuela': 'Venezuela', 'Bolivia': 'Bolívia', 'Honduras': 'Honduras',
  'Panama': 'Panamá', 'Costa Rica': 'Costa Rica', 'Jamaica': 'Jamaica',
  'Trinidad & Tobago': 'Trinidad e Tobago',
  'Indonesia': 'Indonésia', 'Thailand': 'Tailândia', 'Vietnam': 'Vietnã',
  'Uzbekistan': 'Uzbequistão', 'Iraq': 'Iraque', 'Jordan': 'Jordânia',
  'Palestine': 'Palestina', 'Syria': 'Síria', 'Kuwait': 'Kuwait',
  'Bahrain': 'Bahrein', 'United Arab Emirates': 'Emirados Árabes',
  'Israel': 'Israel', 'Iceland': 'Islândia', 'Norway': 'Noruega',
  'Finland': 'Finlândia', 'Montenegro': 'Montenegro', 'Kosovo': 'Kosovo',
  'North Macedonia': 'Macedônia do Norte', 'Bosnia and Herzegovina': 'Bósnia',
  'Georgia': 'Geórgia', 'Kazakhstan': 'Cazaquistão',
  'Azerbaijan': 'Azerbaijão', 'Armenia': 'Armênia',
}

function normalizeTeamName(name: string): string {
  return (TEAM_NAME_MAP[name] ?? name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function findOddsMatch(events: OddsApiEvent[], team1: string, team2: string): OddsApiEvent | null {
  const t1 = normalizeTeamName(team1)
  const t2 = normalizeTeamName(team2)
  return events.find(e => {
    const h = normalizeTeamName(e.home_team)
    const a = normalizeTeamName(e.away_team)
    return (h === t1 && a === t2) || (h === t2 && a === t1)
  }) ?? null
}

function extractProbabilities(
  event: OddsApiEvent,
  team1: string,
  _team2: string
): { prob1: number; probX: number; prob2: number } {
  const bookmaker = event.bookmakers.find(b => b.key === 'pinnacle') ?? event.bookmakers[0]
  const h2h = bookmaker?.markets.find(m => m.key === 'h2h')
  if (!h2h) return { prob1: 0.38, probX: 0.27, prob2: 0.35 }

  const t1 = normalizeTeamName(team1)
  const outcomes = h2h.outcomes

  const homeOutcome = outcomes.find(o => normalizeTeamName(o.name) === normalizeTeamName(event.home_team))
  const awayOutcome = outcomes.find(o => normalizeTeamName(o.name) === normalizeTeamName(event.away_team))
  const drawOutcome = outcomes.find(o => o.name.toLowerCase() === 'draw')

  if (!homeOutcome || !awayOutcome) return { prob1: 0.38, probX: 0.27, prob2: 0.35 }

  const rawHome = 1 / homeOutcome.price
  const rawDraw = drawOutcome ? 1 / drawOutcome.price : 0.27
  const rawAway = 1 / awayOutcome.price
  const total = rawHome + rawDraw + rawAway

  const probHome = rawHome / total
  const probDraw = rawDraw / total
  const probAway = rawAway / total

  const homeIsTeam1 = normalizeTeamName(event.home_team) === t1
  return {
    prob1: homeIsTeam1 ? probHome : probAway,
    probX: probDraw,
    prob2: homeIsTeam1 ? probAway : probHome,
  }
}

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

  fastify.get('/features', { preHandler: requireAuth }, async (_request, _reply) => {
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

  fastify.post('/sync-odds', { preHandler: requireAdmin }, async (_request, reply) => {
    const apiKey = process.env.ODDS_API_KEY
    if (!apiKey) return reply.status(503).send({ error: 'ODDS_API_KEY não configurada' })

    const alreadySynced = await fastify.prisma.game.count({
      where: { score1: null, prob1: { not: null }, number: { lte: 72 } },
    })
    if (alreadySynced > 0) {
      return reply.status(409).send({
        error: 'Odds já sincronizadas. Para re-sincronizar, use ?force=true',
        syncedCount: alreadySynced,
      })
    }

    let oddsData: OddsApiEvent[]
    try {
      const response = await fetch(
        `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/?apiKey=${apiKey}&regions=eu&markets=h2h&oddsFormat=decimal`
      )
      if (!response.ok) {
        const text = await response.text()
        return reply.status(502).send({ error: `The Odds API retornou ${response.status}: ${text}` })
      }
      oddsData = (await response.json()) as OddsApiEvent[]
    } catch (err) {
      return reply.status(502).send({ error: 'Falha ao chamar The Odds API', detail: String(err) })
    }

    const pendingGames = await fastify.prisma.game.findMany({
      where: { score1: null, number: { lte: 72 } },
    })

    let updatedCount = 0
    const skipped: string[] = []

    for (const game of pendingGames) {
      const match = findOddsMatch(oddsData, game.team1, game.team2)
      if (!match) {
        skipped.push(`${game.team1} x ${game.team2}`)
        continue
      }

      const { prob1, probX, prob2 } = extractProbabilities(match, game.team1, game.team2)
      await fastify.prisma.game.update({
        where: { id: game.id },
        data: { prob1, probX, prob2 },
      })
      updatedCount++
    }

    return {
      message: `${updatedCount} jogo(s) com odds atualizadas`,
      skipped: skipped.length > 0 ? skipped : undefined,
    }
  })

  fastify.get('/member-predictions/:userId', { preHandler: requireAdmin }, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    const { poolId } = request.query as { poolId?: string }

    if (!poolId) return reply.status(400).send({ error: 'poolId é necessário' })

    const isMember = await fastify.prisma.poolMember.findUnique({
      where: { poolId_userId: { poolId, userId } },
    })
    if (!isMember) return reply.status(404).send({ error: 'Usuário não é membro do bolão' })

    const predictions = await fastify.prisma.prediction.findMany({
      where: { userId, poolId },
      include: { game: true },
      orderBy: { game: { number: 'asc' } },
    })

    return { predictions }
  })

  fastify.patch('/validate-prediction/:predictionId', { preHandler: requireAdmin }, async (request, reply) => {
    const { predictionId } = request.params as { predictionId: string }

    const prediction = await fastify.prisma.prediction.findUnique({
      where: { id: predictionId },
      include: { game: true },
    })

    if (!prediction) return reply.status(404).send({ error: 'Palpite não encontrado' })
    if (prediction.isLocked) return reply.status(409).send({ error: 'Palpite já está validado' })

    await fastify.prisma.prediction.update({
      where: { id: predictionId },
      data: { isLocked: true },
    })

    if (prediction.game.score1 !== null && prediction.game.score2 !== null) {
      await recalculatePoints(fastify.prisma, prediction.gameId, prediction.game.score1, prediction.game.score2)
    }

    const updated = await fastify.prisma.prediction.findUnique({
      where: { id: predictionId },
      include: { game: true },
    })

    return { prediction: updated, message: 'Palpite validado com sucesso!' }
  })

  fastify.patch('/toggle-member-visibility', { preHandler: requireAdmin }, async (request, reply) => {
    const schema = z.object({ poolId: z.string(), userId: z.string() })
    const body = schema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Dados inválidos' })

    const { poolId, userId } = body.data

    const member = await fastify.prisma.poolMember.findUnique({
      where: { poolId_userId: { poolId, userId } },
    })
    if (!member) return reply.status(404).send({ error: 'Membro não encontrado' })

    const updated = await fastify.prisma.poolMember.update({
      where: { poolId_userId: { poolId, userId } },
      data: { isHidden: !member.isHidden },
    })

    return { isHidden: updated.isHidden }
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
