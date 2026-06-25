import { PrismaClient } from '@prisma/client'

interface BracketRule {
  from: number
  to: number
  field: 'team1' | 'team2'
  useLoser?: boolean
}

const BRACKET_MAP: BracketRule[] = [
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

export async function advanceBracket(
  prisma: PrismaClient,
  gameNumber: number,
  team1: string,
  team2: string,
  score1: number,
  score2: number,
): Promise<void> {
  const rules = BRACKET_MAP.filter(r => r.from === gameNumber)
  if (rules.length === 0) return

  const winner = score1 > score2 ? team1 : team2
  const loser = score1 > score2 ? team2 : team1

  for (const rule of rules) {
    const advancing = rule.useLoser ? loser : winner

    const target = await prisma.game.findUnique({ where: { number: rule.to } })
    if (!target || target.score1 !== null) continue
    if (target[rule.field] === advancing) continue

    await prisma.game.update({
      where: { id: target.id },
      data: { [rule.field]: advancing },
    })
  }
}

interface GroupStanding {
  team: string
  pts: number
  gd: number
  gf: number
}

function computeGroupStandings(games: { team1: string; team2: string; score1: number | null; score2: number | null }[]): GroupStanding[] {
  const standings = new Map<string, GroupStanding>()

  const ensureTeam = (team: string) => {
    if (!standings.has(team)) standings.set(team, { team, pts: 0, gd: 0, gf: 0 })
  }

  for (const game of games) {
    ensureTeam(game.team1)
    ensureTeam(game.team2)

    if (game.score1 === null || game.score2 === null) continue

    const t1 = standings.get(game.team1)!
    const t2 = standings.get(game.team2)!

    t1.gf += game.score1
    t1.gd += game.score1 - game.score2
    t2.gf += game.score2
    t2.gd += game.score2 - game.score1

    if (game.score1 > game.score2) {
      t1.pts += 3
    } else if (game.score1 < game.score2) {
      t2.pts += 3
    } else {
      t1.pts += 1
      t2.pts += 1
    }
  }

  return [...standings.values()].sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf)
}

export async function resolveR32Teams(prisma: PrismaClient): Promise<number> {
  const groupGames = await prisma.game.findMany({
    where: { group: { in: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] } },
  })

  const gamesByGroup = new Map<string, typeof groupGames>()
  for (const game of groupGames) {
    const bucket = gamesByGroup.get(game.group)
    if (bucket) bucket.push(game)
    else gamesByGroup.set(game.group, [game])
  }

  const standingsByGroup = new Map<string, GroupStanding[]>()
  for (const [group, games] of gamesByGroup) {
    standingsByGroup.set(group, computeGroupStandings(games))
  }

  const r32Games = await prisma.game.findMany({
    where: { number: { gte: 73, lte: 88 }, score1: null },
  })

  let updatedCount = 0
  const placeholderPattern = /^(\d+)º Grupo ([A-L])$/
  const thirdPlacePattern = /^3º \(([A-L/]+)\)$/

  for (const game of r32Games) {
    const updates: Partial<{ team1: string; team2: string }> = {}

    for (const field of ['team1', 'team2'] as const) {
      const value = game[field]
      const simpleMatch = value.match(placeholderPattern)

      if (simpleMatch) {
        const position = parseInt(simpleMatch[1]) - 1
        const group = simpleMatch[2]
        const standings = standingsByGroup.get(group)
        if (standings && standings[position]) {
          updates[field] = standings[position].team
        }
        continue
      }

      const thirdMatch = value.match(thirdPlacePattern)
      if (thirdMatch) {
        const groups = thirdMatch[1].split('/')
        const allGroupsFinished = groups.every(g => {
          const games = gamesByGroup.get(g)
          return games && games.every(gg => gg.score1 !== null)
        })

        if (!allGroupsFinished) continue

        const thirdPlaceTeams: GroupStanding[] = []
        for (const g of groups) {
          const standings = standingsByGroup.get(g)
          if (standings && standings[2]) {
            thirdPlaceTeams.push(standings[2])
          }
        }

        thirdPlaceTeams.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf)
        if (thirdPlaceTeams[0]) {
          updates[field] = thirdPlaceTeams[0].team
        }
      }
    }

    if (Object.keys(updates).length === 0) continue

    await prisma.game.update({
      where: { id: game.id },
      data: updates,
    })
    updatedCount++
  }

  return updatedCount
}
