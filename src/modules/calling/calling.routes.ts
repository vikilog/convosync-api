import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getJwtUser } from '../../middleware/auth.js';
import { companyAuth } from '../../middleware/workspaceScope.js';
import {
  callAnalyticsBodySchema,
  createCallBodySchema,
  guestTokenSchema,
  listCallsQuerySchema,
  transcribeBodySchema,
} from './calling.schemas.js';
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
import { contentDisposition } from '../../utils/contentDisposition.js';
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
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB sample audio
  });

  /** Public guest APIs — no companyAuth */
  app.get('/calls/guest/r/:code', async (request, reply) => {
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

  app.get('/calls/guest/session', { schema: { querystring: guestTokenSchema } }, async (request, reply) => {
    try {
      return await getGuestCallSession(request.query.token);
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to load guest session' });
    }
  });

  app.post('/calls/guest/token', { schema: { body: guestTokenSchema } }, async (request, reply) => {
    try {
      const session = await mintGuestCallToken(request.body.token);
      return {
        token: session.token,
        url: session.url,
        expiresInSeconds: session.expiresInSeconds,
      };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to mint guest token' });
    }
  });

  app.post('/calls/guest/connected', { schema: { body: guestTokenSchema } }, async (request, reply) => {
    try {
      const call = await markGuestCallConnected(request.body.token);
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to mark guest connected' });
    }
  });

  app.post('/calls/guest/end', { schema: { body: guestTokenSchema } }, async (request, reply) => {
    try {
      const call = await endCallAsGuest(request.body.token);
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to end call' });
    }
  });

  app.post('/calls', { ...companyAuth, schema: { body: createCallBodySchema } }, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;

      const { call, guestUrl } = await createAndRingCall({
        workspaceId: ids.workspaceId,
        conversationId: request.body.conversationId,
        direction: request.body.direction ?? 'outbound',
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
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to create call' });
    }
  });

  /** Manual sample/upload recording for STT testing */
  app.post('/calls/upload-recording', companyAuth, async (request, reply) => {
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

  app.post('/calls/:callId/guest-link', companyAuth, async (request, reply) => {
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

  app.get('/calls', { ...companyAuth, schema: { querystring: listCallsQuerySchema } }, async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;

      const calls = await listCallsForWorkspace(ids.workspaceId, {
        conversationId: request.query.conversationId,
        limit: request.query.limit,
      });
      return { calls: calls.map(publicCallPayload) };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to list calls' });
    }
  });

  app.get('/calls/:callId', companyAuth, async (request, reply) => {
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

  app.post('/calls/:callId/accept', companyAuth, async (request, reply) => {
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

  app.post('/calls/:callId/decline', companyAuth, async (request, reply) => {
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

  app.post('/calls/:callId/end', companyAuth, async (request, reply) => {
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

  app.post('/calls/:callId/connected', companyAuth, async (request, reply) => {
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

  app.post('/calls/:callId/token', companyAuth, async (request, reply) => {
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
  app.post('/calls/:callId/listen', companyAuth, async (request, reply) => {
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
  app.post('/calls/:callId/take-over', companyAuth, async (request, reply) => {
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

  app.post('/calls/:callId/resend-link', companyAuth, async (request, reply) => {
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

  app.post(
    '/calls/:callId/analytics',
    { ...companyAuth, schema: { body: callAnalyticsBodySchema } },
    async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
      const call = await saveCallAnalytics({
        workspaceId: ids.workspaceId,
        callId,
        analytics: request.body,
      });
      return { call: await publicCallPayloadEnriched(call) };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to save analytics' });
    }
  });

  app.get('/calls/:callId/recording', companyAuth, async (request, reply) => {
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

  app.delete('/calls/:callId/recording', companyAuth, async (request, reply) => {
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

  app.get('/calls/:callId/transcript', companyAuth, async (request, reply) => {
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

  app.post(
    '/calls/:callId/transcribe',
    { ...companyAuth, schema: { body: transcribeBodySchema } },
    async (request, reply) => {
    try {
      const ids = requireIds(request, reply);
      if (!ids) return;
      const { callId } = request.params as { callId: string };
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
      const language = request.body.language?.trim().toLowerCase() || undefined;
      // Allow re-queue even if a prior jobId completed
      await enqueueCallTranscript({ callId, workspaceId: ids.workspaceId, language });
      return { queued: true, callId, language: language ?? null };
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to queue transcription' });
    }
  });

  app.get('/calls/:callId/recording/file', companyAuth, async (request, reply) => {
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
      reply.header('Content-Disposition', contentDisposition('inline', `call-${callId}.ogg`));
      return reply.send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    } catch (err) {
      if (err instanceof CallingError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to stream recording' });
    }
  });
}
