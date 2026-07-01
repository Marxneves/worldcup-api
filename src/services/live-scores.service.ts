import { PrismaClient } from '@prisma/client'
import { recalculatePoints } from './scoring.service'
import { advanceBracket } from './bracket.service'

interface EspnCompetitor {
  homeAway: 'home' | 'away'
  score: string
  shootoutScore?: number
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

// Duração máxima considerada "ainda em andamento" a partir do chute inicial real.
// Jogos do mata-mata podem ir a prorrogação + pênaltis (90 + 15 + 30 + intervalo + pênaltis
// facilmente passa de 2h) — por isso têm uma janela maior que os da fase de grupos.
const GROUP_STAGE_MAX_DURATION_MS = 2.5 * 60 * 60 * 1000
const KNOCKOUT_MAX_DURATION_MS = 4 * 60 * 60 * 1000

// Localiza a competição da ESPN correspondente ao jogo pelas seleções envolvidas,
// não pelo horário agendado — um atraso de início (chuva, transmissão etc.) faz a ESPN
// reportar um horário de início diferente do `matchDate` gravado no banco, e casar por
// minuto exato faria o jogo nunca ser encontrado.
function findEspnCompetition(game: { team1: string; team2: string }, competitions: EspnCompetition[]): EspnCompetition | undefined {
  const abbr1 = TEAM_ABBR[game.team1]
  const abbr2 = TEAM_ABBR[game.team2]
  if (!abbr1 || !abbr2) return undefined

  return competitions.find(c => {
    const abbrs = c.competitors.map(p => p.team.abbreviation)
    return abbrs.includes(abbr1) && abbrs.includes(abbr2)
  })
}

export async function syncLiveResults(prisma: PrismaClient): Promise<LiveScore[]> {
  if (espnCache && Date.now() < espnCache.expiresAt) {
    return espnCache.liveScores
  }

  const now = new Date()

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
  ).flat().filter(c => c.status.type.state !== 'pre')

  const liveScores: LiveScore[] = []

  for (const game of pendingGames) {
    const competition = findEspnCompetition(game, allCompetitions)
    if (!competition) continue

    const home = competition.competitors.find(c => c.homeAway === 'home')
    const away = competition.competitors.find(c => c.homeAway === 'away')
    if (!home || !away) continue

    const score1 = parseInt(home.score)
    const score2 = parseInt(away.score)
    if (isNaN(score1) || isNaN(score2)) continue

    const isFinished = competition.status.type.state === 'post'

    if (isFinished) {
      const penalty1 = home.shootoutScore ?? null
      const penalty2 = away.shootoutScore ?? null

      await prisma.game.update({
        where: { id: game.id },
        data: { score1, score2, penalty1, penalty2, resultFetched: true },
      })
      await recalculatePoints(prisma, game.id, score1, score2)
      if (game.number >= 73) {
        await advanceBracket(prisma, game.number, game.team1, game.team2, score1, score2, penalty1, penalty2)
      }
      continue
    }

    const actualKickoff = new Date(competition.date)
    const maxDuration = game.number >= 73 ? KNOCKOUT_MAX_DURATION_MS : GROUP_STAGE_MAX_DURATION_MS
    if (now.getTime() - actualKickoff.getTime() > maxDuration) continue

    liveScores.push({
      gameNumber: game.number,
      score1,
      score2,
      timeElapsed: competition.status.displayClock,
    })
  }

  espnCache = { liveScores, expiresAt: Date.now() + 60_000 }
  return liveScores
}

export function clearLiveCache(): void {
  espnCache = null
}
