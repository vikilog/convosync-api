import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../index.js';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { getJwtUser } from '../../middleware/auth.js';
import {
  getRequestIp,
  PLATFORM_AUDIT_ACTIONS,
  recordAuditEvent,
} from '../../services/platformAudit.js';

export default async function platformAuthRoutes(fastify: FastifyInstance) {
  fastify.post('/login', async (request, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1),
      })
      .parse(request.body);

    const ip = getRequestIp(request);
    const admin = await prisma.platformAdmin.findUnique({
      where: { email: body.email.toLowerCase() },
    });

    if (!admin || !(await bcrypt.compare(body.password, admin.password))) {
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.ADMIN_LOGIN_FAILED,
        actor: { email: body.email.toLowerCase(), role: '—' },
        category: 'security',
        severity: 'danger',
        ipAddress: ip,
        metadata: {
          details: 'Invalid email or password',
          targetLabel: ip ?? body.email.toLowerCase(),
        },
      });
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

    recordAuditEvent({
      action: PLATFORM_AUDIT_ACTIONS.ADMIN_LOGIN,
      actor: { id: admin.id, email: admin.email, role: admin.role },
      category: 'auth',
      severity: 'info',
      ipAddress: ip,
      metadata: { details: 'Successful platform admin login' },
    });

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
