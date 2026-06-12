import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

if (process.env.NODE_ENV === 'production') {
  console.error('seed-dev nao pode rodar em producao.')
  process.exit(1)
}

const prisma = new PrismaClient()
const POOL_CODE = '39VZ4I'

// Placares reais usados para calcular pontos
const SCORED_GAMES: Record<number, [number, number]> = {
  1: [2, 1], 2: [1, 1], 3: [3, 0], 4: [1, 0], 5: [0, 2],
  6: [2, 0], 7: [1, 2], 8: [1, 1], 9: [4, 0], 10: [2, 1],
}

type PredMap = Record<number, [number, number]>

// Palpites para os 10 jogos com placar — pontuacoes projetadas:
//
//  ana:     30pts, 10ex  — acerta tudo
//  bruno:   10pts,  0ex  — acerta resultado mas nunca o placar
//  carla:    0pts,  0ex  — erra tudo
//  diego:   20pts,  5ex  — exatos em G1-G5, resultado em G6-G10  <- EMPATA c/ elena
//  elena:   20pts,  5ex  — idem diego                            <- EMPATA c/ diego
//  fabio:   18pts,  6ex  — exatos em G1-G6, erra G7-G10         <- mesmos pts que gabi, MAS MAIS EXATOS -> nao empata
//  gabi:    18pts,  5ex  — exatos em G1-G5, resultado em G6-G8   <- mesmos pts que fabio, menos exatos -> nao empata
//  heitor:   8pts,  2ex  — exatos em G1-G2, resultado em G3-G4   <- EMPATA c/ isabela
//  isabela:  8pts,  2ex  — idem heitor                           <- EMPATA c/ heitor
//  joao:     3pts,  1ex  — exato em G1, erra o resto             <- EMPATA c/ karen
//  karen:    3pts,  1ex  — idem joao                             <- EMPATA c/ joao
//
// Ranking esperado:
//   1  Ana                 30pts 10ex  (sozinha)
//   2  Diego               20pts  5ex  (EMPATE — Elena fica com "—")
//   2  Elena               20pts  5ex
//   4  Fabio               18pts  6ex  (nao empata com Gabi — mais exatos)
//   5  Gabi                18pts  5ex  (mesmos pts que Fabio, menos exatos -> posicao diferente)
//   6  Bruno               10pts  0ex
//   7  Heitor               8pts  2ex  (EMPATE — Isabela fica com "—")
//   7  Isabela              8pts  2ex
//   9  Joao                 3pts  1ex  (EMPATE — Karen fica com "—")
//   9  Karen                3pts  1ex
//  11  Carla                0pts  0ex
const SCORED_PREDS: Record<string, PredMap> = {
  ana:     { 1:[2,1], 2:[1,1], 3:[3,0], 4:[1,0], 5:[0,2], 6:[2,0], 7:[1,2], 8:[1,1], 9:[4,0], 10:[2,1] },
  bruno:   { 1:[3,1], 2:[2,2], 3:[4,0], 4:[2,0], 5:[0,3], 6:[3,0], 7:[1,3], 8:[2,2], 9:[5,0], 10:[3,1] },
  carla:   { 1:[0,2], 2:[1,0], 3:[0,3], 4:[0,2], 5:[2,0], 6:[0,2], 7:[2,0], 8:[1,0], 9:[0,4], 10:[0,2] },
  diego:   { 1:[2,1], 2:[1,1], 3:[3,0], 4:[1,0], 5:[0,2], 6:[3,0], 7:[0,3], 8:[0,0], 9:[2,0], 10:[1,0] },
  elena:   { 1:[2,1], 2:[1,1], 3:[3,0], 4:[1,0], 5:[0,2], 6:[3,0], 7:[0,3], 8:[0,0], 9:[2,0], 10:[1,0] },
  // fabio: 6 exatos (G1-G6), erra G7-G10 = 6×3 = 18pts, 6ex
  fabio:   { 1:[2,1], 2:[1,1], 3:[3,0], 4:[1,0], 5:[0,2], 6:[2,0], 7:[2,0], 8:[2,0], 9:[0,3], 10:[0,2] },
  // gabi: 5 exatos (G1-G5), resultado G6-G8, erra G9-G10 = 5×3+3×1 = 18pts, 5ex
  gabi:    { 1:[2,1], 2:[1,1], 3:[3,0], 4:[1,0], 5:[0,2], 6:[3,0], 7:[0,3], 8:[0,0], 9:[0,3], 10:[0,2] },
  heitor:  { 1:[2,1], 2:[1,1], 3:[2,1], 4:[2,0], 5:[2,0], 6:[0,1], 7:[2,0], 8:[2,0], 9:[0,3], 10:[0,3] },
  isabela: { 1:[2,1], 2:[1,1], 3:[2,1], 4:[2,0], 5:[2,0], 6:[0,1], 7:[2,0], 8:[2,0], 9:[0,3], 10:[0,3] },
  joao:    { 1:[2,1], 2:[0,2], 3:[0,3], 4:[0,2], 5:[2,0], 6:[0,2], 7:[2,0], 8:[1,0], 9:[0,4], 10:[0,2] },
  karen:   { 1:[2,1], 2:[0,2], 3:[0,3], 4:[0,2], 5:[2,0], 6:[0,2], 7:[2,0], 8:[1,0], 9:[0,4], 10:[0,2] },
}

