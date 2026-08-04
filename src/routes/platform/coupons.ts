import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { getJwtUser } from '../../middleware/auth.js';
import {
  createDiscountCoupon,
  getDiscountCouponDetail,
  listDiscountCoupons,
  setDiscountCouponActive,
  updateDiscountCoupon,
} from '../../services/discountCoupons.js';
import {
  getRequestIp,
  PLATFORM_AUDIT_ACTIONS,
  recordAuditEvent,
} from '../../services/platformAudit.js';

const couponWriteSchema = z.object({
  code: z.string().trim().min(2).max(40),
  discountPercent: z.number().int().min(0).max(100),
  maxDiscountAmountPaise: z.number().int().min(0).nullable().optional(),
  validFrom: z.string().datetime({ offset: true }).or(z.string().date()),
  validUntil: z.string().datetime({ offset: true }).or(z.string().date()),
  maxRedemptions: z.number().int().min(1),
  minOrderAmountPaise: z.number().int().min(0).nullable().optional(),
  isActive: z.boolean().optional(),
});

function parseCouponDate(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  return new Date(value);
}

export default async function platformCouponRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authenticatePlatformAdmin);

  fastify.get('/', async () => {
    const coupons = await listDiscountCoupons();
    return { coupons };
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const coupon = await getDiscountCouponDetail(id);
    if (!coupon) return reply.code(404).send({ error: 'Coupon not found' });
    return { coupon };
  });

  fastify.post('/', async (request, reply) => {
    const body = couponWriteSchema.parse(request.body);
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);
    try {
      const coupon = await createDiscountCoupon({
        code: body.code,
        discountPercent: body.discountPercent,
        maxDiscountAmountPaise: body.maxDiscountAmountPaise ?? null,
        validFrom: parseCouponDate(body.validFrom),
        validUntil: parseCouponDate(body.validUntil),
        maxRedemptions: body.maxRedemptions,
        minOrderAmountPaise: body.minOrderAmountPaise ?? null,
        isActive: body.isActive,
      });
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.COUPON_CREATE,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'coupon',
        entityId: coupon.id,
        category: 'billing',
        severity: 'info',
        ipAddress: ip,
        metadata: {
          targetLabel: coupon.code,
          details: `Created coupon ${coupon.code} (${coupon.discountPercent}% off)`,
          code: coupon.code,
          discountPercent: coupon.discountPercent,
        },
      });
      return reply.code(201).send({ coupon });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create coupon';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = couponWriteSchema.partial().parse(request.body);
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);
    try {
      const coupon = await updateDiscountCoupon(id, {
        ...(body.code != null ? { code: body.code } : {}),
        ...(body.discountPercent != null ? { discountPercent: body.discountPercent } : {}),
        ...(body.maxDiscountAmountPaise !== undefined
          ? { maxDiscountAmountPaise: body.maxDiscountAmountPaise }
          : {}),
        ...(body.validFrom != null ? { validFrom: parseCouponDate(body.validFrom) } : {}),
        ...(body.validUntil != null ? { validUntil: parseCouponDate(body.validUntil) } : {}),
        ...(body.maxRedemptions != null ? { maxRedemptions: body.maxRedemptions } : {}),
        ...(body.minOrderAmountPaise !== undefined
          ? { minOrderAmountPaise: body.minOrderAmountPaise }
          : {}),
        ...(body.isActive != null ? { isActive: body.isActive } : {}),
      });
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.COUPON_UPDATE,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'coupon',
        entityId: coupon.id,
        category: 'billing',
        severity: 'info',
        ipAddress: ip,
        metadata: {
          targetLabel: coupon.code,
          details: `Updated coupon ${coupon.code}`,
          code: coupon.code,
        },
      });
      return { coupon };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update coupon';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.patch('/:id/active', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({ isActive: z.boolean() }).parse(request.body);
    const admin = getJwtUser(request);
    const ip = getRequestIp(request);
    try {
      const coupon = await setDiscountCouponActive(id, body.isActive);
      recordAuditEvent({
        action: PLATFORM_AUDIT_ACTIONS.COUPON_ACTIVE,
        actor: { id: admin.platformAdminId, role: admin.role },
        entityType: 'coupon',
        entityId: coupon.id,
        category: 'billing',
        severity: body.isActive ? 'info' : 'warning',
        ipAddress: ip,
        metadata: {
          targetLabel: coupon.code,
          details: body.isActive
            ? `Activated coupon ${coupon.code}`
            : `Paused coupon ${coupon.code}`,
          code: coupon.code,
          isActive: body.isActive,
        },
      });
      return { coupon };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update coupon status';
      return reply.code(400).send({ error: message });
    }
  });
}
