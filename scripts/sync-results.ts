import { PrismaClient } from '@prisma/client'
import { recalculatePoints } from '../src/services/scoring.service'

// ─── Tipos ESPN ───────────────────────────────────────────────────────────────

interface EspnCompetitor {
  homeAway: 'home' | 'away'
  score: string
  team: { displayName: string; abbreviation: string }
}

interface EspnCompetition {
  date: string
  competitors: EspnCompetitor[]
  status: { displayClock: string; type: { state: 'pre' | 'in' | 'post' } }
}

// Espelho do TEAM_ABBR do live-scores.service.ts
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

function toMinuteKey(dateStr: string): string {
  return new Date(dateStr).toISOString().slice(0, 16)
}

function toEspnDateKeys(utcDate: Date): string[] {
  const utcKey = utcDate.toISOString().slice(0, 10).replace(/-/g, '')
  const localish = new Date(utcDate.getTime() - 7 * 60 * 60 * 1000)
  const localKey = localish.toISOString().slice(0, 10).replace(/-/g, '')
  return utcKey === localKey ? [utcKey] : [utcKey, localKey]
}

async function fetchEspnForDate(dateKey: string): Promise<EspnCompetition[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${dateKey}`
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`ESPN HTTP ${response.status} para data ${dateKey}`)
  const data = await response.json() as { events: { competitions: EspnCompetition[] }[] }
  return data.events.map(e => e.competitions[0])
}

// ─── Script principal ─────────────────────────────────────────────────────────

const prisma = new PrismaClient()

async function run() {
  const now = new Date()

  const pendingGames = await prisma.game.findMany({
    where: { matchDate: { lte: now }, score1: null },
    orderBy: { number: 'asc' },
  })

  if (pendingGames.length === 0) {
    console.log('Nenhum jogo pendente encontrado. Todos os jogos ja tem resultado.')
    return
  }

  console.log(`${pendingGames.length} jogo(s) pendente(s). Buscando resultados na ESPN...`)

  const espnDateKeys = new Set(pendingGames.flatMap(g => toEspnDateKeys(g.matchDate)))
  console.log(`Consultando ${espnDateKeys.size} data(s): ${[...espnDateKeys].join(', ')}`)

  const allCompetitions = (
    await Promise.all([...espnDateKeys].map(fetchEspnForDate))
  ).flat()

  const espnByMinute = new Map<string, EspnCompetition[]>()
  for (const competition of allCompetitions) {
    if (competition.status.type.state === 'pre') continue
    const key = toMinuteKey(competition.date)
    const bucket = espnByMinute.get(key)
    if (bucket) bucket.push(competition)
    else espnByMinute.set(key, [competition])
  }

  let updated = 0
  let notFound = 0

  for (const game of pendingGames) {
    const key = toMinuteKey(game.matchDate.toISOString())
    const bucket = espnByMinute.get(key)

    if (!bucket) {
      console.log(`  [NAO ENCONTRADO] Jogo ${game.number}: ${game.team1} x ${game.team2} (${key})`)
      notFound++
      continue
    }

    const abbr1 = TEAM_ABBR[game.team1]
    const abbr2 = TEAM_ABBR[game.team2]

    const competition = bucket.length === 1
      ? bucket[0]
      : bucket.find(c =>
          c.competitors.some(p => p.team.abbreviation === abbr1 || p.team.abbreviation === abbr2)
        ) ?? bucket[0]

    if (competition.status.type.state !== 'post') {
      console.log(`  [AO VIVO / NAO ENCERRADO] Jogo ${game.number}: ${game.team1} x ${game.team2}`)
      notFound++
      continue
    }

    const home = competition.competitors.find(c => c.homeAway === 'home')
    const away = competition.competitors.find(c => c.homeAway === 'away')
    if (!home || !away) {
      console.log(`  [ERRO] Jogo ${game.number}: competidores invalidos na ESPN`)
      notFound++
      continue
    }

    const score1 = parseInt(home.score)
    const score2 = parseInt(away.score)
    if (isNaN(score1) || isNaN(score2)) {
      console.log(`  [ERRO] Jogo ${game.number}: placar invalido (${home.score}-${away.score})`)
      notFound++
      continue
    }

    await prisma.game.update({
      where: { id: game.id },
      data: { score1, score2, resultFetched: true },
    })
    await recalculatePoints(prisma, game.id, score1, score2)

    console.log(`  [OK] Jogo ${game.number}: ${game.team1} ${score1} x ${score2} ${game.team2}`)
    updated++
  }

  console.log(`\nConcluido: ${updated} atualizado(s), ${notFound} nao encontrado(s).`)
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
