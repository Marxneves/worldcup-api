import { PrismaClient } from '@prisma/client'
import { recalculatePoints } from './scoring.service'

interface WorldCup26Game {
  id: string
  home_score: string
  away_score: string
  finished: string
  time_elapsed: string
}

export interface LiveScore {
  gameNumber: number
  score1: number
  score2: number
  timeElapsed: string
}

async function fetchFromWorldCup26(): Promise<WorldCup26Game[]> {
  const response = await fetch('https://worldcup26.ir/get/games', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BolaoBot/1.0)' },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = await response.json() as { games: WorldCup26Game[] }
  return data.games
}

export async function syncLiveResults(prisma: PrismaClient): Promise<LiveScore[]> {
  const now = new Date()
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)

  const pendingGames = await prisma.game.findMany({
    where: {
      matchDate: { lte: now },
      score1: null,
    },
    orderBy: { number: 'asc' },
  })

  if (pendingGames.length === 0) return []

  const apiGames = await fetchFromWorldCup26()
  const apiByNumber = new Map(apiGames.map(g => [parseInt(g.id), g]))

  const liveScores: LiveScore[] = []

  for (const game of pendingGames) {
    const apiGame = apiByNumber.get(game.number)
    if (!apiGame) continue

    const score1 = parseInt(apiGame.home_score)
    const score2 = parseInt(apiGame.away_score)
    if (isNaN(score1) || isNaN(score2)) continue

    const isFinished = apiGame.finished === 'TRUE'

    if (isFinished) {
      await prisma.game.update({
        where: { id: game.id },
        data: { score1, score2, resultFetched: true },
      })
      await recalculatePoints(prisma, game.id, score1, score2)
    } else if (game.matchDate >= twoHoursAgo) {
      liveScores.push({
        gameNumber: game.number,
        score1,
        score2,
        timeElapsed: apiGame.time_elapsed,
      })
    }
  }

  return liveScores
}
