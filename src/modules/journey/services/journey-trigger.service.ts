import type { JourneyRepository } from '../repositories/journey.repository.js';
import type { JourneyExecutionRepository } from '../repositories/journey-execution.repository.js';
import type { JourneyEngine } from './journey-engine.service.js';
import type { JourneyTriggerPayload, ExecutionWaitContext, TriggerNodeData } from '../types/journey.types.js';
import { eventBus } from '../events/event-bus.js';
import { prisma } from '../../../index.js';

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

    if (!replyText.trim()) return;

    const waiting = await this.executionRepo.findWaitingForReply(
      input.workspaceId,
      input.contactId
    );

    for (const execution of waiting) {
      const ctx = (execution.context ?? {}) as ExecutionWaitContext;
      if (ctx.waitKind !== 'reply' || !ctx.nextNodeId) continue;

      await this.engine.resumeAfterReply(execution.id, replyText.trim(), ctx.nextNodeId);
      break;
    }
  }

  async handleEvent(input: JourneyTriggerPayload): Promise<void> {
    const conversation = await prisma.conversation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        status: { not: 'resolved' },
      },
      orderBy: { lastMessageAt: 'desc' },
      select: { assigneeType: true, assigneeId: true },
    });

    if (!conversation || conversation.assigneeType !== 'journey' || !conversation.assigneeId) {
      return;
    }

    const journey = await this.journeyRepo.findPublishedById(
      input.workspaceId,
      conversation.assigneeId
    );
    if (!journey) return;

    await this.startJourneyExecution(journey, input);
  }

  /** Start a specific published journey for a contact (inbox assignment). */
  async startAssignedJourney(
    workspaceId: string,
    journeyId: string,
    contactId: string
  ): Promise<void> {
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
    });
  }

  private async startJourneyExecution(
    journey: Awaited<ReturnType<JourneyRepository['findPublishedById']>>,
    input: JourneyTriggerPayload
  ): Promise<void> {
    if (!journey) return;

    const triggerNode = journey.nodes.find((n) => {
      if (n.type !== 'TRIGGER') return false;
      if (input.event === 'manual.assigned') return true;
      const data = n.data as TriggerNodeData;
      return data.event === input.event;
    });
    if (!triggerNode) return;

    const existing = await this.executionRepo.findActiveForContact(journey.id, input.contactId);
    if (existing) return;

    const startKey = `${journey.id}:${input.contactId}`;
    if (JourneyTriggerService.startingExecutions.has(startKey)) return;
    JourneyTriggerService.startingExecutions.add(startKey);

    try {
      const execution = await this.executionRepo.create({
        journeyId: journey.id,
        contactId: input.contactId,
        currentNodeId: triggerNode.id,
        context: {
          triggerEvent: input.event,
          triggerPayload: input.payload ?? {},
        },
      });

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
