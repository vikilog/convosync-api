import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { getJwtUser } from '../../middleware/auth.js';
import { companyAuth } from '../../middleware/workspaceScope.js';
import {
  acceptCall,
  createAndRingCall,
  declineCall,
  endCall,
  endCallAsGuest,
  getCallForWorkspace,
  getCallRecordingAccess,
  deleteCallRecording,
  getGuestCallSession,
  getOrRefreshGuestUrl,
  listCallsForWorkspace,
  markCallConnected,
  markGuestCallConnected,
  mintAgentCallToken,
  mintGuestCallToken,
  mintListenInCallToken,
  publicCallPayload,
  publicCallPayloadEnriched,
  resendGuestCallLink,
  resolveGuestShortCode,
  saveCallAnalytics,
  takeOverCall,
  uploadManualCallRecording,
} from './calling.service.js';
import {
  getCallTranscript,
} from './call-transcript.service.js';
import { enqueueCallTranscript } from '../../queue/call-transcript.queue.js';
import { CallingError } from './calling.types.js';
import { getObject, mimeTypeFromStorageKey } from '../../services/objectStorage.js';
import { prisma } from '../../lib/prisma.js';

function requireIds(
  request: Parameters<typeof getJwtUser>[0],
  reply: { code: (n: number) => { send: (b: unknown) => unknown } }
) {
  const jwt = getJwtUser(request);
  if (!jwt.workspaceId || !jwt.userId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return { workspaceId: jwt.workspaceId, userId: jwt.userId };
}

export default async function callingRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB sample audio
  });

  /** Public guest APIs — no companyAuth */
  fastify.get('/calls/guest/r/:code', async (request, reply) => {
    try {
      const { code } = request.params as { code: string };
      const resolved = await resolveGuestShortCode(code);
      return resolved;
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to resolve guest link' });
    }
  });

  fastify.get('/calls/guest/session', async (request, reply) => {
    try {
      const q = z.object({ token: z.string().min(10) }).parse(request.query);
      return await getGuestCallSession(q.token);
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request' });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to load guest session' });
    }
  });

  fastify.post('/calls/guest/token', async (request, reply) => {
    try {
      const body = z.object({ token: z.string().min(10) }).parse(request.body);
      const session = await mintGuestCallToken(body.token);
      return {
        token: session.token,
        url: session.url,
        expiresInSeconds: session.expiresInSeconds,
      };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request' });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to mint guest token' });
    }
  });

  fastify.post('/calls/guest/connected', async (request, reply) => {
    try {
      const body = z.object({ token: z.string().min(10) }).parse(request.body);
      const call = await markGuestCallConnected(body.token);
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request' });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to mark guest connected' });
    }
  });

  fastify.post('/calls/guest/end', async (request, reply) => {
    try {
      const body = z.object({ token: z.string().min(10) }).parse(request.body);
      const call = await endCallAsGuest(body.token);
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to end call' });
    }
  });

  fastify.post('/calls', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const body = z
        .object({
          conversationId: z.string().min(1),
          direction: z.enum(['inbound', 'outbound']).optional(),
        })
        .parse(request.body);

      const { call, guestUrl } = await createAndRingCall({
        workspaceId: ids.workspaceId,
        conversationId: body.conversationId,
        direction: body.direction ?? 'outbound',
        initiatedByUserId: ids.userId,
      });

      return reply.code(201).send({
        call: await publicCallPayloadEnriched(call),
        guestUrl,
        callPagePath: `/call/${call.id}`,
      });
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request', details: err.flatten() });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to create call' });
    }
  });

  /** Manual sample/upload recording for STT testing */
  fastify.post('/calls/upload-recording', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;

      let conversationId = '';
      let language = '';
      let buffer: Buffer | null = null;
      let mimeType = 'audio/mpeg';
      let fileName = 'upload.mp3';

      for await (const part of request.parts()) {
        if (part.type === 'file') {
          buffer = await part.toBuffer();
          mimeType = part.mimetype || mimeType;
          fileName = part.filename || fileName;
        } else if (part.type === 'field' && part.fieldname === 'conversationId') {
          conversationId = String(part.value || '');
        } else if (part.type === 'field' && part.fieldname === 'language') {
          language = String(part.value || '').trim().toLowerCase();
        }
      }

      if (!conversationId) {
        return reply.code(400).send({ error: 'conversationId is required' });
      }
      if (!buffer?.length) {
        return reply.code(400).send({ error: 'audio file is required' });
      }

      const call = await uploadManualCallRecording({
        workspaceId: ids.workspaceId,
        conversationId,
        userId: ids.userId,
        buffer,
        mimeType,
        fileName,
        language: language || undefined,
      });

      return reply.code(201).send({
        call: await publicCallPayloadEnriched(call),
        queuedTranscript: true,
      });
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to upload recording' });
    }
  });

  fastify.post('/calls/:callId/guest-link', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      return await getOrRefreshGuestUrl({
        workspaceId: ids.workspaceId,
        callId,
        rotate: true,
      });
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to refresh guest link' });
    }
  });

  fastify.get('/calls', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const query = z
        .object({
          conversationId: z.string().optional(),
          limit: z.coerce.number().int().positive().max(100).optional(),
        })
        .parse(request.query);

      const calls = await listCallsForWorkspace(ids.workspaceId, {
        conversationId: query.conversationId,
        limit: query.limit,
      });
      return { calls: calls.map(publicCallPayload) };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid query', details: err.flatten() });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to list calls' });
    }
  });

  fastify.get('/calls/:callId', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const call = await getCallForWorkspace(ids.workspaceId, callId);
      if (!call) {
        return reply.code(404).send({ error: 'Call not found', code: 'call_not_found' });
      }
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to get call' });
    }
  });

  fastify.post('/calls/:callId/accept', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const call = await acceptCall({
        workspaceId: ids.workspaceId,
        callId,
        userId: ids.userId,
      });
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to accept call' });
    }
  });

  fastify.post('/calls/:callId/decline', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const call = await declineCall({
        workspaceId: ids.workspaceId,
        callId,
        userId: ids.userId,
      });
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to decline call' });
    }
  });

  fastify.post('/calls/:callId/end', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const call = await endCall({
        workspaceId: ids.workspaceId,
        callId,
        userId: ids.userId,
      });
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to end call' });
    }
  });

  fastify.post('/calls/:callId/connected', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const call = await markCallConnected({
        workspaceId: ids.workspaceId,
        callId,
        userId: ids.userId,
      });
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to mark call connected' });
    }
  });

  fastify.post('/calls/:callId/token', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const session = await mintAgentCallToken({
        workspaceId: ids.workspaceId,
        callId,
        userId: ids.userId,
      });
      return {
        token: session.token,
        url: session.url,
        expiresInSeconds: session.expiresInSeconds,
        callId,
      };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to mint call token' });
    }
  });

  /** Subscribe-only while AI is on the call. */
  fastify.post('/calls/:callId/listen', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const session = await mintListenInCallToken({
        workspaceId: ids.workspaceId,
        callId,
        userId: ids.userId,
      });
      return {
        token: session.token,
        url: session.url,
        expiresInSeconds: session.expiresInSeconds,
        callId,
        mode: 'listen' as const,
      };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to mint listen-in token' });
    }
  });

  /** Stop AI voice agent (LiveKit data + remove) and mint publish token for human. */
  fastify.post('/calls/:callId/take-over', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const result = await takeOverCall({
        workspaceId: ids.workspaceId,
        callId,
        userId: ids.userId,
      });
      return {
        call: await publicCallPayloadEnriched(result.call),
        token: result.token,
        url: result.url,
        expiresInSeconds: result.expiresInSeconds,
      };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to take over call' });
    }
  });

  fastify.post('/calls/:callId/resend-link', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      return await resendGuestCallLink({
        workspaceId: ids.workspaceId,
        callId,
        userId: ids.userId,
      });
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to resend guest link' });
    }
  });

  fastify.post('/calls/:callId/analytics', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const body = z.record(z.unknown()).parse(request.body ?? {});
      const call = await saveCallAnalytics({
        workspaceId: ids.workspaceId,
        callId,
        analytics: body,
      });
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid analytics payload' });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to save analytics' });
    }
  });

  fastify.get('/calls/:callId/recording', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      return await getCallRecordingAccess({
        workspaceId: ids.workspaceId,
        callId,
      });
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to get recording' });
    }
  });

  fastify.delete('/calls/:callId/recording', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const call = await deleteCallRecording({
        workspaceId: ids.workspaceId,
        callId,
      });
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to delete recording' });
    }
  });

  fastify.get('/calls/:callId/transcript', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      return await getCallTranscript({
        workspaceId: ids.workspaceId,
        callId,
      });
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to get transcript' });
    }
  });

  fastify.post('/calls/:callId/transcribe', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const body = z
        .object({
          language: z.string().min(2).max(16).optional(),
        })
        .parse(request.body ?? {});
      const call = await getCallForWorkspace(ids.workspaceId, callId);
      if (!call) {
        return reply.code(404).send({ error: 'Call not found', code: 'call_not_found' });
      }
      if (call.recordingStatus !== 'ready') {
        return reply.code(409).send({ error: 'Recording not ready', code: 'recording_not_ready' });
      }
      await prisma.callSession.update({
        where: { id: callId },
        data: { transcriptStatus: 'pending', transcriptError: null },
      });
      const language = body.language?.trim().toLowerCase() || undefined;
      // Allow re-queue even if a prior jobId completed
      await enqueueCallTranscript({ callId, workspaceId: ids.workspaceId, language });
      return { queued: true, callId, language: language ?? null };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid body', details: err.flatten() });
      }
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to queue transcription' });
    }
  });

  fastify.get('/calls/:callId/recording/file', companyAuth, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const call = await getCallForWorkspace(ids.workspaceId, callId);
      if (!call?.recordingStorageKey || call.recordingStatus !== 'ready') {
        return reply.code(404).send({ error: 'Recording not available' });
      }
      const buf = await getObject(call.recordingStorageKey);
      reply.header('Content-Type', mimeTypeFromStorageKey(call.recordingStorageKey));
      reply.header('Content-Disposition', `inline; filename="call-${callId}.ogg"`);
      return reply.send(buf);
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to stream recording' });
    }
  });
}
