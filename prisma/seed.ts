import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const games = [
  { number: 1,  group: 'A', matchDate: '2026-06-11T19:00:00Z', team1: 'México',               team2: 'África do Sul' },
  { number: 2,  group: 'A', matchDate: '2026-06-12T02:00:00Z', team1: 'Coreia do Sul',         team2: 'Tchéquia' },
  { number: 3,  group: 'B', matchDate: '2026-06-12T19:00:00Z', team1: 'Canadá',               team2: 'Bósnia e Herzegovina' },
  { number: 4,  group: 'D', matchDate: '2026-06-13T01:00:00Z', team1: 'Estados Unidos',        team2: 'Paraguai' },
  { number: 5,  group: 'B', matchDate: '2026-06-13T19:00:00Z', team1: 'Catar',                team2: 'Suíça' },
  { number: 6,  group: 'C', matchDate: '2026-06-13T22:00:00Z', team1: 'Brasil',               team2: 'Marrocos' },
  { number: 7,  group: 'C', matchDate: '2026-06-14T01:00:00Z', team1: 'Haiti',                team2: 'Escócia' },
  { number: 8,  group: 'D', matchDate: '2026-06-14T04:00:00Z', team1: 'Austrália',            team2: 'Turquia' },
  { number: 9,  group: 'E', matchDate: '2026-06-14T17:00:00Z', team1: 'Alemanha',             team2: 'Curaçao' },
  { number: 10, group: 'F', matchDate: '2026-06-14T20:00:00Z', team1: 'Holanda',              team2: 'Japão' },
  { number: 11, group: 'E', matchDate: '2026-06-14T23:00:00Z', team1: 'Costa do Marfim',      team2: 'Equador' },
  { number: 12, group: 'F', matchDate: '2026-06-15T02:00:00Z', team1: 'Suécia',               team2: 'Tunísia' },
  { number: 13, group: 'H', matchDate: '2026-06-15T16:00:00Z', team1: 'Espanha',              team2: 'Cabo Verde' },
  { number: 14, group: 'G', matchDate: '2026-06-15T19:00:00Z', team1: 'Bélgica',              team2: 'Egito' },
  { number: 15, group: 'H', matchDate: '2026-06-15T22:00:00Z', team1: 'Arábia Saudita',       team2: 'Uruguai' },
  { number: 16, group: 'G', matchDate: '2026-06-16T01:00:00Z', team1: 'Irã',                  team2: 'Nova Zelândia' },
  { number: 17, group: 'I', matchDate: '2026-06-16T19:00:00Z', team1: 'França',               team2: 'Senegal' },
  { number: 18, group: 'I', matchDate: '2026-06-16T22:00:00Z', team1: 'Iraque',               team2: 'Noruega' },
  { number: 19, group: 'J', matchDate: '2026-06-17T01:00:00Z', team1: 'Argentina',            team2: 'Argélia' },
  { number: 20, group: 'J', matchDate: '2026-06-17T04:00:00Z', team1: 'Áustria',              team2: 'Jordânia' },
  { number: 21, group: 'K', matchDate: '2026-06-17T17:00:00Z', team1: 'Portugal',             team2: 'RD Congo' },
  { number: 22, group: 'L', matchDate: '2026-06-17T20:00:00Z', team1: 'Inglaterra',           team2: 'Croácia' },
  { number: 23, group: 'L', matchDate: '2026-06-17T23:00:00Z', team1: 'Gana',                 team2: 'Panamá' },
  { number: 24, group: 'K', matchDate: '2026-06-18T02:00:00Z', team1: 'Uzbequistão',          team2: 'Colômbia' },
  { number: 25, group: 'A', matchDate: '2026-06-18T16:00:00Z', team1: 'Tchéquia',             team2: 'África do Sul' },
  { number: 26, group: 'B', matchDate: '2026-06-18T19:00:00Z', team1: 'Suíça',                team2: 'Bósnia e Herzegovina' },
  { number: 27, group: 'B', matchDate: '2026-06-18T22:00:00Z', team1: 'Canadá',               team2: 'Catar' },
  { number: 28, group: 'A', matchDate: '2026-06-19T01:00:00Z', team1: 'México',               team2: 'Coreia do Sul' },
  { number: 29, group: 'D', matchDate: '2026-06-19T19:00:00Z', team1: 'Estados Unidos',        team2: 'Austrália' },
  { number: 30, group: 'C', matchDate: '2026-06-19T22:00:00Z', team1: 'Escócia',              team2: 'Marrocos' },
  { number: 31, group: 'C', matchDate: '2026-06-20T00:30:00Z', team1: 'Brasil',               team2: 'Haiti' },
  { number: 32, group: 'D', matchDate: '2026-06-20T03:00:00Z', team1: 'Turquia',              team2: 'Paraguai' },
  { number: 33, group: 'F', matchDate: '2026-06-20T17:00:00Z', team1: 'Holanda',              team2: 'Suécia' },
  { number: 34, group: 'E', matchDate: '2026-06-20T20:00:00Z', team1: 'Alemanha',             team2: 'Costa do Marfim' },
  { number: 35, group: 'E', matchDate: '2026-06-21T00:00:00Z', team1: 'Equador',              team2: 'Curaçao' },
  { number: 36, group: 'F', matchDate: '2026-06-21T04:00:00Z', team1: 'Tunísia',              team2: 'Japão' },
  { number: 37, group: 'H', matchDate: '2026-06-21T16:00:00Z', team1: 'Espanha',              team2: 'Arábia Saudita' },
  { number: 38, group: 'G', matchDate: '2026-06-21T19:00:00Z', team1: 'Bélgica',              team2: 'Irã' },
  { number: 39, group: 'H', matchDate: '2026-06-21T22:00:00Z', team1: 'Uruguai',              team2: 'Cabo Verde' },
  { number: 40, group: 'G', matchDate: '2026-06-22T01:00:00Z', team1: 'Nova Zelândia',        team2: 'Egito' },
  { number: 41, group: 'J', matchDate: '2026-06-22T17:00:00Z', team1: 'Argentina',            team2: 'Áustria' },
  { number: 42, group: 'I', matchDate: '2026-06-22T21:00:00Z', team1: 'França',               team2: 'Iraque' },
  { number: 43, group: 'I', matchDate: '2026-06-23T00:00:00Z', team1: 'Noruega',              team2: 'Senegal' },
  { number: 44, group: 'J', matchDate: '2026-06-23T03:00:00Z', team1: 'Jordânia',             team2: 'Argélia' },
  { number: 45, group: 'K', matchDate: '2026-06-23T17:00:00Z', team1: 'Portugal',             team2: 'Uzbequistão' },
  { number: 46, group: 'L', matchDate: '2026-06-23T20:00:00Z', team1: 'Inglaterra',           team2: 'Gana' },
  { number: 47, group: 'L', matchDate: '2026-06-23T23:00:00Z', team1: 'Panamá',               team2: 'Croácia' },
  { number: 48, group: 'K', matchDate: '2026-06-24T02:00:00Z', team1: 'Colômbia',             team2: 'RD Congo' },
  { number: 49, group: 'B', matchDate: '2026-06-24T19:00:00Z', team1: 'Suíça',                team2: 'Canadá' },
  { number: 50, group: 'B', matchDate: '2026-06-24T19:00:00Z', team1: 'Bósnia e Herzegovina', team2: 'Catar' },
  { number: 51, group: 'C', matchDate: '2026-06-24T22:00:00Z', team1: 'Marrocos',             team2: 'Haiti' },
  { number: 52, group: 'C', matchDate: '2026-06-24T22:00:00Z', team1: 'Escócia',              team2: 'Brasil' },
  { number: 53, group: 'A', matchDate: '2026-06-25T01:00:00Z', team1: 'África do Sul',        team2: 'Coreia do Sul' },
  { number: 54, group: 'A', matchDate: '2026-06-25T01:00:00Z', team1: 'Tchéquia',             team2: 'México' },
  { number: 55, group: 'E', matchDate: '2026-06-25T20:00:00Z', team1: 'Curaçao',              team2: 'Costa do Marfim' },
  { number: 56, group: 'E', matchDate: '2026-06-25T20:00:00Z', team1: 'Equador',              team2: 'Alemanha' },
  { number: 57, group: 'F', matchDate: '2026-06-25T23:00:00Z', team1: 'Tunísia',              team2: 'Holanda' },
  { number: 58, group: 'F', matchDate: '2026-06-25T23:00:00Z', team1: 'Japão',                team2: 'Suécia' },
  { number: 59, group: 'D', matchDate: '2026-06-26T02:00:00Z', team1: 'Turquia',              team2: 'Estados Unidos' },
  { number: 60, group: 'D', matchDate: '2026-06-26T02:00:00Z', team1: 'Paraguai',             team2: 'Austrália' },
  { number: 61, group: 'I', matchDate: '2026-06-26T19:00:00Z', team1: 'Noruega',              team2: 'França' },
  { number: 62, group: 'I', matchDate: '2026-06-26T19:00:00Z', team1: 'Senegal',              team2: 'Iraque' },
  { number: 63, group: 'H', matchDate: '2026-06-27T00:00:00Z', team1: 'Cabo Verde',           team2: 'Arábia Saudita' },
  { number: 64, group: 'H', matchDate: '2026-06-27T00:00:00Z', team1: 'Uruguai',              team2: 'Espanha' },
  { number: 65, group: 'G', matchDate: '2026-06-27T03:00:00Z', team1: 'Nova Zelândia',        team2: 'Bélgica' },
  { number: 66, group: 'G', matchDate: '2026-06-27T03:00:00Z', team1: 'Egito',                team2: 'Irã' },
  { number: 67, group: 'L', matchDate: '2026-06-27T21:00:00Z', team1: 'Panamá',               team2: 'Inglaterra' },
  { number: 68, group: 'L', matchDate: '2026-06-27T21:00:00Z', team1: 'Croácia',              team2: 'Gana' },
  { number: 69, group: 'K', matchDate: '2026-06-27T23:30:00Z', team1: 'Colômbia',             team2: 'Portugal' },
  { number: 70, group: 'K', matchDate: '2026-06-27T23:30:00Z', team1: 'RD Congo',             team2: 'Uzbequistão' },
  { number: 71, group: 'J', matchDate: '2026-06-28T02:00:00Z', team1: 'Argélia',              team2: 'Áustria' },
  { number: 72, group: 'J', matchDate: '2026-06-28T02:00:00Z', team1: 'Jordânia',             team2: 'Argentina' },

  // ─── 16 avos de final ─────────────────────────────────────────────────────
  { number: 73, group: 'R32', matchDate: '2026-06-28T19:00:00Z', team1: 'África do Sul',           team2: 'Canadá' },
  { number: 74, group: 'R32', matchDate: '2026-06-29T20:30:00Z', team1: 'Alemanha',                team2: 'Paraguai' },
  { number: 75, group: 'R32', matchDate: '2026-06-30T01:00:00Z', team1: 'Holanda',                 team2: 'Marrocos' },
  { number: 76, group: 'R32', matchDate: '2026-06-29T17:00:00Z', team1: 'Brasil',                  team2: 'Japão' },
  { number: 77, group: 'R32', matchDate: '2026-06-30T21:00:00Z', team1: 'França',                  team2: 'Suécia' },
  { number: 78, group: 'R32', matchDate: '2026-06-30T17:00:00Z', team1: 'Costa do Marfim',         team2: 'Noruega' },
  { number: 79, group: 'R32', matchDate: '2026-07-01T01:00:00Z', team1: 'México',                  team2: 'Equador' },
  { number: 80, group: 'R32', matchDate: '2026-07-01T16:00:00Z', team1: 'Inglaterra',              team2: 'RD Congo' },
  { number: 81, group: 'R32', matchDate: '2026-07-02T00:00:00Z', team1: 'Estados Unidos',          team2: 'Bósnia e Herzegovina' },
  { number: 82, group: 'R32', matchDate: '2026-07-01T20:00:00Z', team1: 'Bélgica',                 team2: 'Senegal' },
  { number: 83, group: 'R32', matchDate: '2026-07-02T23:00:00Z', team1: 'Portugal',                team2: 'Croácia' },
  { number: 84, group: 'R32', matchDate: '2026-07-02T19:00:00Z', team1: 'Espanha',                 team2: 'Áustria' },
  { number: 85, group: 'R32', matchDate: '2026-07-03T03:00:00Z', team1: 'Suíça',                   team2: 'Argélia' },
  { number: 86, group: 'R32', matchDate: '2026-07-03T22:00:00Z', team1: 'Argentina',               team2: 'Cabo Verde' },
  { number: 87, group: 'R32', matchDate: '2026-07-04T01:30:00Z', team1: 'Colômbia',                team2: 'Gana' },
  { number: 88, group: 'R32', matchDate: '2026-07-03T18:00:00Z', team1: 'Austrália',               team2: 'Egito' },

  // ─── Oitavas de final ─────────────────────────────────────────────────────
  { number: 89,  group: 'R16', matchDate: '2026-07-04T21:00:00Z', team1: 'Venc. J74',  team2: 'Venc. J77' },
  { number: 90,  group: 'R16', matchDate: '2026-07-04T17:00:00Z', team1: 'Venc. J73',  team2: 'Venc. J75' },
  { number: 91,  group: 'R16', matchDate: '2026-07-05T20:00:00Z', team1: 'Venc. J76',  team2: 'Venc. J78' },
  { number: 92,  group: 'R16', matchDate: '2026-07-06T00:00:00Z', team1: 'Venc. J79',  team2: 'Venc. J80' },
  { number: 93,  group: 'R16', matchDate: '2026-07-06T19:00:00Z', team1: 'Venc. J83',  team2: 'Venc. J84' },
  { number: 94,  group: 'R16', matchDate: '2026-07-07T00:00:00Z', team1: 'Venc. J81',  team2: 'Venc. J82' },
  { number: 95,  group: 'R16', matchDate: '2026-07-07T16:00:00Z', team1: 'Venc. J86',  team2: 'Venc. J88' },
  { number: 96,  group: 'R16', matchDate: '2026-07-07T20:00:00Z', team1: 'Venc. J85',  team2: 'Venc. J87' },

  // ─── Quartas de final ─────────────────────────────────────────────────────
  { number: 97,  group: 'QF',  matchDate: '2026-07-09T20:00:00Z', team1: 'Venc. J89',  team2: 'Venc. J90' },
  { number: 98,  group: 'QF',  matchDate: '2026-07-10T19:00:00Z', team1: 'Venc. J93',  team2: 'Venc. J94' },
  { number: 99,  group: 'QF',  matchDate: '2026-07-11T21:00:00Z', team1: 'Venc. J91',  team2: 'Venc. J92' },
  { number: 100, group: 'QF',  matchDate: '2026-07-12T01:00:00Z', team1: 'Venc. J95',  team2: 'Venc. J96' },

  // ─── Semifinais ───────────────────────────────────────────────────────────
  { number: 101, group: 'SF',  matchDate: '2026-07-14T19:00:00Z', team1: 'Venc. J97',  team2: 'Venc. J98' },
  { number: 102, group: 'SF',  matchDate: '2026-07-15T19:00:00Z', team1: 'Venc. J99',  team2: 'Venc. J100' },

  // ─── Terceiro lugar / Final ────────────────────────────────────────────────
  { number: 103, group: 'TP',  matchDate: '2026-07-18T21:00:00Z', team1: 'Perd. J101', team2: 'Perd. J102' },
  { number: 104, group: 'FIN', matchDate: '2026-07-19T19:00:00Z', team1: 'Venc. J101', team2: 'Venc. J102' },
]

async function main() {
  console.log('Seeding games...')

  for (const game of games) {
    await prisma.game.upsert({
      where: { number: game.number },
      update: { matchDate: new Date(game.matchDate) },
      create: {
        number: game.number,
        group: game.group,
        matchDate: new Date(game.matchDate),
        team1: game.team1,
        team2: game.team2,
      },
    })
  }

  console.log(`Seeded ${games.length} games.`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
