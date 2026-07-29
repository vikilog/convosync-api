import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { context, trace } from '@opentelemetry/api';
import pino from 'pino';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(backendRoot, '.env') });
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './config.js';
import { corsOriginDelegate } from './lib/cors.js';
import { createOtelJsonLogStream } from './lib/pino-otel-json-stream.js';
import { authenticate } from './middleware/auth.js';

import authRoutes from './routes/auth.js';
import contactRoutes from './routes/contacts.js';
import conversationRoutes from './routes/conversations.js';
import campaignRoutes from './routes/campaigns.js';
import journeyRoutes from './modules/journey/routes/journey.routes.js';
import agentRoutes from './routes/agents.js';
import mediaGalleryRoutes from './routes/media-gallery.js';
import templateRoutes from './routes/templates.js';
import cannedResponseRoutes from './routes/canned-responses.js';
import webhookRoutes from './routes/webhooks.js';
import analyticsRoutes from './routes/analytics.js';
import whatsappRoutes from './routes/whatsapp.js';
import instagramRoutes from './routes/instagram.js';
import socialListeningRoutes from './routes/socialListening.js';
import leadsRoutes from './routes/leads.js';
import leadFunnelsRoutes from './routes/leadFunnels.js';
import messengerRoutes from './routes/messenger.js';
import metaRoutes from './routes/meta.js';
import facebookRoutes from './routes/facebook.js';
import metaAdsRoutes from './routes/metaAds.js';
import whatsappPayRoutes from './routes/whatsappPay.js';
import workspaceRoutes from './routes/workspace.js';
import onboardingRoutes from './routes/onboarding.js';
import platformAuthRoutes from './routes/platform/auth.js';
import platformOrganizationRoutes from './routes/platform/organizations.js';
import platformPlanRoutes from './routes/platform/plans.js';
import platformSettingsRoutes from './routes/platform/settings.js';
import platformDemoRequestRoutes from './routes/platform/demo-requests.js';
import platformInfrastructureRoutes from './routes/platform/infrastructure.js';
import demoRequestRoutes from './routes/demo-requests.js';
import aiKnowledgeRoutes from './modules/ai-knowledge/routes/ai-knowledge.routes.js';
import aiChatRoutes from './modules/ai-chat/routes/ai-chat.routes.js';
import developersRoutes from './modules/developers/routes/developers.routes.js';
import emailRoutes from './modules/email/routes/email.routes.js';
import googleRoutes from './modules/google/routes/google.routes.js';
import mediaRoutes from './routes/media.js';
import { startCampaignWorker } from './workers/campaign.worker.js';
import { startJourneyWorker } from './modules/journey/workers/journey-delay.worker.js';
import { startDeveloperSyncWorker } from './modules/developers/workers/sync-event.worker.js';
import { startGbpSyncWorker } from './modules/google/business-profile/workers/gbp-sync.worker.js';
import { startGbpScheduler } from './modules/google/business-profile/workers/gbp-scheduler.worker.js';
import { startTrialScheduler } from './workers/trial.scheduler.js';
import { startInstagramTokenScheduler } from './workers/instagram-token.scheduler.js';
// import { startWalletAutoRechargeWorker } from './workers/wallet-auto-recharge.worker.js';
import { initJourneyModule } from './modules/journey/container.js';
import { initEmailModule } from './modules/email/container.js';
import { initGoogleModule } from './modules/google/container.js';
import { initSocket } from './socket.js';
import { IdleTimeoutService } from './modules/ai-agent/idle-timeout.service.js';
import aiProviderRoutes from './modules/ai-agent/routes/ai-provider.routes.js';
import callingRoutes from './modules/calling/calling.routes.js';
import internalRoutes from './routes/internal.js';
import { startCallingSweeper } from './modules/calling/calling.sweeper.js';
import { startCallTranscriptWorker } from './workers/call-transcript.worker.js';
import { startContactInsightWorker } from './workers/contact-insight.worker.js';
import { startContactInsightScheduler } from './workers/contact-insight.scheduler.js';
import { startQueueDepthPoller } from './lib/queue-depth-poller.js';

export { prisma } from './lib/prisma.js';
import { prisma } from './lib/prisma.js';
export { io, getIo } from './socket.js';

