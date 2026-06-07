import { FastifyRequest, FastifyReply } from 'fastify'

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify()
  } catch {
    reply.status(401).send({ error: 'Token inválido ou expirado' })
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify()
    const user = request.user as { isAdmin: boolean }
    if (!user.isAdmin) {
      reply.status(403).send({ error: 'Acesso restrito' })
    }
  } catch {
    reply.status(401).send({ error: 'Token inválido ou expirado' })
  }
}
