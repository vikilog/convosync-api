import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticatePlatformAdmin } from '../../middleware/platformAuth.js';
import { RazorpayService } from '../../modules/billing/razorpay.service.js';
import { prisma } from '../../lib/prisma.js';
import {
  createSubscriptionPlan,
  getSubscriptionPlanBySlug,
  listSubscriptionPlans,
  provisionRazorpayPlanIds,
  serializeSubscriptionPlan,
  setSubscriptionPlanActive,
  updateSubscriptionPlan,
  type PlanFeatures,
} from '../../services/subscriptionPlans.js';

const featuresSchema = z.object({
  contacts: z.string().min(1).optional(),
  teamMembers: z.string().min(1),
  aiAgents: z.string().min(1),
  channels: z.string().min(1),
  emailsPerMonth: z.union([z.number().int().min(0), z.literal('unlimited'), z.literal('custom')]).optional(),
  walletCredits: z.string().trim().min(1).max(40).optional(),
  aiCopilot: z.boolean().optional(),
  socialListening: z.boolean().optional(),
  voiceAgent: z.boolean().optional(),
  developers: z.boolean().optional(),
  whatsappPay: z.boolean().optional(),
  ctwaAds: z.boolean().optional(),
  reports: z.string().trim().min(1).max(40).optional(),
  messagesPerMonth: z.number().int().min(0).optional(),
  storageGb: z.number().int().min(0).optional(),
  apiAccess: z.boolean().optional(),
  customBranding: z.boolean().optional(),
  prioritySupport: z.boolean().optional(),
  channelsUnlimited: z.boolean().optional(),
  aiReplies: z.union([z.number().int().min(0), z.literal('unlimited'), z.literal('custom')]).optional(),
  campaigns: z.union([z.number().int().min(0), z.literal('unlimited'), z.literal('custom')]).optional(),
  integrations: z.union([z.number().int().min(0), z.literal('unlimited'), z.literal('custom')]).optional(),
});

const planWriteSchema = z.object({
  name: z.string().trim().min(2).max(80),
  planCode: z.string().trim().min(2).max(32).optional(),
  priceMonthly: z.number().int().min(0).nullable(),
  priceAnnual: z.number().int().min(0).nullable(),
  features: featuresSchema,
  kind: z.enum(['public', 'custom']).optional(),
  popular: z.boolean().optional(),
  labelColor: z.string().optional(),
  borderColor: z.string().optional(),
  editButtonStyle: z.enum(['gray', 'purple', 'blue', 'dark']).optional(),
});

export default async function platformPlanRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authenticatePlatformAdmin);
  const razorpay = new RazorpayService(fastify);

  fastify.get('/', async () => {
    const plans = await listSubscriptionPlans({
      includeCustom: true,
      includeInactive: true,
    });
    return { plans: plans.map(serializeSubscriptionPlan) };
  });

  fastify.get('/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const plan = await getSubscriptionPlanBySlug(slug);
    if (!plan) {
      return reply.code(404).send({ error: 'Plan not found' });
    }
    return { plan: serializeSubscriptionPlan(plan) };
  });

  fastify.patch('/:slug/active', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const body = z.object({ isActive: z.boolean() }).parse(request.body);
    try {
      const plan = await setSubscriptionPlanActive(slug, body.isActive);
      return { plan: serializeSubscriptionPlan(plan) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update plan status';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post('/', async (request, reply) => {
    const body = planWriteSchema.parse(request.body);
    try {
      const features = {
        ...body.features,
        contacts: 'Unlimited',
      } as PlanFeatures;
      const plan = await createSubscriptionPlan(
        {
          name: body.name,
          planCode: body.planCode,
          priceMonthly: body.priceMonthly,
          priceAnnual: body.priceAnnual,
          features,
          popular: body.popular,
          labelColor: body.labelColor,
          borderColor: body.borderColor,
          editButtonStyle: body.editButtonStyle,
        },
        { kind: body.kind ?? 'custom' }
      );

      const createPlanFn = fastify.razorpay
        ? (params: Parameters<RazorpayService['createPlan']>[0]) => razorpay.createPlan(params)
        : null;

      const provisioned = await provisionRazorpayPlanIds(plan, createPlanFn);
      const fresh = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { id: plan.id } });

      return reply.code(201).send({
        plan: serializeSubscriptionPlan(fresh),
        razorpay: {
          monthly: provisioned.razorpayPlanIdMonthly,
          annual: provisioned.razorpayPlanIdAnnual,
          warnings: provisioned.warnings,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create plan';
      return reply.code(400).send({ error: message });
    }
  });

  fastify.patch('/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const body = planWriteSchema.parse(request.body);
    try {
      const features = {
        ...body.features,
        contacts: 'Unlimited',
      } as PlanFeatures;
      const plan = await updateSubscriptionPlan(slug, {
        name: body.name,
        planCode: body.planCode,
        priceMonthly: body.priceMonthly,
        priceAnnual: body.priceAnnual,
        features,
        popular: body.popular,
        labelColor: body.labelColor,
        borderColor: body.borderColor,
        editButtonStyle: body.editButtonStyle,
      });
      return { plan: serializeSubscriptionPlan(plan) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update plan';
      return reply.code(400).send({ error: message });
    }
  });
}
