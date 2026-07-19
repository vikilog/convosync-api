/**
 * Internal service-to-service routes (Pipecat voice agent, etc.).
 * Auth: X-ConvoSync-Internal header when CONVOSYNC_INTERNAL_SECRET is set.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { saveCallTranscriptFromExternal } from '../modules/calling/call-transcript.service.js';
import { CallingError } from '../modules/calling/calling.types.js';
import {
  AiAgentRespondError,
  respondAiAgentTurn,
} from '../services/ai-agent-respond.service.js';

function assertInternalAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = config.voiceAgent.internalSecret;
  if (!expected) return true;
  const got = String(request.headers['x-convosync-internal'] || '');
  if (got !== expected) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

const transcriptBodySchema = z.object({
  text: z.string().min(1),
  language: z.string().nullable().optional(),
  segments: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
      })
    )
    .optional(),
});

const respondBodySchema = z.object({
  workspaceId: z.string().min(1),
  contactId: z.string().min(1).optional(),
  conversationId: z.string().min(1),
  message: z.string().min(1),
});

export default async function internalRoutes(fastify: FastifyInstance) {
  /** Voice Pipecat → same hybrid AI Agent stack as WhatsApp (Skills / KB). */
  fastify.post('/ai-agent/respond', async (request, reply) => {
    if (!assertInternalAuth(request, reply)) return;

    const parsed = respondBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    try {
      const result = await respondAiAgentTurn({
        workspaceId: parsed.data.workspaceId,
        conversationId: parsed.data.conversationId,
        message: parsed.data.message,
      });
      return {
        response: result.response,
        agentId: result.agentId,
        retrievalPath: result.retrievalPath ?? null,
      };
    } catch (err) {
      if (err instanceof AiAgentRespondError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error({ err }, 'internal ai-agent respond failed');
      return reply.code(500).send({ error: 'AI agent respond failed' });
    }
  });

  fastify.post('/calls/:callSessionId/transcript', async (request, reply) => {
    if (!assertInternalAuth(request, reply)) return;

    const { callSessionId } = request.params as { callSessionId: string };
    const parsed = transcriptBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    try {
      const call = await saveCallTranscriptFromExternal({
        callSessionId,
        text: parsed.data.text,
        language: parsed.data.language ?? null,
        segments: parsed.data.segments,
      });
      return {
        ok: true,
        callId: call.id,
        transcriptStatus: call.transcriptStatus,
      };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error({ err }, 'internal transcript save failed');
      return reply.code(500).send({ error: 'Failed to save transcript' });
    }
  });

  /** Live STT/TTS turn from Pipecat → Socket.IO workspace. */
  fastify.post('/calls/:callSessionId/transcript-chunk', async (request, reply) => {
    if (!assertInternalAuth(request, reply)) return;

    const { callSessionId } = request.params as { callSessionId: string };
    const parsed = z
      .object({
        role: z.enum(['customer', 'agent', 'user', 'assistant']),
        text: z.string().min(1),
        at: z.string().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    try {
      const { emitLiveTranscriptChunk } = await import(
        '../modules/calling/call-transcript.service.js'
      );
      await emitLiveTranscriptChunk({
        callSessionId,
        role: parsed.data.role === 'user' ? 'customer' : parsed.data.role === 'assistant' ? 'agent' : parsed.data.role,
        text: parsed.data.text,
        at: parsed.data.at,
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error({ err }, 'internal transcript chunk failed');
      return reply.code(500).send({ error: 'Failed to emit transcript chunk' });
    }
  });
}