async function start() {
  // Full JSON → OTel/Loki (not just msg). Trace ids still injected by pino instrumentation + mixin.
  const loggerStream = pino.multistream([
    { stream: process.stdout },
    { stream: createOtelJsonLogStream() },
  ]);

  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'warn',
      stream: loggerStream,
      mixin() {
        const span = trace.getSpan(context.active());
        if (!span) return {};
        const sc = span.spanContext();
        if (!sc.traceId || sc.traceFlags === 0) return {};
        return { trace_id: sc.traceId, span_id: sc.spanId };
      },
    },
  });

  await fastify.register(cors, {
    origin: corsOriginDelegate,
    credentials: true,
  });
  await fastify.register(import('@fastify/formbody'));
  await fastify.register(jwt, { secret: config.jwtSecret });
  await fastify.register(import('./plugins/request-timing.js'));
  await fastify.register(import('./plugins/prisma.js'));
  await fastify.register(import('./plugins/redis.plugin.js'));
  await fastify.register(import('./plugins/razorpay.plugin.js'));

  fastify.decorate('authenticate', authenticate);

  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(contactRoutes, { prefix: '/api/contacts' });
  await fastify.register(conversationRoutes, { prefix: '/api/conversations' });
  await fastify.register(campaignRoutes, { prefix: '/api/campaigns' });
  await fastify.register(journeyRoutes, { prefix: '/api/journeys' });
  await fastify.register(agentRoutes, { prefix: '/api/agents' });
  await fastify.register(mediaGalleryRoutes, { prefix: '/api/media-gallery' });
  await fastify.register(templateRoutes, { prefix: '/api/templates' });
  await fastify.register(cannedResponseRoutes, { prefix: '/api/canned-responses' });
  await fastify.register(webhookRoutes, { prefix: '/api/webhook' });
  await fastify.register(analyticsRoutes, { prefix: '/api/analytics' });
  await fastify.register(whatsappRoutes, { prefix: '/api/whatsapp' });
  await fastify.register(instagramRoutes, { prefix: '/api/instagram' });
  await fastify.register(socialListeningRoutes, { prefix: '/api/social-listening' });
  await fastify.register(leadsRoutes, { prefix: '/api/leads' });
  await fastify.register(leadFunnelsRoutes, { prefix: '/api/lead-funnels' });
  await fastify.register(messengerRoutes, { prefix: '/api/messenger' });
  await fastify.register(metaRoutes, { prefix: '/api/meta' });
  await fastify.register(facebookRoutes, { prefix: '/api/facebook' });
  await fastify.register(metaAdsRoutes, { prefix: '/api/meta-ads' });
  await fastify.register(whatsappPayRoutes, { prefix: '/api/whatsapp-pay' });
  await fastify.register(workspaceRoutes, { prefix: '/api/workspace' });
  await fastify.register(aiProviderRoutes, { prefix: '/api/workspace/ai-provider' });
  await fastify.register(onboardingRoutes, { prefix: '/api/onboarding' });
  await fastify.register(platformAuthRoutes, { prefix: '/api/platform/auth' });
  await fastify.register(platformOrganizationRoutes, { prefix: '/api/platform/organizations' });
  await fastify.register(platformPlanRoutes, { prefix: '/api/platform/plans' });
  await fastify.register(platformSettingsRoutes, { prefix: '/api/platform/settings' });
  await fastify.register(platformDemoRequestRoutes, { prefix: '/api/platform/demo-requests' });
  await fastify.register(platformInfrastructureRoutes, { prefix: '/api/platform/infrastructure' });
  await fastify.register(demoRequestRoutes, { prefix: '/api/demo-requests' });
  await fastify.register(aiKnowledgeRoutes, { prefix: '/api/ai-knowledge' });
  await fastify.register(aiChatRoutes, { prefix: '/api/ai-chat' });
  await fastify.register(developersRoutes, { prefix: '/api/developers' });
  await fastify.register(emailRoutes, { prefix: '/api/email' });
  await fastify.register(googleRoutes, { prefix: '/api/google' });
  await fastify.register(mediaRoutes, { prefix: '/api/media' });
  await fastify.register(import('./modules/billing/billing.routes.js'), { prefix: '/api' });
  await fastify.register(callingRoutes, { prefix: '/api' });
  await fastify.register(internalRoutes, { prefix: '/api/internal' });

  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  await fastify.listen({ port: config.port, host: '0.0.0.0' });

  initSocket(fastify.server);
  startCallingSweeper();
  startCallTranscriptWorker();
  startContactInsightWorker();
  startContactInsightScheduler();

  initJourneyModule(prisma);
  initEmailModule(prisma);
  initGoogleModule(prisma);
  startCampaignWorker();
  startJourneyWorker();
  startDeveloperSyncWorker();
  startGbpSyncWorker();
  startGbpScheduler();
  startTrialScheduler();
  startInstagramTokenScheduler();
  startQueueDepthPoller();
  // AUTO_RECHARGE_DISABLED — re-enable later
  // startWalletAutoRechargeWorker();

  setInterval(() => {
    const idleService = new IdleTimeoutService(fastify);
    void idleService.processAllIdleConversations().catch((err) => {
      fastify.log.error({ err }, 'Idle conversation timeout check failed');
    });
  }, 5 * 60 * 1000);

  console.log(`🚀 ConvoSync backend: http://localhost:${config.port}`);
  console.log('CORS allowlist:', config.corsAllowedOrigins.join(', ') || '(none)');
  console.log('CORS dev relaxed (localhost/ngrok/devtunnels):', config.corsDevRelaxed);
  console.log('Resend BYOP webhook (optional):', config.resendWebhookUrl);
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
