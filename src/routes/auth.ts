import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import { z } from 'zod'

const registerSchema = z.object({
  name: z.string().min(2, 'Nome muito curto'),
  phone: z.string().min(10, 'Celular inválido').max(15),
  password: z.string().min(6, 'Senha deve ter pelo menos 6 caracteres'),
})

const loginSchema = z.object({
  phone: z.string(),
  password: z.string(),
})

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/check-phone', async (request, reply) => {
    const { phone } = request.query as { phone?: string }
    if (!phone) return reply.status(400).send({ error: 'Telefone obrigatório' })
    const cleanPhone = phone.replace(/\D/g, '')
    const user = await fastify.prisma.user.findUnique({ where: { phone: cleanPhone } })
    return { exists: !!user }
  })

  fastify.post('/register', async (request, reply) => {
    const body = registerSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: body.error.errors[0].message })
    }

    const { name, phone, password } = body.data
    const cleanPhone = phone.replace(/\D/g, '')

    const existing = await fastify.prisma.user.findUnique({ where: { phone: cleanPhone } })
    if (existing) {
      return reply.status(409).send({ error: 'Celular já cadastrado' })
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const user = await fastify.prisma.user.create({
      data: { name, phone: cleanPhone, passwordHash },
    })

    const token = fastify.jwt.sign({ id: user.id, name: user.name, isAdmin: user.isAdmin })
    return { token, user: { id: user.id, name: user.name, phone: user.phone } }
  })

  fastify.post('/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'Dados inválidos' })
    }

    const { phone, password } = body.data
    const cleanPhone = phone.replace(/\D/g, '')

    const user = await fastify.prisma.user.findUnique({ where: { phone: cleanPhone } })
    if (!user) {
      return reply.status(401).send({ error: 'Celular ou senha incorretos' })
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) {
      return reply.status(401).send({ error: 'Celular ou senha incorretos' })
    }

    const token = fastify.jwt.sign({ id: user.id, name: user.name, isAdmin: user.isAdmin })
    return { token, user: { id: user.id, name: user.name, phone: user.phone, isAdmin: user.isAdmin } }
  })
}
