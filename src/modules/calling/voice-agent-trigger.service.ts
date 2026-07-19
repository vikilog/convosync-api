/**
 * Fire-and-forget trigger for Pipecat voice agent when a call link is created.
 * Only runs if the conversation is assigned to an AiAgent with voiceAgentEnabled.
 */
import type { CallSession } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config.js';
import {
  aiVoiceAgentLiveKitIdentity,
  isLiveKitConfigured,
  mintLiveKitAccessToken,
} from './livekit.service.js';
import { CALL_SOCKET_EVENTS } from './calling.types.js';

type ConversationForVoice = {
  id: string;
  contactId: string | null;
  assigneeType: string | null;
  assigneeId: string | null;
};

export type VoiceAgentCandidate = {
  id: string;
  name: string;
  voiceSttProvider: string;
};

/** Sync check used at call-create so CallPage gets currentHandler=ai before open. */
export async function findVoiceAgentForConversation(
  workspaceId: string,
  conversation: ConversationForVoice
): Promise<VoiceAgentCandidate | null> {
  if (!config.voiceAgent.serviceUrl) return null;
  if (!isLiveKitConfigured()) return null;
  if (!conversation.contactId) return null;
  if (conversation.assigneeType !== 'ai_agent' || !conversation.assigneeId) return null;

  const agent = await prisma.aiAgent.findFirst({
    where: {
      id: conversation.assigneeId,
      workspaceId,
      voiceAgentEnabled: true,
    },
    select: { id: true, name: true, voiceSttProvider: true },
  });
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    voiceSttProvider: agent.voiceSttProvider || 'cartesia',
  };
}

function emitHandler(workspaceId: string, callId: string, currentHandler: string) {
  try {
    void import('../../socket.js').then(({ getIo }) => {
      getIo().to(workspaceId).emit(CALL_SOCKET_EVENTS.handlerChanged, {
        callId,
        workspaceId,
        currentHandler,
      });
    });
  } catch {
    /* ignore */
  }
}

export async function maybeStartVoiceAgentForCall(
  call: CallSession,
  conversation: ConversationForVoice,
  prefetchedAgent?: VoiceAgentCandidate | null
): Promise<void> {
  const agent =
    prefetchedAgent === undefined
      ? await findVoiceAgentForConversation(call.workspaceId, conversation)
      : prefetchedAgent;
  if (!agent) return;
  if (!conversation.contactId) return;

  let livekitToken: string;
  try {
    const minted = await mintLiveKitAccessToken({
      roomName: call.roomName,
      identity: aiVoiceAgentLiveKitIdentity(),
      name: agent.name || 'AI Agent',
      canPublish: true,
      canSubscribe: true,
      metadata: JSON.stringify({ role: 'ai_voice_agent', agentId: agent.id }),
    });
    livekitToken = minted.token;
  } catch (err) {
    console.warn('[calling] voice agent LiveKit token failed', call.id, err);
    await prisma.callSession.update({
      where: { id: call.id },
      data: { currentHandler: 'none' },
    });
    emitHandler(call.workspaceId, call.id, 'none');
    return;
  }

  const url = `${config.voiceAgent.serviceUrl}/start-agent`;
  const body = {
    roomName: call.roomName,
    livekitToken,
    workspaceId: call.workspaceId,
    contactId: conversation.contactId,
    conversationId: conversation.id,
    callSessionId: call.id,
    livekitUrl: config.livekit.url || undefined,
    sttProvider: agent.voiceSttProvider || 'cartesia',
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.voiceAgent.internalSecret) {
    headers['X-ConvoSync-Internal'] = config.voiceAgent.internalSecret;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.voiceAgent.startTimeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        '[calling] voice agent start-agent non-OK',
        call.id,
        res.status,
        text.slice(0, 200)
      );
      await prisma.callSession.update({
        where: { id: call.id },
        data: { currentHandler: 'none' },
      });
      emitHandler(call.workspaceId, call.id, 'none');
      return;
    }

    if (call.currentHandler !== 'ai') {
      await prisma.callSession.update({
        where: { id: call.id },
        data: { currentHandler: 'ai' },
      });
      emitHandler(call.workspaceId, call.id, 'ai');
    }
  } catch (err) {
    console.warn('[calling] voice agent start-agent failed', call.id, err);
    await prisma.callSession.update({
      where: { id: call.id },
      data: { currentHandler: 'none' },
    });
    emitHandler(call.workspaceId, call.id, 'none');
  } finally {
    clearTimeout(timer);
  }
}
