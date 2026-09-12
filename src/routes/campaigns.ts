import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  resendFailedCampaign,
  resendRecipient,
  resumeCampaign,
  sendCampaign,
  updateCampaign,
} from '../modules/campaigns/campaigns.controller.js';
import { campaignCreateSchema, campaignUpdateSchema } from './campaigns.schemas.js';

export default async function campaignRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  fastify.get('/', auth, listCampaigns);
  fastify.get('/:id', auth, getCampaign);
  app.post('/', { ...auth, schema: { body: campaignCreateSchema } }, createCampaign);
  app.patch('/:id', { ...auth, schema: { body: campaignUpdateSchema } }, updateCampaign);
  fastify.post('/:id/send', auth, sendCampaign);
  fastify.post('/:id/cancel', auth, cancelCampaign);
  fastify.post('/:id/resume', auth, resumeCampaign);
  fastify.delete('/:id', auth, deleteCampaign);
  fastify.post('/:id/resend-failed', auth, resendFailedCampaign);
  fastify.post('/:id/recipients/:messageId/resend', auth, resendRecipient);
}
