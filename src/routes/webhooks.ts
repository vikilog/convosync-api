import { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../index.js';
import { config } from '../config.js';
import { logInstagramWebhook } from '../services/instagramWebhookHandler.js';
import { logMessengerWebhook } from '../services/messengerWebhookHandler.js';
import { handleResendEmailWebhook } from '../modules/email/services/resend-webhook.service.js';
import { handleSesEmailWebhook } from '../modules/email/services/ses-webhook.service.js';
import { recordInboundMetaWebhook } from '../services/webhookEventLog.service.js';
import { safeStringEquals, verifyMetaWebhookSignature } from '../utils/crypto.utils.js';
import { redactWebhookPayload } from '../lib/webhookRedact.js';
import {
  handleTelegramUpdate,
  type TelegramUpdate,
} from '../services/telegramWebhookHandler.js';
import {
  enqueueWhatsAppInbound,
  type WhatsAppInboundWebhookBody,
} from '../queue/whatsapp-inbound.queue.js';
import {
  enqueueInstagramInbound,
  type InstagramInboundWebhookBody,
} from '../queue/instagram-inbound.queue.js';
import {
  enqueueMessengerInbound,
  type MessengerInboundWebhookBody,
} from '../queue/messenger-inbound.queue.js';

function logWebhook(label: string, payload: unknown) {
  const safe = typeof payload === 'string' ? payload : redactWebhookPayload(payload);
  console.log(`[WhatsApp Webhook] ${label}`, typeof safe === 'string' ? safe : JSON.stringify(safe));
}

type RawBodyRequest = FastifyRequest & { rawBody?: string };

export default async function webhookRoutes(fastify: FastifyInstance) {
  // Capture the exact bytes Meta sent (before JSON parsing) so the POST
  // handlers below can verify X-Hub-Signature-256 against them — HMAC only
  // matches over the raw body, not a re-serialized copy of the parsed object.
  fastify.addHook('preParsing', async (request, _reply, payload) => {
    if (
      !request.url.includes('/whatsapp') &&
      !request.url.includes('/instagram') &&
      !request.url.includes('/messenger')
    ) {
      return payload;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    (request as RawBodyRequest).rawBody = raw;
    const { Readable } = await import('node:stream');
    return Readable.from([raw]);
  });

  function verifyMetaSignature(request: FastifyRequest): boolean {
    if (!config.meta.appSecret) {
      if (process.env.NODE_ENV === 'production') return false;
      console.warn('[Webhook] META_APP_SECRET unset — accepting unverified payload in dev');
      return true;
    }
    const rawBody = (request as RawBodyRequest).rawBody;
    if (!rawBody) return false;
    const signature = request.headers['x-hub-signature-256'];
    return verifyMetaWebhookSignature(
      rawBody,
      typeof signature === 'string' ? signature : undefined,
      config.meta.appSecret
    );
  }

  fastify.get('/whatsapp', async (request, reply) => {
    console.log('[WhatsApp Webhook] GET hit — verification request', new Date().toISOString());
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = request.query as {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };

    const tokenMatch = safeStringEquals(token, config.meta.webhookVerifyToken);
    logWebhook('GET verify', { mode, tokenMatch, challenge });

    if (mode === 'subscribe' && tokenMatch) {
      logWebhook('GET verify → success', { challenge });
      return reply.send(challenge);
    }

    logWebhook('GET verify → forbidden', { mode, token });
    return reply.code(403).send({ error: 'Forbidden' });
  });

  fastify.post('/whatsapp', async (request, reply) => {
    console.log('[WhatsApp Webhook] POST hit — incoming event', new Date().toISOString());
    if (!verifyMetaSignature(request)) {
      logWebhook('POST → rejected', 'invalid or missing X-Hub-Signature-256');
      return reply.code(401).send({ error: 'Invalid signature' });
    }
    const body = request.body as WhatsAppInboundWebhookBody;
    // Persist receipt before ack; media / AI run on BullMQ (whatsapp-inbound).
    await recordInboundMetaWebhook(body);
    try {
      await enqueueWhatsAppInbound(body);
    } catch (err) {
      logWebhook('POST → enqueue failed', err instanceof Error ? err.message : String(err));
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Enqueue failed' });
    }
    logWebhook('POST → queued', 'ok');
    return reply.send('ok');
  });

  fastify.get('/instagram', async (request, reply) => {
    console.log('[Instagram Webhook] GET hit — verification request', new Date().toISOString());
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = request.query as {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };

    const tokenMatch = safeStringEquals(token, config.meta.webhookVerifyToken);
    logInstagramWebhook('GET verify', { mode, tokenMatch, challenge });

    if (mode === 'subscribe' && tokenMatch) {
      logInstagramWebhook('GET verify → success', { challenge });
      return reply.send(challenge);
    }

    logInstagramWebhook('GET verify → forbidden', { mode, token });
    return reply.code(403).send({ error: 'Forbidden' });
  });

  fastify.post('/instagram', async (request, reply) => {
    console.log('[Instagram Webhook] POST hit — incoming event', new Date().toISOString());
    if (!verifyMetaSignature(request)) {
      logInstagramWebhook('POST → rejected', 'invalid or missing X-Hub-Signature-256');
      return reply.code(401).send({ error: 'Invalid signature' });
    }
    const body = request.body as InstagramInboundWebhookBody;
    // Persist receipt before ack; comments / messaging / AI run on BullMQ (instagram-inbound).
    await recordInboundMetaWebhook(body);
    try {
      await enqueueInstagramInbound(body);
    } catch (err) {
      logInstagramWebhook('POST → enqueue failed', err instanceof Error ? err.message : String(err));
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Enqueue failed' });
    }
    logInstagramWebhook('POST → queued', 'ok');
    return reply.send('ok');
  });

  fastify.get('/messenger', async (request, reply) => {
    console.log('[Messenger Webhook] GET hit — verification request', new Date().toISOString());
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = request.query as {
      'hub.mode'?: string;
      'hub.verify_token'?: string;
      'hub.challenge'?: string;
    };

    const tokenMatch = safeStringEquals(token, config.meta.webhookVerifyToken);
    logMessengerWebhook('GET verify', { mode, tokenMatch, challenge });

    if (mode === 'subscribe' && tokenMatch) {
      logMessengerWebhook('GET verify → success', { challenge });
      return reply.send(challenge);
    }

    logMessengerWebhook('GET verify → forbidden', { mode, token });
    return reply.code(403).send({ error: 'Forbidden' });
  });

  fastify.post('/messenger', async (request, reply) => {
    console.log('[Messenger Webhook] POST hit — incoming event', new Date().toISOString());
    if (!verifyMetaSignature(request)) {
      logMessengerWebhook('POST → rejected', 'invalid or missing X-Hub-Signature-256');
      return reply.code(401).send({ error: 'Invalid signature' });
    }
    const body = request.body as MessengerInboundWebhookBody;
    // Persist receipt before ack; messaging / AI run on BullMQ (messenger-inbound).
    await recordInboundMetaWebhook(body);
    try {
      await enqueueMessengerInbound(body);
    } catch (err) {
      logMessengerWebhook('POST → enqueue failed', err instanceof Error ? err.message : String(err));
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Enqueue failed' });
    }
    logMessengerWebhook('POST → queued', 'ok');
    return reply.send('ok');
  });

  fastify.post('/telegram/:botId', async (request, reply) => {
    const { botId } = request.params as { botId: string };
    const secretHeaderRaw = request.headers['x-telegram-bot-api-secret-token'];
    const secretHeader = Array.isArray(secretHeaderRaw) ? secretHeaderRaw[0] : secretHeaderRaw;

    const account = await prisma.telegramAccount.findFirst({ where: { botId } });
    if (!account) {
      console.log('[Telegram Webhook] unknown bot', botId);
      return reply.code(404).send({ error: 'Unknown bot' });
    }
    if (!account.webhookSecret || !safeStringEquals(secretHeader, account.webhookSecret)) {
      console.log('[Telegram Webhook] rejected — bad secret token', { botId });
      return reply.code(401).send({ error: 'Invalid secret token' });
    }

    const body = request.body as TelegramUpdate;
    try {
      await handleTelegramUpdate(botId, body);
    } catch (err) {
      console.error('[Telegram Webhook] processing error', err);
      fastify.log.error(err);
    }

    // Telegram only cares about the HTTP status — always ack so it doesn't retry forever.
    return reply.send('ok');
  });

  await fastify.register(async function resendEmailWebhookScope(instance) {
    instance.removeContentTypeParser('application/json');
    instance.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    instance.post('/resend', async (request, reply) => {
      const payload = request.body as string;
      const headers = request.headers;

      try {
        const result = await handleResendEmailWebhook(payload, {
          svixId: headers['svix-id'] as string | undefined,
          svixTimestamp: headers['svix-timestamp'] as string | undefined,
          svixSignature: headers['svix-signature'] as string | undefined,
        });
        if (result.updated) {
          fastify.log.info({ eventType: result.eventType }, 'Resend email log updated');
        }
        return reply.send({ ok: true });
      } catch (err) {
        fastify.log.warn({ err }, 'Resend webhook rejected');
        return reply.code(400).send({ error: 'Invalid webhook' });
      }
    });
  });

  // SNS often posts as text/plain; accept json + text as raw string.
  await fastify.register(async function sesEmailWebhookScope(instance) {
    const asString = (_req: unknown, body: string, done: (err: null, body: string) => void) => {
      done(null, body);
    };
    instance.removeContentTypeParser('application/json');
    instance.addContentTypeParser('application/json', { parseAs: 'string' }, asString);
    instance.addContentTypeParser('text/plain', { parseAs: 'string' }, asString);

    instance.post('/ses-events', async (request, reply) => {
      const payload =
        typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});

      try {
        const result = await handleSesEmailWebhook(payload);
        if (result.kind === 'subscription_confirmed') {
          fastify.log.info('SES SNS subscription confirmed');
        } else if (result.kind === 'notification' && result.updated) {
          fastify.log.info({ eventType: result.eventType }, 'SES email log updated');
        }
        return reply.send({ ok: true });
      } catch (err) {
        fastify.log.warn({ err }, 'SES SNS webhook rejected');
        return reply.code(400).send({ error: 'Invalid webhook' });
      }
    });
  });
}
