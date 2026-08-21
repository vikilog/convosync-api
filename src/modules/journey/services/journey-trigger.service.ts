import { Prisma } from '@prisma/client';
import type { JourneyRepository } from '../repositories/journey.repository.js';
import type { JourneyExecutionRepository } from '../repositories/journey-execution.repository.js';
import type { JourneyEngine } from './journey-engine.service.js';
import type { JourneyTriggerPayload, ExecutionWaitContext, TriggerNodeData } from '../types/journey.types.js';
import { eventBus } from '../events/event-bus.js';
import { prisma } from '../../../index.js';
import {
  assertJourneyTriggerAffordable,
  chargeJourneyTriggerUsage,
} from '../../../services/walletUsage.js';
import { InsufficientWalletBalanceError } from '../../../services/wallet.service.js';
import { isWorkspaceAutomationsPaused } from '../../../services/workspaceAutomationSettings.service.js';

function resolveInboundChannel(
  payload: Record<string, unknown> | undefined,
  conversationChannel: string | null | undefined
): string | null {
  const fromPayload = payload?.channel;
  if (fromPayload === 'whatsapp' || fromPayload === 'instagram' || fromPayload === 'messenger') {
    return fromPayload;
  }
  if (
    conversationChannel === 'whatsapp' ||
    conversationChannel === 'instagram' ||
    conversationChannel === 'messenger'
  ) {
    return conversationChannel;
  }
  return conversationChannel?.trim() || null;
}

export class JourneyTriggerService {
  private static listenersRegistered = false;
  private static startingExecutions = new Set<string>();

  constructor(
    private readonly journeyRepo: JourneyRepository,
    private readonly executionRepo: JourneyExecutionRepository,
    private readonly engine: JourneyEngine
  ) {
    if (JourneyTriggerService.listenersRegistered) return;
    JourneyTriggerService.listenersRegistered = true;

    eventBus.on<JourneyTriggerPayload>('contact.created', (payload) =>
      this.handleEvent(payload)
    );
    eventBus.on<JourneyTriggerPayload>('contact.tag_added', (payload) =>
      this.handleEvent(payload)
    );
    eventBus.on<JourneyTriggerPayload>('message.received', (payload) =>
      this.handleMessageReceived(payload)
    );
  }

  private async handleMessageReceived(input: JourneyTriggerPayload): Promise<void> {
    if (await isWorkspaceAutomationsPaused(input.workspaceId)) return;
    await this.resumeWaitingReplies(input);
    await this.handleEvent(input);
  }

  private async resumeWaitingReplies(input: JourneyTriggerPayload): Promise<void> {
    const replyText =
      typeof input.payload?.text === 'string'
        ? input.payload.text
        : typeof input.payload?.message === 'string'
          ? input.payload.message
          : '';
    const buttonPayload =
      typeof input.payload?.buttonPayload === 'string'
        ? input.payload.buttonPayload.trim()
        : '';
    const messageId =
      typeof input.payload?.messageId === 'string' ? input.payload.messageId : undefined;
    const flowResponseFields =
      input.payload?.flowResponseFields &&
      typeof input.payload.flowResponseFields === 'object' &&
      !Array.isArray(input.payload.flowResponseFields)
        ? (input.payload.flowResponseFields as Record<string, unknown>)
        : undefined;

    if (!replyText.trim() && !buttonPayload && !flowResponseFields) return;

    const waiting = await this.executionRepo.findWaitingForReply(
      input.workspaceId,
      input.contactId
    );

    for (const execution of waiting) {
      const ctx = (execution.context ?? {}) as ExecutionWaitContext;

      if (ctx.waitKind === 'flow' && ctx.nextNodeId) {
        if (!flowResponseFields) continue;
        await this.engine.resumeAfterReply(
          execution.id,
          'Flow completed',
          ctx.nextNodeId,
          messageId,
          { flowFields: flowResponseFields }
        );
        break;
      }

      if (ctx.waitKind === 'button' && execution.currentNodeId) {
        const node = await this.journeyRepo.getNodeWithEdges(
          execution.journeyId,
          execution.currentNodeId
        );
        if (!node || node.type !== 'BUTTONS') continue;
        const matchKey = (buttonPayload || replyText).trim().toLowerCase();
        const edge =
          node.outgoingEdges.find(
            (e) => e.conditionValue && e.conditionValue.toLowerCase() === matchKey
          ) ??
          node.outgoingEdges.find((e) => {
            const data = node.data as { buttons?: Array<{ id?: string; title?: string }> };
            const btn = (data.buttons ?? []).find(
              (b) =>
                String(b.id ?? '').toLowerCase() === matchKey ||
                String(b.title ?? '').toLowerCase() === matchKey
            );
            return btn && e.conditionValue === btn.id;
          });
        if (!edge) continue;
        await this.engine.resumeAfterReply(
          execution.id,
          replyText.trim() || buttonPayload,
          edge.targetNodeId,
          messageId
        );
        break;
      }

      if (ctx.waitKind !== 'reply' || !ctx.nextNodeId) continue;

      await this.engine.resumeAfterReply(execution.id, replyText.trim(), ctx.nextNodeId, messageId);
      break;
    }
  }

