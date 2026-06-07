import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import { prismaPlugin } from './plugins/prisma'
import { authRoutes } from './routes/auth'
import { poolRoutes } from './routes/pools'
import { gameRoutes } from './routes/games'
import { predictionRoutes } from './routes/predictions'
import { adminRoutes } from './routes/admin'
import { scheduleScraper } from './services/scraper.service'

const app = Fastify({ logger: process.env.NODE_ENV !== 'production' })

async function start() {
  const isDev = process.env.NODE_ENV !== 'production'

  const allowedOrigins = [
    process.env.FRONTEND_URL,
    'http://localhost:5173',
    'http://localhost:4173',
  ].filter(Boolean) as string[]

  await app.register(cors, {
    origin: (origin, cb) => {
      if (isDev || !origin || allowedOrigins.some(allowed => origin.startsWith(allowed))) {
        cb(null, true)
      } else {
        cb(new Error(`CORS: origin ${origin} not allowed`), false)
      }
    },
    credentials: true,
  })

  await app.register(jwt, {
    secret: process.env.JWT_SECRET || 'worldcup2026-dev-secret-change-in-prod',
  })

  await app.register(prismaPlugin)

  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(poolRoutes, { prefix: '/pools' })
  await app.register(gameRoutes, { prefix: '/games' })
  await app.register(predictionRoutes, { prefix: '/predictions' })
  await app.register(adminRoutes, { prefix: '/admin' })

  app.get('/health', async () => ({ status: 'ok' }))

  if (process.env.NODE_ENV === 'production') {
    scheduleScraper()
  }

  const port = Number(process.env.PORT) || 3001
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`API running on http://localhost:${port}`)
}

start().catch(err => {
  console.error(err)
  process.exit(1)
})