const FAKE_USERS = [
  { key: 'ana',     name: 'Ana Souza',      phone: '11900000001', password: 'senha123' },
  { key: 'bruno',   name: 'Bruno Lima',     phone: '11900000002', password: 'senha123' },
  { key: 'carla',   name: 'Carla Mendes',   phone: '11900000003', password: 'senha123' },
  { key: 'diego',   name: 'Diego Rocha',    phone: '11900000004', password: 'senha123' },
  { key: 'elena',   name: 'Elena Ferreira', phone: '11900000005', password: 'senha123' },
  { key: 'fabio',   name: 'Fabio Gomes',    phone: '11900000006', password: 'senha123' },
  { key: 'gabi',    name: 'Gabi Torres',    phone: '11900000007', password: 'senha123' },
  { key: 'heitor',  name: 'Heitor Costa',   phone: '11900000008', password: 'senha123' },
  { key: 'isabela', name: 'Isabela Pires',  phone: '11900000009', password: 'senha123' },
  { key: 'joao',    name: 'Joao Vieira',    phone: '11900000010', password: 'senha123' },
  { key: 'karen',   name: 'Karen Dias',     phone: '11900000011', password: 'senha123' },
]

function getOutcome(s1: number, s2: number): 'home' | 'away' | 'draw' {
  if (s1 > s2) return 'home'
  if (s2 > s1) return 'away'
  return 'draw'
}

function calcPoints(pred: [number, number], real: [number, number]): number {
  if (pred[0] === real[0] && pred[1] === real[1]) return 3
  if (getOutcome(pred[0], pred[1]) === getOutcome(real[0], real[1])) return 1
  return 0
}

function futurePred(userIndex: number, gameNumber: number): [number, number] {
  return [(userIndex * 7 + gameNumber * 3) % 4, (userIndex * 5 + gameNumber * 11) % 4]
}

async function main() {
  console.log('seed-dev iniciado...')

  const pool = await prisma.pool.findUnique({ where: { code: POOL_CODE } })
  if (!pool) {
    console.error(`Pool "${POOL_CODE}" nao encontrada. Crie o bolao primeiro.`)
    process.exit(1)
  }
  console.log(`Pool: "${pool.name}"`)

  const games = await prisma.game.findMany({ orderBy: { number: 'asc' } })
  console.log(`${games.length} jogos encontrados`)

  for (const [numStr, [s1, s2]] of Object.entries(SCORED_GAMES)) {
    await prisma.game.update({
      where: { number: Number(numStr) },
      data: { score1: s1, score2: s2 },
    })
  }
  console.log('Placares dos jogos 1-10 aplicados\n')

  for (let i = 0; i < FAKE_USERS.length; i++) {
    const { key, name, phone, password } = FAKE_USERS[i]
    const passwordHash = await bcrypt.hash(password, 10)

    const user = await prisma.user.upsert({
      where: { phone },
      update: {},
      create: { name, phone, passwordHash },
    })

    await prisma.poolMember.upsert({
      where: { poolId_userId: { poolId: pool.id, userId: user.id } },
      update: {},
      create: { poolId: pool.id, userId: user.id },
    })

    const preds = SCORED_PREDS[key]
    let totalPts = 0
    let exactCount = 0

    for (const game of games) {
      const realScore = SCORED_GAMES[game.number]
      const pred: [number, number] = preds[game.number] ?? futurePred(i, game.number)
      const points = realScore ? calcPoints(pred, realScore) : null

      if (points === 3) exactCount++
      if (points !== null) totalPts += points

      await prisma.prediction.upsert({
        where: { userId_poolId_gameId: { userId: user.id, poolId: pool.id, gameId: game.id } },
        update: { score1: pred[0], score2: pred[1], isLocked: true, points },
        create: { userId: user.id, poolId: pool.id, gameId: game.id, score1: pred[0], score2: pred[1], isLocked: true, points },
      })
    }

    console.log(`  ${name.padEnd(16)} ${String(totalPts).padStart(2)}pts  ${exactCount}ex`)
  }

  console.log('\nRanking esperado:')
  console.log('   1  Ana Souza        30pts 10ex')
  console.log('   2  Diego Rocha      20pts  5ex  (EMPATE — Elena aparece com "—")')
  console.log('   -  Elena Ferreira   20pts  5ex')
  console.log('   4  Fabio Gomes      18pts  6ex  (sem empate — mais exatos que Gabi)')
  console.log('   5  Gabi Torres      18pts  5ex  (mesmos pts, menos exatos -> posicao diferente)')
  console.log('   6  Bruno Lima       10pts  0ex')
  console.log('   7  Heitor Costa      8pts  2ex  (EMPATE — Isabela aparece com "—")')
  console.log('   -  Isabela Pires     8pts  2ex')
  console.log('   9  Joao Vieira       3pts  1ex  (EMPATE — Karen aparece com "—")')
  console.log('   -  Karen Dias        3pts  1ex')
  console.log('  11  Carla Mendes      0pts  0ex')
  console.log('\nLogins: telefone 11900000001 a 11900000011, senha: senha123')
}

main().catch(console.error).finally(() => prisma.$disconnect())
