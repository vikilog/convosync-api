import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../index.js';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { getJwtUser } from '../../middleware/auth.js';

export default async function platformAuthRoutes(fastify: FastifyInstance) {
  fastify.post('/login', async (request, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1),
      })
      .parse(request.body);

    const admin = await prisma.platformAdmin.findUnique({
      where: { email: body.email.toLowerCase() },
    });

    if (!admin || !(await bcrypt.compare(body.password, admin.password))) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    const token = fastify.jwt.sign(
      {
        platformAdminId: admin.id,
        role: admin.role,
        scope: 'platform',
      },
      { expiresIn: '30d' }
    );

    return {
      token,
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
      },
    };
  });

  fastify.get(
    '/me',
    { preHandler: [authenticatePlatformAdmin] },
    async (request) => {
      const jwt = getJwtUser(request);
      const admin = await prisma.platformAdmin.findUniqueOrThrow({
        where: { id: jwt.platformAdminId! },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
      });
      return { admin };
    }
  );
}
