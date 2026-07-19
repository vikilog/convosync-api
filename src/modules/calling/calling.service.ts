import type { CallSession, Prisma } from '@prisma/client';
import { Prisma as PrismaNS } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { getIo } from '../../socket.js';
import { config } from '../../config.js';
import {
  ACTIVE_CALL_STATUSES,
  CALL_SOCKET_EVENTS,
  CallingError,
  type CallDirection,
  type CallStatus,
  type CallTransitionRecord,
} from './calling.types.js';
import { assertCallTransition, canTransitionCallStatus } from './calling.state-machine.js';
import {
  agentLiveKitIdentity,
  buildCallRoomName,
  customerLiveKitIdentity,
  deleteLiveKitRoom,
  ensureLiveKitRoom,
  listenerLiveKitIdentity,
  mintLiveKitAccessToken,
  signalAiAgentTakeOver,
  startCallRecording,
  stopAndFinalizeRecording,
  callRecordingStorageKey,
} from './livekit.service.js';
import {
  buildCallGuestShortUrl,
  buildCallGuestUrl,
  newGuestShortCode,
  signCallGuestToken,
  verifyCallGuestToken,
} from './guest-token.service.js';
import { putObject, getPresignedGetUrl, isObjectStorageEnabled, deleteObject } from '../../services/objectStorage.js';
import { enqueueCallTranscript } from '../../queue/call-transcript.queue.js';
import { getWorkspaceWhatsAppCredentials } from '../../services/whatsappCredentials.js';
import { getWorkspaceInstagramCredentials } from '../../services/instagramCredentials.js';
import { sendWhatsAppMessage } from '../../services/whatsapp.js';
import { sendInstagramMessage } from '../../services/instagram.js';
import { getWorkspaceMessengerCredentials } from '../../services/messengerCredentials.js';
import { sendMessengerMessage } from '../../services/messenger.js';
import { parseInstagramScopedUserId, parseMessengerPsid } from '../../lib/channelContact.js';
import {
  findVoiceAgentForConversation,
  maybeStartVoiceAgentForCall,
} from './voice-agent-trigger.service.js';

async function allocateGuestShortCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = newGuestShortCode();
    const clash = await prisma.callSession.findUnique({
      where: { guestShortCode: code },
      select: { id: true },
    });
    if (!clash) return code;
  }
  throw new CallingError('Could not allocate guest link', 500, 'short_code_exhausted');
}

function asStatus(s: string): CallStatus {
  return s as CallStatus;
}

function appendTransition(
  metadata: unknown,
  from: CallStatus,
  to: CallStatus,
  extra?: { reason?: string; byUserId?: string }
): Prisma.InputJsonValue {
  const prev =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const transitions = Array.isArray(prev.transitions)
    ? ([...prev.transitions] as CallTransitionRecord[])
    : [];
  transitions.push({
    at: new Date().toISOString(),
    from,
    to,
    reason: extra?.reason,
    byUserId: extra?.byUserId,
  });
  return { ...prev, transitions } as Prisma.InputJsonValue;
}

function emitCall(workspaceId: string, event: string, payload: Record<string, unknown>) {
  try {
    getIo().to(workspaceId).emit(event, payload);
  } catch (err) {
    console.warn('[calling] socket emit failed', event, err);
  }
}

function publicCallPayload(call: CallSession) {
  return {
    callId: call.id,
    workspaceId: call.workspaceId,
    conversationId: call.conversationId,
    contactId: call.contactId,
    direction: call.direction,
    status: call.status,
    roomName: call.roomName,
    assignedTo: call.assignedTo,
    initiatedByUserId: call.initiatedByUserId,
    acceptedByUserId: call.acceptedByUserId,
    ringingAt: call.ringingAt,
    ringingUntil: call.ringingUntil,
    acceptedAt: call.acceptedAt,
    connectedAt: call.connectedAt,
    endedAt: call.endedAt,
    durationSeconds: call.durationSeconds,
    endReason: call.endReason,
    guestTokenExpiresAt: call.guestTokenExpiresAt,
    guestJoinedAt: call.guestJoinedAt,
    guestLinkSentAt: call.guestLinkSentAt,
    recordingStatus: call.recordingStatus,
    recordingUrl: call.recordingUrl,
    recordingStorageKey: call.recordingStorageKey,
    recordingStartedAt: call.recordingStartedAt,
    recordingEndedAt: call.recordingEndedAt,
    recordingDurationSeconds: call.recordingDurationSeconds,
    recordingCodec: call.recordingCodec,
    recordingFileSize: call.recordingFileSize,
    transcriptStatus: call.transcriptStatus,
    transcriptLanguage: call.transcriptLanguage,
    transcriptAt: call.transcriptAt,
    currentHandler: call.currentHandler ?? 'none',
    takenOverAt: call.takenOverAt ?? null,
    takenOverByUserId: call.takenOverByUserId ?? null,
    createdAt: call.createdAt,
  };
}

async function transitionCall(
  call: CallSession,
  to: CallStatus,
  patch: Prisma.CallSessionUpdateInput,
  extra?: { reason?: string; byUserId?: string }
): Promise<CallSession> {
  const from = asStatus(call.status);
  if (from === to) return call;
  assertCallTransition(from, to);

  const updated = await prisma.callSession.update({
    where: { id: call.id },
    data: {
      ...patch,
      status: to,
      metadata: appendTransition(call.metadata, from, to, extra),
    },
  });
  return updated;
}

