import { PrismaClient } from '@prisma/client'

function getOutcome(score1: number, score2: number): 'home' | 'away' | 'draw' {
  if (score1 > score2) return 'home'
  if (score2 > score1) return 'away'
  return 'draw'
}

export async function recalculatePoints(
  prisma: PrismaClient,
  gameId: string,
  realScore1: number,
  realScore2: number
) {
  const predictions = await prisma.prediction.findMany({
    where: { gameId, isLocked: true },
  })

  for (const prediction of predictions) {
    let points = 0

    if (prediction.score1 === realScore1 && prediction.score2 === realScore2) {
      points = 3
    } else if (getOutcome(prediction.score1, prediction.score2) === getOutcome(realScore1, realScore2)) {
      points = 1
    }

    await prisma.prediction.update({ where: { id: prediction.id }, data: { points } })
  }
}
