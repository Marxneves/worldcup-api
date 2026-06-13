import { PrismaClient } from '@prisma/client'

if (process.env.NODE_ENV === 'production') {
  console.error('Este script nao pode rodar em producao.')
  process.exit(1)
}

const gameNumber = parseInt(process.argv[2] ?? '4')

if (isNaN(gameNumber)) {
  console.error('Uso: tsx scripts/clear-game-result.ts <numero_do_jogo>')
  process.exit(1)
}

const prisma = new PrismaClient()

async function run() {
  const game = await prisma.game.findUnique({ where: { number: gameNumber } })
  if (!game) {
    console.error(`Jogo ${gameNumber} nao encontrado.`)
    process.exit(1)
  }

  await prisma.prediction.updateMany({
    where: { gameId: game.id },
    data: { points: null },
  })

  await prisma.game.update({
    where: { id: game.id },
    data: { score1: null, score2: null, resultFetched: false },
  })

  console.log(`Jogo ${gameNumber} (${game.team1} x ${game.team2}): resultado limpo. Pontos dos palpites zerados.`)
  console.log('Acesse a aba de Resumo no app para o placar ser buscado automaticamente.')
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