/** Create outbound (agent-initiated) call for customer browser join via guest link. */
export async function createAndRingCall(input: {
  workspaceId: string;
  conversationId: string;
  direction: CallDirection;
  initiatedByUserId?: string;
}): Promise<{ call: CallSession; guestUrl: string | null; guestToken: string | null }> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    include: {
      contact: { select: { id: true, name: true, phone: true } },
      workspace: { select: { id: true, name: true } },
    },
  });
  if (!conversation) {
    throw new CallingError('Conversation not found', 404, 'conversation_not_found');
  }

  // End any in-flight call for this conversation so Start Call always issues a fresh link
  const existingActive = await prisma.callSession.findMany({
    where: {
      workspaceId: input.workspaceId,
      conversationId: conversation.id,
      status: { in: [...ACTIVE_CALL_STATUSES] },
    },
    orderBy: { createdAt: 'desc' },
  });
  for (const existing of existingActive) {
    await finalizeCall(existing, 'ended', {
      reason: 'superseded_by_new_call',
      byUserId: input.initiatedByUserId,
    });
  }

  const assignedTo =
    conversation.assigneeType === 'user' && conversation.assignedTo
      ? conversation.assignedTo
      : input.initiatedByUserId ?? null;

  const provisional = await prisma.callSession.create({
    data: {
      workspaceId: input.workspaceId,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      direction: input.direction,
      status: 'initiated',
      roomName: `pending_${input.workspaceId}_${Date.now()}`,
      initiatedByUserId: input.initiatedByUserId ?? null,
      assignedTo,
      metadata: {
        transitions: [
          {
            at: new Date().toISOString(),
            from: 'initiated',
            to: 'initiated',
            reason: 'created',
            byUserId: input.initiatedByUserId,
          },
        ],
      },
    },
  });

  const roomName = buildCallRoomName(input.workspaceId, provisional.id);
  await ensureLiveKitRoom(roomName);
  const ringingAt = new Date();
  // Guest-link calls wait longer than agent ring (link TTL)
  const waitSeconds = Math.max(
    config.livekit.ringTimeoutSeconds,
    config.livekit.guestTokenTtlSeconds
  );
  const ringingUntil = new Date(ringingAt.getTime() + waitSeconds * 1000);

  let guestUrl: string | null = null;
  let guestToken: string | null = null;
  let guestTokenJti: string | null = null;
  let guestTokenExpiresAt: Date | null = null;
  let guestShortCode: string | null = null;

  if (conversation.contactId) {
    const signed = signCallGuestToken({
      callId: provisional.id,
      workspaceId: input.workspaceId,
      contactId: conversation.contactId,
    });
    guestToken = signed.token;
    guestTokenJti = signed.jti;
    guestTokenExpiresAt = signed.expiresAt;
    guestShortCode = await allocateGuestShortCode();
    guestUrl = buildCallGuestShortUrl(guestShortCode);
  }

  let call = await prisma.callSession.update({
    where: { id: provisional.id },
    data: {
      roomName,
      guestTokenJti,
      guestTokenExpiresAt,
      guestShortCode,
    },
  });

  const participantCreates: Prisma.CallParticipantCreateManyInput[] = [];
  if (conversation.contactId) {
    participantCreates.push({
      callSessionId: call.id,
      role: 'customer',
      identity: customerLiveKitIdentity(conversation.contactId),
      contactId: conversation.contactId,
    });
  }
  if (input.initiatedByUserId) {
    participantCreates.push({
      callSessionId: call.id,
      role: 'agent',
      identity: agentLiveKitIdentity(input.initiatedByUserId),
      userId: input.initiatedByUserId,
    });
  }
  if (participantCreates.length > 0) {
    await prisma.callParticipant.createMany({
      data: participantCreates,
      skipDuplicates: true,
    });
  }

  call = await transitionCall(
    call,
    'ringing',
    { ringingAt, ringingUntil },
    { reason: 'waiting_for_customer', byUserId: input.initiatedByUserId }
  );

  // Agent is ready on the call page — mark accepted so they can join LiveKit immediately
  if (input.initiatedByUserId) {
    const acceptedAt = new Date();
    await prisma.callSession.updateMany({
      where: { id: call.id, status: 'ringing' },
      data: {
        status: 'accepted',
        acceptedByUserId: input.initiatedByUserId,
        acceptedAt,
      },
    });
    call = await prisma.callSession.update({
      where: { id: call.id },
      data: {
        metadata: appendTransition(call.metadata, 'ringing', 'accepted', {
          reason: 'agent_ready_on_call_page',
          byUserId: input.initiatedByUserId,
        }),
      },
    });
  }

  const payload = {
    ...publicCallPayload(call),
    contact: conversation.contact
      ? {
          id: conversation.contact.id,
          name: conversation.contact.name,
          phone: conversation.contact.phone,
        }
      : null,
    workspaceName: conversation.workspace.name,
    guestUrl,
  };

  emitCall(input.workspaceId, CALL_SOCKET_EVENTS.initiated, payload);
  // No agent-agent incoming_call for customer-link flow

  // If conversation is assigned to a voice-enabled AI agent, mark handler=ai
  // BEFORE returning so CallPage never asks for mic on open.
  const voiceAgent = await findVoiceAgentForConversation(input.workspaceId, {
    id: conversation.id,
    contactId: conversation.contactId,
    assigneeType: conversation.assigneeType,
    assigneeId: conversation.assigneeId,
  });
  if (voiceAgent) {
    call = await prisma.callSession.update({
      where: { id: call.id },
      data: { currentHandler: 'ai' },
    });
    emitCall(input.workspaceId, CALL_SOCKET_EVENTS.handlerChanged, {
      ...publicCallPayload(call),
      previousHandler: 'none',
    });
    void maybeStartVoiceAgentForCall(
      call,
      {
        id: conversation.id,
        contactId: conversation.contactId,
        assigneeType: conversation.assigneeType,
        assigneeId: conversation.assigneeId,
      },
      voiceAgent
    ).catch((err) => console.warn('[calling] voice agent trigger failed', call.id, err));
  }

  // Auto-send short guest link on the conversation channel (best-effort)
  if (guestUrl && conversation.id) {
    try {
      const sent = await sendGuestCallLinkToConversation({
        workspaceId: input.workspaceId,
        conversationId: conversation.id,
        guestUrl,
        agentUserId: input.initiatedByUserId,
      });
      if (sent) {
        call = await prisma.callSession.update({
          where: { id: call.id },
          data: { guestLinkSentAt: new Date() },
        });
      }
    } catch (err) {
      console.warn('[calling] auto-send guest link failed', call.id, err);
    }
  }

  return { call, guestUrl, guestToken };
}

