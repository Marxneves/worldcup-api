import { PrismaClient } from '@prisma/client'
import { recalculatePoints } from './scoring.service'

interface EspnCompetitor {
  homeAway: 'home' | 'away'
  score: string
  team: { displayName: string }
}

interface EspnCompetition {
  date: string
  competitors: EspnCompetitor[]
  status: {
    displayClock: string
    type: { state: 'pre' | 'in' | 'post'; name: string }
  }
}

interface EspnEvent {
  competitions: EspnCompetition[]
}

export interface LiveScore {
  gameNumber: number
  score1: number
  score2: number
  timeElapsed: string
}

// Cache em memória de 1 minuto — evita chamar a ESPN a cada requisição
let espnCache: { liveScores: LiveScore[]; expiresAt: number } | null = null

// ESPN classifica jogos pelo horário local americano (UTC-4 a UTC-7).
// Um jogo às 02:00 UTC é "ontem" no horário US. Subtraindo 7h (UTC-7, offset máximo)
// obtemos a data local mais conservadora para consultar o scoreboard correto.
function toEspnDateKey(utcDate: Date): string {
  const localish = new Date(utcDate.getTime() - 7 * 60 * 60 * 1000)
  return localish.toISOString().slice(0, 10).replace(/-/g, '')
}

async function fetchFromEspnForDate(dateKey: string): Promise<EspnCompetition[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${dateKey}`
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`ESPN HTTP ${response.status}`)
  const data = await response.json() as { events: EspnEvent[] }
  return data.events.map(e => e.competitions[0])
}

// Normaliza para "YYYY-MM-DDTHH:MM" para comparação (ignora segundos e offset)
function toMinuteKey(dateStr: string): string {
  return new Date(dateStr).toISOString().slice(0, 16)
}

export async function syncLiveResults(prisma: PrismaClient): Promise<LiveScore[]> {
  if (espnCache && Date.now() < espnCache.expiresAt) {
    return espnCache.liveScores
  }

  const now = new Date()
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)

  const pendingGames = await prisma.game.findMany({
    where: { matchDate: { lte: now }, score1: null },
    orderBy: { number: 'asc' },
  })

  if (pendingGames.length === 0) {
    espnCache = { liveScores: [], expiresAt: Date.now() + 60_000 }
    return []
  }

  // Coleta as datas ESPN únicas necessárias para cobrir todos os jogos pendentes
  const espnDateKeys = new Set(pendingGames.map(g => toEspnDateKey(g.matchDate)))
  const allCompetitions = (
    await Promise.all([...espnDateKeys].map(fetchFromEspnForDate))
  ).flat()

  // Indexa pelo minuto UTC do início — bate exato com matchDate do banco
  const espnByMinute = new Map(
    allCompetitions
      .filter(c => c.status.type.state !== 'pre')
      .map(c => [toMinuteKey(c.date), c])
  )

  const liveScores: LiveScore[] = []

  for (const game of pendingGames) {
    const key = toMinuteKey(game.matchDate.toISOString())
    const competition = espnByMinute.get(key)
    if (!competition) continue

    const home = competition.competitors.find(c => c.homeAway === 'home')
    const away = competition.competitors.find(c => c.homeAway === 'away')
    if (!home || !away) continue

    const score1 = parseInt(home.score)
    const score2 = parseInt(away.score)
    if (isNaN(score1) || isNaN(score2)) continue

    const isFinished = competition.status.type.state === 'post'

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
        timeElapsed: competition.status.displayClock,
      })
    }
  }

  espnCache = { liveScores, expiresAt: Date.now() + 60_000 }
  return liveScores
}

export function clearLiveCache(): void {
  espnCache = null
}
