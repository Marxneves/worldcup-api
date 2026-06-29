import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.middleware'

function generateCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

function standardRanking<T>(sorted: T[], areTied: (a: T, b: T) => boolean): Array<T & { position: number }> {
  const positions: number[] = []
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) positions.push(1)
    else if (areTied(sorted[i], sorted[i - 1])) positions.push(positions[i - 1])
    else positions.push(i + 1)
  }
  return sorted.map((item, i) => ({ ...item, position: positions[i] }))
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
      where: { userId: user.id, isShadow: false },
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
    const { phase } = request.query as { phase?: string }
    const pool = await fastify.prisma.pool.findUnique({ where: { code: code.toUpperCase() } })
    if (!pool) return reply.status(404).send({ error: 'Bolão não encontrado' })

    const members = await fastify.prisma.poolMember.findMany({
      where: { poolId: pool.id },
      include: { user: true },
    })

    const rankings = await Promise.all(
      members.map(async (member) => {
        const allPredictions = await fastify.prisma.prediction.findMany({
          where: { userId: member.userId, poolId: pool.id, isLocked: true },
          include: { game: true },
        })

        const predictions = phase === 'grupos'
          ? allPredictions.filter(p => p.game.number <= 72)
          : phase === 'matamata'
            ? allPredictions.filter(p => p.game.number >= 73)
            : allPredictions

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
          isHidden: member.isHidden,
        }
      })
    )

    rankings.sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints
      return b.exactScores - a.exactScores
    })

    const rankedEntries = standardRanking(
      rankings,
      (a, b) => a.totalPoints === b.totalPoints && a.exactScores === b.exactScores
    )

    return { poolName: pool.name, rankings: rankedEntries }
  })

  fastify.get('/:code/daily-summary', { preHandler: requireAuth }, async (request, reply) => {
    const { code } = request.params as { code: string }
    const { date, upToGame, phase } = request.query as { date?: string; upToGame?: string; phase?: string }
    const upToGameNumber = upToGame ? parseInt(upToGame, 10) : null
    const summaryPhase = phase === 'grupos' ? 'grupos' : phase === 'total' ? 'total' : 'matamata'

    const pool = await fastify.prisma.pool.findUnique({ where: { code: code.toUpperCase() } })
    if (!pool) return reply.status(404).send({ error: 'Bolão não encontrado' })

    // BRT = UTC-3: midnight BRT = 03:00 UTC
    const brtDate = date ?? new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const startUTC = new Date(`${brtDate}T03:00:00Z`)
    const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000)

    const gamesOnDate = await fastify.prisma.game.findMany({
      where: {
        matchDate: { gte: startUTC, lt: endUTC },
      },
      orderBy: { matchDate: 'asc' },
    })

    // When filtering by a specific game, show only that game's card
    const visibleGames = upToGameNumber !== null
      ? gamesOnDate.filter(g => g.number === upToGameNumber)
      : gamesOnDate

    const members = await fastify.prisma.poolMember.findMany({
      where: { poolId: pool.id, isHidden: false },
      include: { user: true },
    })

    const gameSummaries = await Promise.all(
      visibleGames.map(async (game) => {
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

    // Ranking always scoped to a specific ceiling game:
    // - explicit upToGame param → that game number
    // - "Todos" (no param) → last game number of the selected day
    const rankingCeiling = upToGameNumber ?? (gamesOnDate.length > 0 ? Math.max(...gamesOnDate.map(g => g.number)) : null)
    const phaseNumberFilter = (ceil: number) =>
      summaryPhase === 'matamata' ? { gte: 73, lte: ceil }
      : summaryPhase === 'grupos'  ? { lte: Math.min(72, ceil) }
      : { lte: ceil }
    const gamesForRanking = rankingCeiling !== null
      ? await fastify.prisma.game.findMany({ where: { number: phaseNumberFilter(rankingCeiling), score1: { not: null } } })
      : []

    const rankingGameIds = gamesForRanking.map(g => g.id)
    // Points from only the "scope" game(s) — single game when upToGame set, else all games of the day
    const scopeGamesIds = upToGameNumber !== null
      ? gamesForRanking.filter(g => g.number === upToGameNumber).map(g => g.id)
      : gamesOnDate.map(g => g.id)

    const allRankings = await Promise.all(
      members.map(async (member) => {
        const predictions = await fastify.prisma.prediction.findMany({
          where: { userId: member.userId, poolId: pool.id, isLocked: true, gameId: { in: rankingGameIds } },
        })

        const totalPoints = predictions.reduce((sum, p) => sum + (p.points ?? 0), 0)
        const exactScores = predictions.filter(p => p.points === 3).length

        const scopePredictions = predictions.filter(p => scopeGamesIds.includes(p.gameId))
        const scopePoints = scopePredictions.reduce((sum, p) => sum + (p.points ?? 0), 0)

        const previousPoints = totalPoints - scopePoints
        const previousExact = exactScores - scopePredictions.filter(p => p.points === 3).length

        return {
          userId: member.userId,
          name: member.user.name,
          totalPoints,
          exactScores,
          todayPoints: scopePoints,
          previousPoints,
          previousExact,
        }
      })
    )

    const sortedCurrent = standardRanking(
      [...allRankings].sort((a, b) => {
        if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints
        return b.exactScores - a.exactScores
      }),
      (a, b) => a.totalPoints === b.totalPoints && a.exactScores === b.exactScores
    )

    const rankedPrevious = standardRanking(
      [...allRankings].sort((a, b) => {
        if (b.previousPoints !== a.previousPoints) return b.previousPoints - a.previousPoints
        return b.previousExact - a.previousExact
      }),
      (a, b) => a.previousPoints === b.previousPoints && a.previousExact === b.previousExact
    )

    const previousPositionMap = new Map(rankedPrevious.map(r => [r.userId, r.position]))

    const currentRanking = sortedCurrent.map((member) => {
      const currentPosition = member.position
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

  fastify.get('/:code/ranking-stats', { preHandler: requireAuth }, async (request, reply) => {
    const { code } = request.params as { code: string }
    const { phase } = request.query as { phase?: string }
    const resolvedPhase = phase === 'knockout' ? 'knockout' : 'grupos'

    const pool = await fastify.prisma.pool.findUnique({ where: { code: code.toUpperCase() } })
    if (!pool) return reply.status(404).send({ error: 'Bolão não encontrado' })

    const now = new Date()

    const members = await fastify.prisma.poolMember.findMany({
      where: { poolId: pool.id, isHidden: false },
      include: { user: true },
    })

    const phaseFilter = resolvedPhase === 'grupos'
      ? { number: { lte: 72 } }
      : { number: { gte: 73 } }

    const remainingGames = await fastify.prisma.game.findMany({
      where: { score1: null, ...phaseFilter },
      orderBy: { number: 'asc' },
    })

    const allPredictions = await fastify.prisma.prediction.findMany({
      where: { poolId: pool.id, isLocked: true },
    })

    type PredMap = Map<string, { score1: number; score2: number }>

    const memberDataList = members.map((member) => {
      const memberPreds = allPredictions.filter(p => p.userId === member.userId)
      const currentPoints = memberPreds.reduce((sum, p) => sum + (p.points ?? 0), 0)
      const exactScores = memberPreds.filter(p => p.points === 3).length
      const predByGameId: PredMap = new Map(
        memberPreds.map(p => [p.gameId, { score1: p.score1, score2: p.score2 }])
      )
      return { userId: member.userId, name: member.user.name, currentPoints, exactScores, predByGameId }
    })

    memberDataList.sort((a, b) => {
      if (b.currentPoints !== a.currentPoints) return b.currentPoints - a.currentPoints
      return b.exactScores - a.exactScores
    })

    const rankedList = standardRanking(
      memberDataList,
      (a, b) => a.currentPoints === b.currentPoints && a.exactScores === b.exactScores
    )

    function getWinner(s1: number, s2: number): 'team1' | 'draw' | 'team2' {
      if (s1 > s2) return 'team1'
      if (s1 < s2) return 'team2'
      return 'draw'
    }

    function maxDiffBoverA(
      gameStarted: boolean,
      predB: { score1: number; score2: number } | undefined,
      predA: { score1: number; score2: number } | undefined
    ): number {
      if (!predB && gameStarted) return 0
      if (!predA) return 3
      if (predB && predB.score1 === predA.score1 && predB.score2 === predA.score2) return 0
      if (!predB) return 3 // game not started, B can still predict to beat A's locked prediction
      if (getWinner(predB.score1, predB.score2) === getWinner(predA.score1, predA.score2)) return 2
      return 3
    }

    function maxPossibleForMember(predByGameId: PredMap): number {
      return remainingGames.reduce((sum, game) => {
        const gameStarted = game.matchDate <= now
        if (!predByGameId.has(game.id) && gameStarted) return sum
        return sum + 3
      }, 0)
    }

    const results = rankedList.map((memberB) => {
      const opponents = rankedList
        .filter(memberA => memberA.userId !== memberB.userId)
        .map((memberA) => {
          const gap = memberA.currentPoints - memberB.currentPoints
          let maxGain = 0
          for (const game of remainingGames) {
            const gameStarted = game.matchDate <= now
            maxGain += maxDiffBoverA(gameStarted, memberB.predByGameId.get(game.id), memberA.predByGameId.get(game.id))
          }
          return {
            userId: memberA.userId,
            name: memberA.name,
            currentRank: memberA.position,
            gap,
            maxGain,
            canOvertake: maxGain > gap,
            canReach: maxGain >= gap,
          }
        })

      const definitivelyAhead = opponents.filter(o => o.gap > 0 && !o.canOvertake).length
      const bestPossibleRank = definitivelyAhead + 1

      const { predByGameId: _, ...memberPublic } = memberB
      return {
        ...memberPublic,
        maxAdditionalPoints: maxPossibleForMember(memberB.predByGameId),
        bestPossibleRank,
        opponents,
      }
    })

    const hasOdds = remainingGames.some(g => g.prob1 !== null)

    let podiumOddsMap: Map<string, [number, number, number]> | null = null

    try {
      const SIMULATIONS = 10_000

      const SCORE_DIST_WIN: Array<[number, number, number]> = [
        [1,0,0.28],[2,0,0.16],[2,1,0.22],[3,0,0.09],[3,1,0.12],[3,2,0.05],[4,0,0.04],[4,1,0.04],
      ]
      const SCORE_DIST_DRAW: Array<[number, number, number]> = [
        [0,0,0.24],[1,1,0.45],[2,2,0.22],[3,3,0.06],[4,4,0.03],
      ]

      function pickWeighted(dist: Array<[number, number, number]>): [number, number] {
        const r = Math.random()
        let acc = 0
        for (const [s1, s2, w] of dist) {
          acc += w
          if (r <= acc) return [s1, s2]
        }
        const last = dist[dist.length - 1]
        return [last[0], last[1]]
      }

      function simulateGame(p1: number, px: number): [number, number] {
        const r = Math.random()
        if (r < p1) return pickWeighted(SCORE_DIST_WIN)
        if (r < p1 + px) return pickWeighted(SCORE_DIST_DRAW)
        const [s2, s1] = pickWeighted(SCORE_DIST_WIN)
        return [s1, s2]
      }

      function scoreForPrediction(
        pred: { score1: number; score2: number } | undefined,
        ss1: number,
        ss2: number
      ): number {
        if (!pred) return 0
        if (pred.score1 === ss1 && pred.score2 === ss2) return 3
        const predWinner = pred.score1 > pred.score2 ? 1 : pred.score1 < pred.score2 ? 2 : 0
        const simWinner = ss1 > ss2 ? 1 : ss1 < ss2 ? 2 : 0
        return predWinner === simWinner ? 1 : 0
      }

      const counts = new Map<string, [number, number, number]>(
        rankedList.map(m => [m.userId, [0, 0, 0]])
      )

      if (remainingGames.length > 0) {
        for (let sim = 0; sim < SIMULATIONS; sim++) {
          const gained = new Map<string, number>()
          const exact = new Map<string, number>()

          for (const game of remainingGames) {
            const [ss1, ss2] = simulateGame(game.prob1 ?? 0.38, game.probX ?? 0.27)
            for (const member of rankedList) {
              const pts = scoreForPrediction(member.predByGameId.get(game.id), ss1, ss2)
              gained.set(member.userId, (gained.get(member.userId) ?? 0) + pts)
              if (pts === 3) exact.set(member.userId, (exact.get(member.userId) ?? 0) + 1)
            }
          }

          [...rankedList]
            .map(m => ({
              userId: m.userId,
              total: m.currentPoints + (gained.get(m.userId) ?? 0),
              exact: m.exactScores + (exact.get(m.userId) ?? 0),
            }))
            .sort((a, b) => b.total !== a.total ? b.total - a.total : b.exact - a.exact)
            .forEach((entry, idx) => {
              if (idx < 3) counts.get(entry.userId)![idx]++
            })
        }
      }

      podiumOddsMap = counts
    } catch (_err) {
      // simulação opcional — não impede a resposta principal
    }

    const round1 = (n: number) => Math.round(n * 1000) / 10

    const resultsWithPodium = results.map((member) => {
      const c = podiumOddsMap?.get(member.userId)
      return {
        ...member,
        podiumOdds: c
          ? { first: round1(c[0] / 10_000), second: round1(c[1] / 10_000), third: round1(c[2] / 10_000), top3: round1((c[0] + c[1] + c[2]) / 10_000) }
          : null,
      }
    })

    return {
      phase: resolvedPhase,
      remainingGamesCount: remainingGames.length,
      hasOdds,
      members: resultsWithPodium,
    }
  })
}