export async function getCallForWorkspace(
  workspaceId: string,
  callId: string
): Promise<CallSession | null> {
  return prisma.callSession.findFirst({
    where: { id: callId, workspaceId },
  });
}

export async function listCallsForWorkspace(
  workspaceId: string,
  opts?: { conversationId?: string; limit?: number }
): Promise<CallSession[]> {
  return prisma.callSession.findMany({
    where: {
      workspaceId,
      ...(opts?.conversationId ? { conversationId: opts.conversationId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts?.limit ?? 50, 100),
  });
}

/** Mark terminal and delete LiveKit room (best-effort). */
export async function finalizeCall(
  call: CallSession,
  to: Extract<CallStatus, 'declined' | 'missed' | 'ended' | 'failed'>,
  opts?: { reason?: string; byUserId?: string }
): Promise<CallSession> {
  if (!canTransitionCallStatus(asStatus(call.status), to) && asStatus(call.status) !== to) {
    throw new CallingError(
      `Cannot move call from ${call.status} to ${to}`,
      409,
      'illegal_call_transition'
    );
  }
  if (asStatus(call.status) === to) return call;

  const endedAt = new Date();
  let durationSeconds: number | null = null;
  if (call.connectedAt) {
    durationSeconds = Math.max(
      0,
      Math.round((endedAt.getTime() - call.connectedAt.getTime()) / 1000)
    );
  }

  const updated = await transitionCall(
    call,
    to,
    {
      endedAt,
      durationSeconds,
      endReason: opts?.reason ?? to,
    },
    { reason: opts?.reason, byUserId: opts?.byUserId }
  );

  // Stop egress before destroying the room so the file can finish
  await finalizeRecordingForCall(updated);

  await deleteLiveKitRoom(updated.roomName);

  const event =
    to === 'missed'
      ? CALL_SOCKET_EVENTS.missed
      : to === 'declined'
        ? CALL_SOCKET_EVENTS.declined
        : to === 'failed'
          ? CALL_SOCKET_EVENTS.failed
          : CALL_SOCKET_EVENTS.ended;

  const fresh = (await prisma.callSession.findUnique({ where: { id: updated.id } })) ?? updated;
  emitCall(fresh.workspaceId, event, publicCallPayload(fresh));
  return fresh;
}

async function persistRecordingBytes(storageKey: string, location?: string): Promise<void> {
  if (!location || !location.startsWith('http')) return;
  // When egress wrote straight to our S3, location is often an s3/https URL we already own
  if (isObjectStorageEnabled() && location.includes(storageKey)) return;

  const res = await fetch(location);
  if (!res.ok) {
    throw new Error(`recording download failed (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await putObject(storageKey, buf, 'audio/ogg');
}

async function finalizeRecordingForCall(call: CallSession): Promise<CallSession> {
  if (!call.recordingEgressId) {
    if (call.guestJoinedAt && config.livekit.enabled && call.recordingStatus !== 'ready') {
      return prisma.callSession.update({
        where: { id: call.id },
        data: {
          recordingStatus: 'skipped',
          recordingError: 'no_egress_id',
          recordingEndedAt: new Date(),
        },
      });
    }
    return call;
  }

  if (call.recordingStatus === 'ready' || call.recordingStatus === 'failed') {
    return call;
  }

  const processing = await prisma.callSession.update({
    where: { id: call.id },
    data: { recordingStatus: 'processing' },
  });

  // Don't block hangup on egress finalize (can take tens of seconds)
  void completeRecordingJob(processing).catch((err) => {
    console.warn('[calling] background recording finalize', processing.id, err);
  });

  return processing;
}

async function completeRecordingJob(call: CallSession): Promise<void> {
  if (!call.recordingEgressId) return;
  try {
    const result = await stopAndFinalizeRecording({
      egressId: call.recordingEgressId,
      workspaceId: call.workspaceId,
      callId: call.id,
    });

    if (result.status === 'ready' && result.storageKey) {
      try {
        await persistRecordingBytes(result.storageKey, result.location);
      } catch (err) {
        console.warn('[calling] persist recording', call.id, err);
        if (!isObjectStorageEnabled()) throw err;
      }

      let recordingUrl: string | null = result.location ?? null;
      if (isObjectStorageEnabled() && result.storageKey) {
        try {
          recordingUrl = await getPresignedGetUrl(result.storageKey, 60 * 60 * 24 * 7);
        } catch {
          recordingUrl = result.location ?? null;
        }
      }

      await prisma.callSession.update({
        where: { id: call.id },
        data: {
          recordingStatus: 'ready',
          recordingStorageKey: result.storageKey,
          recordingUrl,
          recordingCodec: result.codec,
          recordingFileSize: result.fileSize ?? null,
          recordingDurationSeconds: result.durationSeconds ?? null,
          recordingStartedAt: result.startedAt ?? call.recordingStartedAt,
          recordingEndedAt: result.endedAt ?? new Date(),
          recordingError: null,
          transcriptStatus: 'pending',
        },
      });

      void enqueueCallTranscript({
        callId: call.id,
        workspaceId: call.workspaceId,
      }).catch((err) => console.warn('[calling] enqueue STT', call.id, err));

      return;
    }

    await prisma.callSession.update({
      where: { id: call.id },
      data: {
        recordingStatus: result.status === 'skipped' ? 'skipped' : 'failed',
        recordingError: result.error ?? 'recording_failed',
        recordingEndedAt: new Date(),
        recordingCodec: result.codec,
      },
    });
  } catch (err) {
    console.warn('[calling] completeRecordingJob', call.id, err);
    await prisma.callSession.update({
      where: { id: call.id },
      data: {
        recordingStatus: 'failed',
        recordingError: err instanceof Error ? err.message : 'recording_failed',
        recordingEndedAt: new Date(),
      },
    });
  }
}

/** First agent to accept wins (CAS on status=ringing). */
export async function acceptCall(input: {
  workspaceId: string;
  callId: string;
  userId: string;
}): Promise<CallSession> {
  await expireStaleCallsForWorkspace(input.workspaceId);

  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  if (asStatus(call.status) === 'accepted' || asStatus(call.status) === 'connected') {
    if (call.acceptedByUserId === input.userId) return call;
    throw new CallingError('Call already accepted by another agent', 409, 'call_already_accepted');
  }
  if (asStatus(call.status) !== 'ringing') {
    throw new CallingError(
      `Cannot accept call in status ${call.status}`,
      409,
      'illegal_call_transition'
    );
  }

  const acceptedAt = new Date();
  const cas = await prisma.callSession.updateMany({
    where: { id: call.id, workspaceId: input.workspaceId, status: 'ringing' },
    data: {
      status: 'accepted',
      acceptedByUserId: input.userId,
      acceptedAt,
      assignedTo: call.assignedTo ?? input.userId,
    },
  });
  if (cas.count === 0) {
    throw new CallingError('Call already accepted by another agent', 409, 'call_already_accepted');
  }

  const updated = await prisma.callSession.update({
    where: { id: call.id },
    data: {
      metadata: appendTransition(call.metadata, 'ringing', 'accepted', {
        reason: 'agent_accept',
        byUserId: input.userId,
      }),
    },
  });

  await prisma.callParticipant.upsert({
    where: {
      callSessionId_identity: {
        callSessionId: call.id,
        identity: agentLiveKitIdentity(input.userId),
      },
    },
    create: {
      callSessionId: call.id,
      role: 'agent',
      identity: agentLiveKitIdentity(input.userId),
      userId: input.userId,
    },
    update: { userId: input.userId },
  });

  emitCall(input.workspaceId, CALL_SOCKET_EVENTS.accepted, publicCallPayload(updated));
  return updated;
}

/**
 * Soft decline (P2): assigned agent decline → declined.
 * Unassigned fan-out: record decline, stay ringing until accept/timeout.
 */
export async function declineCall(input: {
  workspaceId: string;
  callId: string;
  userId: string;
}): Promise<CallSession> {
  await expireStaleCallsForWorkspace(input.workspaceId);

  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');
  if (asStatus(call.status) !== 'ringing') {
    throw new CallingError(
      `Cannot decline call in status ${call.status}`,
      409,
      'illegal_call_transition'
    );
  }

  // Assigned to this agent → terminal declined
  if (call.assignedTo && call.assignedTo === input.userId) {
    return finalizeCall(call, 'declined', {
      reason: 'agent_decline',
      byUserId: input.userId,
    });
  }

  if (call.assignedTo && call.assignedTo !== input.userId) {
    throw new CallingError('Call is assigned to another agent', 403, 'forbidden');
  }

  // Unassigned fan-out: soft decline — stay ringing for others
  const prev =
    call.metadata && typeof call.metadata === 'object' && !Array.isArray(call.metadata)
      ? (call.metadata as Record<string, unknown>)
      : {};
  const declinedBy = Array.isArray(prev.declinedBy)
    ? [...(prev.declinedBy as string[])]
    : [];
  if (!declinedBy.includes(input.userId)) declinedBy.push(input.userId);

  const updated = await prisma.callSession.update({
    where: { id: call.id },
    data: {
      metadata: {
        ...prev,
        declinedBy,
        transitions: Array.isArray(prev.transitions) ? prev.transitions : [],
      } as Prisma.InputJsonValue,
    },
  });

  emitCall(input.workspaceId, CALL_SOCKET_EVENTS.declined, {
    ...publicCallPayload(updated),
    declinedByUserId: input.userId,
    soft: true,
  });
  return updated;
}

export async function endCall(input: {
  workspaceId: string;
  callId: string;
  userId: string;
}): Promise<CallSession> {
  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  const status = asStatus(call.status);
  if (status === 'ended' || status === 'missed' || status === 'declined' || status === 'failed') {
    return call;
  }

  if (status === 'ringing') {
    return finalizeCall(call, 'ended', {
      reason: 'cancelled',
      byUserId: input.userId,
    });
  }
  if (status === 'accepted' || status === 'connected' || status === 'initiated') {
    return finalizeCall(call, 'ended', {
      reason: 'hangup',
      byUserId: input.userId,
    });
  }

  throw new CallingError(
    `Cannot end call in status ${call.status}`,
    409,
    'illegal_call_transition'
  );
}

export async function markCallConnected(input: {
  workspaceId: string;
  callId: string;
  userId: string;
}): Promise<CallSession> {
  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  if (asStatus(call.status) === 'connected') return call;
  if (asStatus(call.status) !== 'accepted') {
    throw new CallingError(
      `Cannot mark connected from ${call.status}`,
      409,
      'illegal_call_transition'
    );
  }
  if (call.acceptedByUserId && call.acceptedByUserId !== input.userId) {
    throw new CallingError('Only the accepting agent can mark connected', 403, 'forbidden');
  }

  const connectedAt = new Date();
  const updated = await transitionCall(
    call,
    'connected',
    { connectedAt },
    { reason: 'agent_joined_livekit', byUserId: input.userId }
  );
  emitCall(input.workspaceId, CALL_SOCKET_EVENTS.connected, publicCallPayload(updated));
  return updated;
}

export async function mintAgentCallToken(input: {
  workspaceId: string;
  callId: string;
  userId: string;
  userName?: string;
}) {
  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  const status = asStatus(call.status);
  if (!['ringing', 'accepted', 'connected'].includes(status)) {
    throw new CallingError('Call is not joinable', 409, 'call_not_joinable');
  }

  if (status === 'accepted' || status === 'connected') {
    if (call.acceptedByUserId && call.acceptedByUserId !== input.userId) {
      throw new CallingError('Call accepted by another agent', 403, 'forbidden');
    }
  }

  return mintLiveKitAccessToken({
    roomName: call.roomName,
    identity: agentLiveKitIdentity(input.userId),
    name: input.userName,
    canPublish: true,
    canSubscribe: true,
    metadata: JSON.stringify({ callId: call.id, role: 'agent' }),
  });
}

/** Subscribe-only join while AI is handling the call (no mic publish). */
export async function mintListenInCallToken(input: {
  workspaceId: string;
  callId: string;
  userId: string;
  userName?: string;
}) {
  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  const status = asStatus(call.status);
  if (!['ringing', 'accepted', 'connected'].includes(status)) {
    throw new CallingError('Call is not joinable', 409, 'call_not_joinable');
  }
  if ((call.currentHandler || 'none') !== 'ai') {
    throw new CallingError('Listen-in is only available while AI is on the call', 409, 'not_ai_handler');
  }

  return mintLiveKitAccessToken({
    roomName: call.roomName,
    identity: listenerLiveKitIdentity(input.userId),
    name: input.userName ? `${input.userName} (listening)` : 'Listener',
    canPublish: false,
    canSubscribe: true,
    metadata: JSON.stringify({ callId: call.id, role: 'listener' }),
  });
}

/**
 * Human takes over from AI: update handler, signal Pipecat via LiveKit data,
 * return a publish-capable agent token.
 */
export async function takeOverCall(input: {
  workspaceId: string;
  callId: string;
  userId: string;
  userName?: string;
}): Promise<{
  call: CallSession;
  token: string;
  url: string;
  expiresInSeconds: number;
}> {
  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  const status = asStatus(call.status);
  if (!['ringing', 'accepted', 'connected'].includes(status)) {
    throw new CallingError('Call is not joinable', 409, 'call_not_joinable');
  }
  if ((call.currentHandler || 'none') !== 'ai') {
    throw new CallingError('Call is not handled by AI', 409, 'not_ai_handler');
  }

  const updated = await prisma.callSession.update({
    where: { id: call.id },
    data: {
      currentHandler: 'human',
      takenOverAt: new Date(),
      takenOverByUserId: input.userId,
      acceptedByUserId: call.acceptedByUserId || input.userId,
      acceptedAt: call.acceptedAt || new Date(),
    },
  });

  emitCall(input.workspaceId, CALL_SOCKET_EVENTS.handlerChanged, {
    ...publicCallPayload(updated),
    previousHandler: 'ai',
  });

  // Fire-and-forget LiveKit signal + force-remove (do not block token mint forever)
  void signalAiAgentTakeOver({
    roomName: call.roomName,
    callSessionId: call.id,
  }).catch((err) => console.warn('[calling] take-over signal failed', call.id, err));

  const minted = await mintLiveKitAccessToken({
    roomName: call.roomName,
    identity: agentLiveKitIdentity(input.userId),
    name: input.userName,
    canPublish: true,
    canSubscribe: true,
    metadata: JSON.stringify({ callId: call.id, role: 'agent', takenOver: true }),
  });

  return {
    call: updated,
    token: minted.token,
    url: minted.url,
    expiresInSeconds: minted.expiresInSeconds,
  };
}

export async function getGuestCallSession(guestToken: string) {
  const claims = verifyCallGuestToken(guestToken);
  const call = await prisma.callSession.findFirst({
    where: { id: claims.callId, workspaceId: claims.workspaceId },
    include: {
      contact: { select: { id: true, name: true, phone: true } },
      workspace: { select: { id: true, name: true } },
    },
  });
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');
  if (call.guestTokenJti && call.guestTokenJti !== claims.jti) {
    throw new CallingError('This call link is no longer valid', 401, 'guest_token_revoked');
  }
  if (call.guestTokenExpiresAt && call.guestTokenExpiresAt.getTime() < Date.now()) {
    throw new CallingError('This call link has expired', 401, 'guest_token_expired');
  }
  if (['ended', 'missed', 'declined', 'failed'].includes(call.status)) {
    return {
      call: publicCallPayload(call),
      role: 'customer' as const,
      workspaceName: call.workspace.name,
      contactName: call.contact?.name ?? null,
      ended: true,
    };
  }
  return {
    call: publicCallPayload(call),
    role: 'customer' as const,
    workspaceName: call.workspace.name,
    contactName: call.contact?.name ?? null,
    ended: false,
  };
}

export async function mintGuestCallToken(guestToken: string) {
  const claims = verifyCallGuestToken(guestToken);
  const call = await prisma.callSession.findFirst({
    where: { id: claims.callId, workspaceId: claims.workspaceId },
  });
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');
  if (call.guestTokenJti && call.guestTokenJti !== claims.jti) {
    throw new CallingError('This call link is no longer valid', 401, 'guest_token_revoked');
  }
  if (!['ringing', 'accepted', 'connected'].includes(call.status)) {
    throw new CallingError('Call is not joinable', 409, 'call_not_joinable');
  }

  // First customer Join Call = call actually starts (connected + sockets)
  if (!call.guestJoinedAt) {
    const guestJoinedAt = new Date();
    let current = await prisma.callSession.update({
      where: { id: call.id },
      data: { guestJoinedAt },
    });

    if (asStatus(current.status) === 'ringing') {
      current = await transitionCall(
        current,
        'accepted',
        { acceptedAt: guestJoinedAt },
        { reason: 'customer_joining' }
      );
    }
    if (asStatus(current.status) === 'accepted') {
      current = await transitionCall(
        current,
        'connected',
        { connectedAt: guestJoinedAt },
        { reason: 'customer_joined' }
      );
    }

    const payload = {
      ...publicCallPayload(current),
      role: 'customer' as const,
      contactId: claims.contactId,
    };
    emitCall(current.workspaceId, CALL_SOCKET_EVENTS.participantJoined, payload);
    emitCall(current.workspaceId, CALL_SOCKET_EVENTS.connected, publicCallPayload(current));

    // Start audio recording once the customer is in (room has both sides shortly after)
    if (config.livekit.enabled && !current.recordingEgressId) {
      try {
        const rec = await startCallRecording({
          roomName: current.roomName,
          workspaceId: current.workspaceId,
          callId: current.id,
        });
        current = await prisma.callSession.update({
          where: { id: current.id },
          data: {
            recordingStatus: 'recording',
            recordingEgressId: rec.egressId,
            recordingStorageKey: rec.storageKey,
            recordingStartedAt: new Date(),
            recordingCodec: 'ogg',
          },
        });
        emitCall(current.workspaceId, CALL_SOCKET_EVENTS.connected, {
          ...publicCallPayload(current),
          recordingStarted: true,
        });
      } catch (err) {
        console.warn('[calling] start recording failed', current.id, err);
        await prisma.callSession.update({
          where: { id: current.id },
          data: {
            recordingStatus: 'failed',
            recordingError: err instanceof Error ? err.message : 'recording_start_failed',
          },
        });
      }
    }
  }

  return mintLiveKitAccessToken({
    roomName: call.roomName,
    identity: customerLiveKitIdentity(claims.contactId),
    name: 'Customer',
    canPublish: true,
    canSubscribe: true,
    metadata: JSON.stringify({ callId: call.id, role: 'customer' }),
  });
}

export async function endCallAsGuest(guestToken: string) {
  const claims = verifyCallGuestToken(guestToken);
  const call = await prisma.callSession.findFirst({
    where: { id: claims.callId, workspaceId: claims.workspaceId },
  });
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');
  return finalizeCall(call, 'ended', { reason: 'guest_hangup' });
}

/** Agent: re-issue guest short URL (new jti + short code). */
export async function getOrRefreshGuestUrl(input: {
  workspaceId: string;
  callId: string;
  rotate?: boolean;
}): Promise<{ guestUrl: string; expiresAt: Date }> {
  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');
  if (!call.contactId) {
    throw new CallingError('Call has no contact for guest link', 400, 'no_contact');
  }
  if (['ended', 'missed', 'declined', 'failed'].includes(call.status)) {
    throw new CallingError('Call has ended', 409, 'call_ended');
  }

  if (!input.rotate && call.guestShortCode && call.guestTokenJti && call.guestTokenExpiresAt) {
    if (call.guestTokenExpiresAt.getTime() > Date.now()) {
      return {
        guestUrl: buildCallGuestShortUrl(call.guestShortCode),
        expiresAt: call.guestTokenExpiresAt,
      };
    }
  }

  const signed = signCallGuestToken({
    callId: call.id,
    workspaceId: call.workspaceId,
    contactId: call.contactId,
  });
  const guestShortCode = await allocateGuestShortCode();
  await prisma.callSession.update({
    where: { id: call.id },
    data: {
      guestTokenJti: signed.jti,
      guestTokenExpiresAt: signed.expiresAt,
      guestShortCode,
    },
  });
  return {
    guestUrl: buildCallGuestShortUrl(guestShortCode),
    expiresAt: signed.expiresAt,
  };
}

/** Send (or resend) guest short link via WhatsApp / Instagram / Messenger thread. */
export async function sendGuestCallLinkToConversation(input: {
  workspaceId: string;
  conversationId: string;
  guestUrl: string;
  agentUserId?: string;
}): Promise<boolean> {
  const conv = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    include: { contact: true },
  });
  if (!conv?.contact) return false;

  const agent = input.agentUserId
    ? await prisma.user.findUnique({
        where: { id: input.agentUserId },
        select: { name: true },
      })
    : null;

  const text = `Please join the voice call: ${input.guestUrl}`;
  let waMessageId: string | undefined;

  if (conv.channel === 'instagram') {
    const igUserId = parseInstagramScopedUserId(conv.contact.phone || '');
    if (!igUserId) return false;
    const credentials = await getWorkspaceInstagramCredentials(
      input.workspaceId,
      conv.channelAccountId
    );
    const sent = await sendInstagramMessage(
      credentials.pageId,
      credentials.pageAccessToken,
      igUserId,
      text,
      { instagramUserId: credentials.instagramUserId }
    );
    waMessageId = sent.messageId;
  } else if (conv.channel === 'messenger') {
    const psid = parseMessengerPsid(conv.contact.phone || '');
    if (!psid) return false;
    const credentials = await getWorkspaceMessengerCredentials(
      input.workspaceId,
      conv.channelAccountId
    );
    const sent = await sendMessengerMessage(
      credentials.pageId,
      credentials.pageAccessToken,
      psid,
      text
    );
    waMessageId = sent.messageId;
  } else {
    // WhatsApp (cloud / coexistence)
    if (!conv.contact.phone) return false;
    const credentials = await getWorkspaceWhatsAppCredentials(
      input.workspaceId,
      conv.channelAccountId
    );
    if (!credentials.phoneNumberId) return false;
    const sent = await sendWhatsAppMessage(
      credentials.accessToken,
      credentials.phoneNumberId,
      conv.contact.phone,
      text
    );
    waMessageId = sent.waMessageId;
  }

  const message = await prisma.message.create({
    data: {
      conversationId: conv.id,
      waMessageId,
      sender: 'agent',
      senderName: agent?.name ?? 'Agent',
      content: text,
      status: 'sent',
    },
  });

  await prisma.conversation.updateMany({
    where: { id: conv.id, workspaceId: input.workspaceId },
    data: { lastMessage: text, lastMessageAt: new Date() },
  });

  try {
    getIo().to(input.workspaceId).emit('new_message', {
      conversationId: conv.id,
      message,
    });
  } catch {
    /* ignore */
  }

  return true;
}

export async function resendGuestCallLink(input: {
  workspaceId: string;
  callId: string;
  userId: string;
}): Promise<{ guestUrl: string; sent: boolean }> {
  const { guestUrl } = await getOrRefreshGuestUrl({
    workspaceId: input.workspaceId,
    callId: input.callId,
    rotate: false,
  });
  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call?.conversationId) {
    throw new CallingError('Call has no conversation', 400, 'no_conversation');
  }
  const sent = await sendGuestCallLinkToConversation({
    workspaceId: input.workspaceId,
    conversationId: call.conversationId,
    guestUrl,
    agentUserId: input.userId,
  });
  if (sent) {
    await prisma.callSession.update({
      where: { id: call.id },
      data: { guestLinkSentAt: new Date() },
    });
  }
  return { guestUrl, sent };
}

export async function saveCallAnalytics(input: {
  workspaceId: string;
  callId: string;
  analytics: Record<string, unknown>;
}): Promise<CallSession> {
  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');
  return prisma.callSession.update({
    where: { id: call.id },
    data: { analyticsJson: input.analytics as Prisma.InputJsonValue },
  });
}

/** Agent playback URL for a ready recording. */
export async function getCallRecordingAccess(input: {
  workspaceId: string;
  callId: string;
}): Promise<{
  status: string | null;
  url: string | null;
  codec: string | null;
  durationSeconds: number | null;
  fileSize: number | null;
}> {
  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  let url = call.recordingUrl;
  if (call.recordingStorageKey && isObjectStorageEnabled()) {
    try {
      url = await getPresignedGetUrl(call.recordingStorageKey, 60 * 60);
    } catch {
      /* keep stored url */
    }
  } else if (call.recordingStorageKey && !url) {
    // Local uploads — serve via backend media path if configured later
    url = `${config.backendPublicUrl}/api/calls/${call.id}/recording/file`;
  }

  return {
    status: call.recordingStatus,
    url,
    codec: call.recordingCodec,
    durationSeconds: call.recordingDurationSeconds,
    fileSize: call.recordingFileSize,
  };
}

/** Manual audio upload for STT testing (creates an ended call session on the conversation). */
export async function uploadManualCallRecording(input: {
  workspaceId: string;
  conversationId: string;
  userId: string;
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  /** Whisper language code, or omit for env default / auto */
  language?: string;
}): Promise<CallSession> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    select: { id: true, contactId: true },
  });
  if (!conversation) {
    throw new CallingError('Conversation not found', 404, 'conversation_not_found');
  }

  const mime = (input.mimeType || 'audio/mpeg').toLowerCase();
  const allowed = new Set([
    'audio/ogg',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/webm',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/aac',
    'audio/flac',
    'video/webm', // some browsers label webm audio this way
  ]);
  if (!allowed.has(mime) && !mime.startsWith('audio/')) {
    throw new CallingError('Only audio files are allowed', 400, 'invalid_audio_type');
  }

  const extFromName = input.fileName?.includes('.')
    ? input.fileName.split('.').pop()!.toLowerCase()
    : '';
  const extFromMime: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'video/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
  };
  const ext = (extFromName && /^[a-z0-9]+$/.test(extFromName) ? extFromName : null) ||
    extFromMime[mime] ||
    'mp3';

  const now = new Date();
  const provisional = await prisma.callSession.create({
    data: {
      workspaceId: input.workspaceId,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      direction: 'outbound',
      status: 'ended',
      roomName: `manual_${input.workspaceId}_${Date.now()}`,
      initiatedByUserId: input.userId,
      endedAt: now,
      endReason: 'manual_upload',
      durationSeconds: null,
      metadata: {
        transitions: [
          {
            at: now.toISOString(),
            from: 'ended',
            to: 'ended',
            reason: 'manual_recording_upload',
            byUserId: input.userId,
          },
        ],
      },
    },
  });

  const storageKey = callRecordingStorageKey(input.workspaceId, provisional.id, ext);
  await putObject(storageKey, input.buffer, mime.startsWith('audio/') ? mime : 'audio/mpeg');

  let recordingUrl: string | null = null;
  if (isObjectStorageEnabled()) {
    try {
      recordingUrl = await getPresignedGetUrl(storageKey, 60 * 60 * 24 * 7);
    } catch {
      recordingUrl = null;
    }
  } else {
    recordingUrl = `${config.backendPublicUrl}/api/calls/${provisional.id}/recording/file`;
  }

  const call = await prisma.callSession.update({
    where: { id: provisional.id },
    data: {
      roomName: buildCallRoomName(input.workspaceId, provisional.id),
      recordingStatus: 'ready',
      recordingStorageKey: storageKey,
      recordingUrl,
      recordingCodec: ext,
      recordingFileSize: input.buffer.length,
      recordingStartedAt: now,
      recordingEndedAt: now,
      transcriptStatus: 'pending',
    },
  });

  void enqueueCallTranscript({
    callId: call.id,
    workspaceId: call.workspaceId,
    language: input.language,
  }).catch((err) => console.warn('[calling] enqueue STT after upload', call.id, err));

  return call;
}

/** Delete stored recording file + clear metadata (call session kept). */
export async function deleteCallRecording(input: {
  workspaceId: string;
  callId: string;
}): Promise<CallSession> {
  const call = await getCallForWorkspace(input.workspaceId, input.callId);
  if (!call) throw new CallingError('Call not found', 404, 'call_not_found');

  if (call.recordingStatus === 'recording' || call.recordingStatus === 'processing') {
    throw new CallingError(
      'Recording is still in progress — end the call first',
      409,
      'recording_in_progress'
    );
  }

  if (call.recordingStorageKey) {
    try {
      await deleteObject(call.recordingStorageKey);
    } catch (err) {
      console.warn('[calling] delete recording object', call.id, err);
    }
  }

  return prisma.callSession.update({
    where: { id: call.id },
    data: {
      recordingStatus: null,
      recordingEgressId: null,
      recordingStorageKey: null,
      recordingUrl: null,
      recordingStartedAt: null,
      recordingEndedAt: null,
      recordingDurationSeconds: null,
      recordingCodec: null,
      recordingFileSize: null,
      recordingError: null,
      transcriptStatus: null,
      transcriptText: null,
      transcriptJson: PrismaNS.DbNull,
      transcriptLanguage: null,
      transcriptError: null,
      transcriptAt: null,
    },
  });
}

/** Public: resolve /c/{code} → full call URL with token. */
export async function resolveGuestShortCode(code: string): Promise<{
  callId: string;
  redirectUrl: string;
}> {
  const normalized = code.trim();
  if (!normalized || normalized.length > 32) {
    throw new CallingError('Invalid link', 400, 'short_code_invalid');
  }

  const call = await prisma.callSession.findFirst({
    where: { guestShortCode: normalized },
  });
  if (!call) throw new CallingError('This call link is invalid', 404, 'short_code_not_found');
  if (!call.contactId || !call.guestTokenJti || !call.guestTokenExpiresAt) {
    throw new CallingError('This call link is invalid', 404, 'short_code_not_found');
  }
  if (call.guestTokenExpiresAt.getTime() < Date.now()) {
    throw new CallingError('This call link has expired', 401, 'guest_token_expired');
  }
  if (['ended', 'missed', 'declined', 'failed'].includes(call.status)) {
    throw new CallingError('This call has ended', 409, 'call_ended');
  }

  const signed = signCallGuestToken({
    callId: call.id,
    workspaceId: call.workspaceId,
    contactId: call.contactId,
    jti: call.guestTokenJti,
    expiresAt: call.guestTokenExpiresAt,
  });

  return {
    callId: call.id,
    redirectUrl: buildCallGuestUrl(call.id, signed.token),
  };
}

export async function expireStaleCallsForWorkspace(workspaceId?: string): Promise<number> {
  const now = new Date();
  const whereRing: Prisma.CallSessionWhereInput = {
    status: 'ringing',
    ringingUntil: { lt: now },
    ...(workspaceId ? { workspaceId } : {}),
  };
  const staleRinging = await prisma.callSession.findMany({ where: whereRing, take: 50 });
  let n = 0;
  for (const call of staleRinging) {
    await finalizeCall(call, 'missed', { reason: 'ring_timeout' });
    n += 1;
  }

  // Only timeout accepted calls if guest already joined but media never connected
  const graceMs = config.livekit.acceptJoinGraceSeconds * 1000;
  const acceptDeadline = new Date(now.getTime() - graceMs);
  const staleAccepted = await prisma.callSession.findMany({
    where: {
      status: 'accepted',
      guestJoinedAt: { not: null },
      acceptedAt: { lt: acceptDeadline },
      ...(workspaceId ? { workspaceId } : {}),
    },
    take: 50,
  });
  for (const call of staleAccepted) {
    await finalizeCall(call, 'missed', { reason: 'accept_timeout' });
    n += 1;
  }

  // Guest link expired while still waiting (never joined)
  const staleGuestWait = await prisma.callSession.findMany({
    where: {
      status: { in: ['accepted', 'ringing'] },
      guestJoinedAt: null,
      guestTokenExpiresAt: { lt: now },
      ...(workspaceId ? { workspaceId } : {}),
    },
    take: 50,
  });
  for (const call of staleGuestWait) {
    await finalizeCall(call, 'missed', { reason: 'guest_link_expired' });
    n += 1;
  }

  // Stuck recording finalize (hangup already done)
  const stuckRec = await prisma.callSession.findMany({
    where: {
      recordingStatus: 'processing',
      recordingEgressId: { not: null },
      endedAt: { lt: new Date(now.getTime() - 15_000) },
      ...(workspaceId ? { workspaceId } : {}),
    },
    take: 20,
  });
  for (const call of stuckRec) {
    void completeRecordingJob(call).catch((err) => {
      console.warn('[calling] sweeper recording', call.id, err);
    });
  }

  return n;
}

export { publicCallPayload };
