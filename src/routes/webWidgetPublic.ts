import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../index.js';
import { AgentTestError, testAgentChat } from '../services/agent-test.service.js';
import { OpenAiProviderError } from '../modules/ai-chat/providers/openai.provider.js';
import { recordWorkspaceTokenUsage } from '../services/workspaceTokenUsage.js';

/**
 * Public, unauthenticated-by-JWT endpoints the embedded website widget calls
 * directly from arbitrary third-party origins — auth is the opaque `token`
 * (see webWidget.ts), not a session. CORS is deliberately wide open here
 * (registered fresh in this plugin's own scope) since the whole point is any
 * customer site can embed it; every other route stays on the strict app-wide
 * allowlist from index.ts.
 */

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_TURNS = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;

const rateLimitBuckets = new Map<string, number[]>();

function isRateLimited(token: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = (rateLimitBuckets.get(token) ?? []).filter((t) => t > windowStart);
  hits.push(now);
  rateLimitBuckets.set(token, hits);
  return hits.length > RATE_LIMIT_MAX_REQUESTS;
}

const chatSchema = z.object({
  token: z.string().min(1),
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(MAX_MESSAGE_LENGTH),
      })
    )
    .max(MAX_HISTORY_TURNS)
    .optional(),
});

export default async function webWidgetPublicRoutes(fastify: FastifyInstance) {
  // Deliberately open CORS, scoped to just this plugin — the app-wide
  // @fastify/cors instance (registered once in index.ts) stays on its strict
  // allowlist for every other route. Set headers by hand rather than
  // registering @fastify/cors a second time: a nested registration of the
  // same plugin hangs the whole server (AVV_ERR_PLUGIN_EXEC_TIMEOUT).
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
  });
  fastify.options('/config', async (_request, reply) => {
    reply.code(204).send();
  });
  fastify.options('/chat', async (_request, reply) => {
    reply.code(204).send();
  });

  fastify.get('/config', async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token) return reply.code(400).send({ error: 'Missing token' });

    const widget = await prisma.webWidget.findUnique({ where: { token } });
    if (!widget || !widget.enabled) {
      return reply.code(404).send({ error: 'Widget not found' });
    }

    return {
      botName: widget.botName,
      greeting: widget.greeting,
      accentColor: widget.accentColor,
    };
  });

  fastify.post('/chat', async (request, reply) => {
    const body = chatSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }
    const { token, message, history } = body.data;

    if (isRateLimited(token)) {
      return reply.code(429).send({ error: 'Too many messages — please slow down.' });
    }

    const widget = await prisma.webWidget.findUnique({
      where: { token },
      include: { agent: { select: { isPublished: true, isEnabled: true } } },
    });
    if (!widget || !widget.enabled) {
      return reply.code(404).send({ error: 'Widget not found' });
    }
    if (!widget.agentId || !widget.agent?.isPublished || !widget.agent?.isEnabled) {
      return reply.code(409).send({ error: 'No AI Agent is connected to this widget yet.' });
    }

    try {
      const result = await testAgentChat({
        workspaceId: widget.workspaceId,
        agentId: widget.agentId,
        message,
        conversationHistory: history ?? [],
      });

      await recordWorkspaceTokenUsage({
        workspaceId: widget.workspaceId,
        agentId: 'web_widget',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });

      return { response: result.reply };
    } catch (err) {
      if (err instanceof AgentTestError || err instanceof OpenAiProviderError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      fastify.log.error(err);
      return reply.code(502).send({ error: 'The assistant is temporarily unavailable.' });
    }
  });
}
