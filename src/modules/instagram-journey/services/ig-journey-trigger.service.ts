import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { isWorkspaceAutomationsPaused } from '../../../services/workspaceAutomationSettings.service.js';
import { isContactAutomationsPaused } from '../../../services/contactAutomationSettings.service.js';
import type { InstagramJourneyRepository } from '../repositories/ig-journey.repository.js';
import type { InstagramJourneyExecutionRepository } from '../repositories/ig-journey-execution.repository.js';
import type { InstagramJourneyEngine } from './ig-journey-engine.service.js';
import type {
  IgExecutionWaitContext,
  IgJourneyTriggerPayload,
  IgTriggerNodeData,
} from '../types/ig-journey.types.js';
import { matchesKeyword, triggerAllowsEvent } from '../types/ig-journey.types.js';

export class InstagramJourneyTriggerService {
  private static starting = new Set<string>();

  constructor(
    private readonly journeyRepo: InstagramJourneyRepository,
    private readonly executionRepo: InstagramJourneyExecutionRepository,
    private readonly engine: InstagramJourneyEngine
  ) {}

  /** DM inbound: resume waiting Ask Question, then match assigned / keyword journeys. */
  async handleDmReceived(input: IgJourneyTriggerPayload): Promise<void> {
    if (await isWorkspaceAutomationsPaused(input.workspaceId)) return;
    if (await isContactAutomationsPaused(input.contactId)) return;

    // This DM already answered a running flow — don't also treat it as a fresh trigger.
    const resumed = await this.resumeWaitingReplies(input);
    if (resumed) return;

    const assigned = await prisma.conversation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        channel: 'instagram',
        status: { not: 'resolved' },
        assigneeType: 'journey',
        assigneeId: { not: null },
      },
      orderBy: { lastMessageAt: 'desc' },
      select: { assigneeId: true },
    });

    if (assigned?.assigneeId) {
      // Inbox-assigned Instagram automation — don't also keyword-fanout other flows
      await this.startPublishedJourney(
        input.workspaceId,
        assigned.assigneeId,
        input.contactId,
        { restart: false }
      );
      return;
    }

    await this.matchAndStart(input);
  }

  /**
   * Resume Ask Question waits only (no journey start).
   * Used when sync/webhook race already saved the message (duplicate mid).
   */
  async resumeWaitingRepliesOnly(input: IgJourneyTriggerPayload): Promise<void> {
    await this.resumeWaitingReplies(input);
  }

  /**
   * Safety net: if Ask Question is waiting but a newer contact DM already exists
   * (missed webhook / mis-routed Meta payload), resume from that reply.
   */
  async recoverWaitingFromRecentReplies(
    workspaceId: string,
    contactId: string
  ): Promise<boolean> {
    const waiting = await this.executionRepo.findWaitingForReply(workspaceId, contactId);
    for (const execution of waiting) {
      const ctx = (execution.context ?? {}) as IgExecutionWaitContext;
      if (ctx.waitKind === 'delay') continue;

      const waitStartedAt = execution.lastExecutedAt ?? execution.startedAt;
      const reply = await prisma.message.findFirst({
        where: {
          sender: 'contact',
          createdAt: { gt: waitStartedAt },
          conversation: { workspaceId, contactId, channel: 'instagram' },
          ...(ctx.resumeMessageId ? { NOT: { waMessageId: ctx.resumeMessageId } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        select: { content: true, waMessageId: true },
      });
      const text = reply?.content?.trim();
      if (!reply || !text) continue;

      await this.resumeWaitingReplies({
        workspaceId,
        event: 'dm.received',
        contactId,
        text,
        payload: {
          messageId: reply.waMessageId ?? undefined,
          source: 'inbox_recover',
        },
      });
      return true;
    }
    return false;
  }

  /** Comment inbound: match published comment.received journeys (no reply-wait). */
  async handleCommentReceived(input: IgJourneyTriggerPayload): Promise<void> {
    if (await isWorkspaceAutomationsPaused(input.workspaceId)) return;
    if (await isContactAutomationsPaused(input.contactId)) return;
    await this.matchAndStart(input);
  }

  /**
   * Start a specific published IG journey.
   * @param restart — cancel active run first (inbox re-assign / nested TRIGGER_JOURNEY).
   */
  async startPublishedJourney(
    workspaceId: string,
    journeyId: string,
    contactId: string,
    opts: { restart?: boolean } = {}
  ): Promise<void> {
    if (await isWorkspaceAutomationsPaused(workspaceId)) return;
    if (await isContactAutomationsPaused(contactId)) return;
    const restart = opts.restart ?? true;
    const journeys = await this.journeyRepo.findPublishedWithNodes(workspaceId);
    const journey = journeys.find((j) => j.id === journeyId);
    if (!journey) return;

    const triggerNode = journey.nodes.find((n) => n.type === 'TRIGGER');
    if (!triggerNode) return;

    const existing = await this.executionRepo.findActiveForContact(journeyId, contactId);
    if (existing) {
      if (!restart) return;
      await this.executionRepo.updateProgress(existing.id, { status: 'cancelled' });
    }

    const startKey = `${journeyId}:${contactId}`;
    if (InstagramJourneyTriggerService.starting.has(startKey)) return;
    InstagramJourneyTriggerService.starting.add(startKey);
    try {
      let execution: Awaited<ReturnType<InstagramJourneyExecutionRepository['create']>>;
      try {
        execution = await this.executionRepo.create({
          journeyId,
          contactId,
          currentNodeId: triggerNode.id,
          context: {
            triggerEvent: restart ? 'manual.assigned' : 'dm.received',
            triggerPayload: { source: restart ? 'inbox_assignment' : 'assigned_inbound' },
            triggerText: '',
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
      await this.engine.executeNode(execution.id, triggerNode.id);
    } finally {
      InstagramJourneyTriggerService.starting.delete(startKey);
    }
  }

  /** @returns true if this message advanced a waiting execution (i.e. it was a reply, not a fresh trigger). */
  private async resumeWaitingReplies(input: IgJourneyTriggerPayload): Promise<boolean> {
    const replyText = input.text?.trim();
    if (!replyText) return false;

    const messageId =
      typeof input.payload?.messageId === 'string' ? input.payload.messageId : undefined;
    const buttonPayload =
      typeof input.payload?.buttonPayload === 'string'
        ? input.payload.buttonPayload.trim()
        : typeof input.payload?.quickReplyPayload === 'string'
          ? input.payload.quickReplyPayload.trim()
          : '';

    const waiting = await this.executionRepo.findWaitingForReply(
      input.workspaceId,
      input.contactId
    );

    for (const execution of waiting) {
      const ctx = (execution.context ?? {}) as IgExecutionWaitContext;
      if (ctx.waitKind === 'delay') continue;

      // Idempotent: same webhook/sync mid must not advance a later Ask Question
      if (messageId && ctx.resumeMessageId === messageId) continue;

      if (ctx.waitKind === 'button' && execution.currentNodeId) {
        const node = await this.journeyRepo.getNodeWithEdges(
          execution.journeyId,
          execution.currentNodeId
        );
        if (!node || node.type !== 'BUTTONS') continue;
        const matchKey = (buttonPayload || replyText).toLowerCase();
        const data = node.data as { buttons?: Array<{ id?: string; title?: string }> };
        // Prefer payload/title match; single-button graphs often store the only edge with null handle.
        const edge =
          node.outgoingEdges.find(
            (e) => e.conditionValue && e.conditionValue.toLowerCase() === matchKey
          ) ??
          node.outgoingEdges.find((e) => {
            const btn = (data.buttons ?? []).find(
              (b) =>
                String(b.id ?? '').toLowerCase() === matchKey ||
                String(b.title ?? '').toLowerCase() === matchKey
            );
            return Boolean(btn && e.conditionValue === btn.id);
          }) ??
          (node.outgoingEdges.length === 1 ? node.outgoingEdges[0] : undefined);
        if (!edge) continue;
        await this.engine.resumeAfterReply(execution.id, replyText, edge.targetNodeId, messageId);
        return true;
      }

      let nextNodeId = ctx.waitKind === 'reply' ? ctx.nextNodeId : undefined;
      if (!nextNodeId && execution.currentNodeId) {
        const node = await this.journeyRepo.getNodeWithEdges(
          execution.journeyId,
          execution.currentNodeId
        );
        if (node?.type === 'ASK_QUESTION') {
          const edge =
            node.outgoingEdges.find(
              (e) => e.conditionValue === 'default' || e.conditionValue == null
            ) ?? node.outgoingEdges[0];
          nextNodeId = edge?.targetNodeId;
        }
      }
      if (!nextNodeId) continue;

      await this.engine.resumeAfterReply(execution.id, replyText, nextNodeId, messageId);
      return true;
    }

    return false;
  }

  private async matchAndStart(input: IgJourneyTriggerPayload): Promise<void> {
    // One automation owns a chat at a time — don't fan out into a second journey
    // (or re-trigger the same one) while this contact already has an active run,
    // whether it started from a DM or a comment/post.
    const alreadyActive = await this.executionRepo.findAnyActiveForContact(
      input.workspaceId,
      input.contactId
    );
    if (alreadyActive) return;

    const journeys = await this.journeyRepo.findPublishedWithNodes(input.workspaceId);

    for (const journey of journeys) {
      const triggerNode = journey.nodes.find((n) => {
        if (n.type !== 'TRIGGER') return false;
        const data = n.data as IgTriggerNodeData;
        if (!triggerAllowsEvent(data, input.event)) return false;
        return matchesKeyword(input.text, data.keyword);
      });
      if (!triggerNode) continue;

      const startKey = `${journey.id}:${input.contactId}`;
      if (InstagramJourneyTriggerService.starting.has(startKey)) continue;

      const existing = await this.executionRepo.findActiveForContact(
        journey.id,
        input.contactId
      );
      if (existing) continue;

      InstagramJourneyTriggerService.starting.add(startKey);
      try {
        let execution: Awaited<ReturnType<InstagramJourneyExecutionRepository['create']>>;
        try {
          execution = await this.executionRepo.create({
            journeyId: journey.id,
            contactId: input.contactId,
            currentNodeId: triggerNode.id,
            context: {
              triggerEvent: input.event,
              triggerPayload: input.payload ?? {},
              triggerText: input.text,
            },
          });
        } catch (err) {
          // Same-process races are caught by the Set above; the DB's partial
          // unique index is the cross-process/cross-replica backstop.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            continue;
          }
          throw err;
        }
        await this.engine.executeNode(execution.id, triggerNode.id);
      } finally {
        InstagramJourneyTriggerService.starting.delete(startKey);
      }
    }
  }
}
