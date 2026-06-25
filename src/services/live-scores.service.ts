import { PrismaClient } from '@prisma/client'
import { recalculatePoints } from './scoring.service'
import { advanceBracket } from './bracket.service'

interface EspnCompetitor {
  homeAway: 'home' | 'away'
  score: string
  team: { displayName: string; abbreviation: string }
}

// Abreviações FIFA — espelho do TEAM_ABBR do frontend para match em jogos simultâneos
const TEAM_ABBR: Record<string, string> = {
  'México': 'MEX', 'África do Sul': 'RSA', 'Coreia do Sul': 'KOR', 'Tchéquia': 'CZE',
  'Canadá': 'CAN', 'Bósnia e Herzegovina': 'BIH', 'Estados Unidos': 'USA', 'Paraguai': 'PAR',
  'Catar': 'QAT', 'Suíça': 'SUI', 'Brasil': 'BRA', 'Marrocos': 'MAR',
  'Haiti': 'HAI', 'Escócia': 'SCO', 'Austrália': 'AUS', 'Turquia': 'TUR',
  'Alemanha': 'GER', 'Curaçao': 'CUW', 'Holanda': 'NED', 'Japão': 'JPN',
  'Costa do Marfim': 'CIV', 'Equador': 'ECU', 'Suécia': 'SWE', 'Tunísia': 'TUN',
  'Espanha': 'ESP', 'Cabo Verde': 'CPV', 'Bélgica': 'BEL', 'Egito': 'EGY',
  'Arábia Saudita': 'KSA', 'Uruguai': 'URU', 'Irã': 'IRN', 'Nova Zelândia': 'NZL',
  'França': 'FRA', 'Senegal': 'SEN', 'Iraque': 'IRQ', 'Noruega': 'NOR',
  'Argentina': 'ARG', 'Argélia': 'ALG', 'Áustria': 'AUT', 'Jordânia': 'JOR',
  'Portugal': 'POR', 'RD Congo': 'COD', 'Inglaterra': 'ENG', 'Croácia': 'CRO',
  'Gana': 'GHA', 'Panamá': 'PAN', 'Uzbequistão': 'UZB', 'Colômbia': 'COL',
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

// ESPN classifica jogos pelo horário local do venue (UTC-4 a UTC-7).
// Para jogos madrugada UTC (ex: 04:00 UTC = 00:00 Eastern), a ESPN pode usar
// a data UTC ou a data UTC-7 — geramos ambas para cobrir os dois casos.
function toEspnDateKeys(utcDate: Date): string[] {
  const utcKey = utcDate.toISOString().slice(0, 10).replace(/-/g, '')
  const localish = new Date(utcDate.getTime() - 7 * 60 * 60 * 1000)
  const localKey = localish.toISOString().slice(0, 10).replace(/-/g, '')
  return utcKey === localKey ? [utcKey] : [utcKey, localKey]
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
  const espnDateKeys = new Set(pendingGames.flatMap(g => toEspnDateKeys(g.matchDate)))
  const allCompetitions = (
    await Promise.all([...espnDateKeys].map(fetchFromEspnForDate))
  ).flat()

  // Indexa pelo minuto UTC — guarda array para suportar jogos simultâneos
  const espnByMinute = new Map<string, EspnCompetition[]>()
  for (const c of allCompetitions) {
    if (c.status.type.state === 'pre') continue
    const key = toMinuteKey(c.date)
    const bucket = espnByMinute.get(key)
    if (bucket) bucket.push(c)
    else espnByMinute.set(key, [c])
  }

  const liveScores: LiveScore[] = []

  for (const game of pendingGames) {
    const key = toMinuteKey(game.matchDate.toISOString())
    const bucket = espnByMinute.get(key)
    if (!bucket) continue

    const abbr1 = TEAM_ABBR[game.team1]
    const abbr2 = TEAM_ABBR[game.team2]

    // Se há mais de uma competição no mesmo horário, filtra pela abreviação dos times
    const competition = bucket.length === 1
      ? bucket[0]
      : bucket.find(c =>
          c.competitors.some(p => p.team.abbreviation === abbr1 || p.team.abbreviation === abbr2)
        ) ?? bucket[0]

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
      if (game.number >= 73) {
        await advanceBracket(prisma, game.number, game.team1, game.team2, score1, score2)
      }
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