  async handleEvent(input: JourneyTriggerPayload): Promise<void> {
    if (await isWorkspaceAutomationsPaused(input.workspaceId)) return;

    const conversation = await prisma.conversation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        status: { not: 'resolved' },
      },
      orderBy: { lastMessageAt: 'desc' },
      select: { assigneeType: true, assigneeId: true, channel: true },
    });

    if (!conversation || conversation.assigneeType !== 'journey' || !conversation.assigneeId) {
      return;
    }

    const journey = await this.journeyRepo.findPublishedById(
      input.workspaceId,
      conversation.assigneeId
    );
    if (!journey) return;

    const channel = resolveInboundChannel(input.payload, conversation.channel);
    // WhatsApp journeys only — Instagram has its own InstagramJourney system
    if (input.event === 'message.received' && channel && channel !== 'whatsapp') {
      return;
    }
    await this.startJourneyExecution(journey, input, channel);
  }

  /** Start a specific published journey for a contact (inbox assignment). */
  async startAssignedJourney(
    workspaceId: string,
    journeyId: string,
    contactId: string
  ): Promise<void> {
    if (await isWorkspaceAutomationsPaused(workspaceId)) return;
    const journey = await this.journeyRepo.findPublishedById(workspaceId, journeyId);
    if (!journey) return;

    const existing = await this.executionRepo.findActiveForContact(journeyId, contactId);
    if (existing) {
      await this.executionRepo.updateProgress(existing.id, { status: 'cancelled' });
    }

    await this.startJourneyExecution(journey, {
      workspaceId,
      event: 'manual.assigned',
      contactId,
      payload: { source: 'inbox_assignment' },
    }, null);
  }

  private async startJourneyExecution(
    journey: Awaited<ReturnType<JourneyRepository['findPublishedById']>>,
    input: JourneyTriggerPayload,
    channel: string | null = null
  ): Promise<void> {
    if (!journey) return;

    const triggerNode = journey.nodes.find((n) => {
      if (n.type !== 'TRIGGER') return false;
      if (input.event === 'manual.assigned') return true;
      const data = n.data as TriggerNodeData;
      if (data.event !== input.event) return false;
      // WhatsApp-only: ignore multi-channel filter leftovers; channel already gated above
      if (input.event === 'message.received' && channel && channel !== 'whatsapp') {
        return false;
      }
      return true;
    });
    if (!triggerNode) return;

    const existing = await this.executionRepo.findActiveForContact(journey.id, input.contactId);
    if (existing) return;

    const startKey = `${journey.id}:${input.contactId}`;
    if (JourneyTriggerService.startingExecutions.has(startKey)) return;
    JourneyTriggerService.startingExecutions.add(startKey);

    try {
      try {
        await assertJourneyTriggerAffordable(input.workspaceId);
      } catch (err) {
        if (err instanceof InsufficientWalletBalanceError) {
          console.warn('[wallet] Journey trigger blocked — insufficient balance', {
            workspaceId: input.workspaceId,
            journeyId: journey.id,
          });
          return;
        }
        throw err;
      }

      let execution: Awaited<ReturnType<JourneyExecutionRepository['create']>>;
      try {
        execution = await this.executionRepo.create({
          journeyId: journey.id,
          contactId: input.contactId,
          currentNodeId: triggerNode.id,
          context: {
            triggerEvent: input.event,
            triggerPayload: input.payload ?? {},
          },
        });
      } catch (err) {
        // The in-memory Set above only guards same-process races; the DB's
        // partial unique index (journeyId, contactId) WHERE status IN
        // ('running','waiting') is the real cross-process/cross-replica
        // backstop against double-enrolling this contact.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return;
        }
        throw err;
      }

      try {
        await chargeJourneyTriggerUsage({
          workspaceId: input.workspaceId,
          referenceId: execution.id,
        });
      } catch (err) {
        console.error('[wallet] Journey trigger debit failed', err);
      }

      await this.engine.executeNode(execution.id, triggerNode.id);
    } finally {
      JourneyTriggerService.startingExecutions.delete(startKey);
    }
  }

  async triggerManual(
    workspaceId: string,
    event: string,
    contactId: string,
    payload?: Record<string, unknown>
  ) {
    await this.handleEvent({ workspaceId, event, contactId, payload });
    return { ok: true };
  }
}

export function registerJourneyTriggerHandlers(triggerService: JourneyTriggerService): void {
  void triggerService;
}
