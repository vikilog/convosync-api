import { prisma } from '../../../lib/prisma.js';
import { renderTemplateVariables } from '../../journey/services/message-renderer.service.js';
import {
  assignContactConversation,
  closeContactConversation,
  mergeContactCustomFields,
  openContactConversation,
  updateContactField,
} from '../../journey/services/journey-contact-actions.service.js';
import {
  evaluateCondition,
  pickBranchEdge,
} from '../../journey/services/condition-evaluator.service.js';
import {
  normalizeRandomizerPaths,
  pickWeightedEdge,
} from '../../journey/services/randomizer.service.js';
import {
  normalizeBusinessHours,
  resolveWaitMs,
} from '../../journey/services/businessHours.service.js';
import { executeWebhookNode } from '../../journey/services/webhook-executor.service.js';
import { upsertLeadForContact } from '../../../services/lead.service.js';
import { registerWorkspaceTags } from '../../../services/workspaceTags.service.js';
import { checkInstagramFollowsBusiness } from '../../../services/instagramFollowCheck.service.js';
import { getContactActivity, getWorkspaceTimezone } from '../../journey/services/contact-activity.service.js';
import {
  GOTO_STEP_MAX_HOPS,
  MAX_SYNC_EXECUTION_STEPS,
  type ConditionNodeData,
  type WebhookNodeData,
} from '../../journey/types/journey.types.js';
import type { InstagramJourneyRepository } from '../repositories/ig-journey.repository.js';
import type { InstagramJourneyExecutionRepository } from '../repositories/ig-journey-execution.repository.js';
import type { InstagramMessagingProvider } from '../providers/instagram.messaging.provider.js';
import { igDelayMs, scheduleIgJourneyDelay } from '../queue/ig-journey.queue.js';
import type {
  IgAddToFunnelNodeData,
  IgAskQuestionNodeData,
  IgAssignToNodeData,
  IgButtonsNodeData,
  IgCardElement,
  IgCloseConversationNodeData,
  IgExecutionWaitContext,
  IgGotoStepNodeData,
  IgRandomizerNodeData,
  IgSendMessageNodeData,
  IgTriggerJourneyNodeData,
  IgUpdateFieldNodeData,
  IgUpdateTagNodeData,
  IgWaitNodeData,
  IgWebhookNodeData,
} from '../types/ig-journey.types.js';
import { allowedIgSendMessageBlocks, resolvePrivateReplyCommentId } from '../types/ig-journey.types.js';
import { resolveMetaFetchableMediaUrl } from '../../media-gallery/media-storage.js';
import type { InstagramTemplateElement } from '../../../services/instagramMedia.js';

type Edge = { targetNodeId: string; conditionValue: string | null };

type ExecutionRow = NonNullable<
  Awaited<ReturnType<InstagramJourneyExecutionRepository['findById']>>
>;

export class InstagramJourneyEngine {
  constructor(
    private readonly journeyRepo: InstagramJourneyRepository,
    private readonly executionRepo: InstagramJourneyExecutionRepository,
    private readonly messaging: InstagramMessagingProvider,
    private readonly onStartJourney?: (
      workspaceId: string,
      journeyId: string,
      contactId: string
    ) => Promise<void>
  ) {}

  async executeNode(executionId: string, nodeId: string): Promise<void> {
    const execution = await this.executionRepo.findById(executionId);
    if (!execution || !['running', 'waiting'].includes(execution.status)) return;

    const node = await this.journeyRepo.getNodeWithEdges(execution.journeyId, nodeId);
    if (!node) {
      await this.failExecution(executionId, nodeId, 'Node not found');
      return;
    }

    // CONDITION/RANDOMIZER/linear nodes recurse into executeNode in-process with
    // no per-node hop counter of their own (only GOTO_STEP has one) — a flow with
    // a cycle and no WAIT in it would otherwise recurse unbounded. syncSteps is
    // reset to 0 on every real pause (WAIT delay, resumeAfterReply).
    const stepCtx = (execution.context ?? {}) as Record<string, unknown>;
    const syncSteps = Number(stepCtx.syncSteps ?? 0) + 1;
    if (syncSteps > MAX_SYNC_EXECUTION_STEPS) {
      await this.failExecution(
        executionId,
        nodeId,
        `Execution step limit (${MAX_SYNC_EXECUTION_STEPS}) exceeded — check for a loop with no WAIT step`
      );
      return;
    }

    await this.executionRepo.updateProgress(executionId, {
      currentNodeId: nodeId,
      status: 'running',
      context: { ...stepCtx, syncSteps },
    });

    const edges = node.outgoingEdges.map((e) => ({
      targetNodeId: e.targetNodeId,
      conditionValue: e.conditionValue,
    }));

    try {
      switch (node.type) {
        case 'TRIGGER':
          await this.passThrough(executionId, node.id, edges);
          break;
        case 'SEND_MESSAGE':
          await this.handleSendMessage(execution, node.id, node.data as IgSendMessageNodeData, edges);
          break;
        case 'ASK_QUESTION':
          await this.handleAskQuestion(execution, node.id, node.data as IgAskQuestionNodeData, edges);
          break;
        case 'BUTTONS':
          await this.handleButtons(execution, node.id, node.data as IgButtonsNodeData, edges);
          break;
        case 'WAIT':
          await this.handleWait(execution, node.id, node.data as IgWaitNodeData, edges);
          break;
        case 'CONDITION':
          await this.handleCondition(execution, node.id, node.data as ConditionNodeData, edges);
          break;
        case 'RANDOMIZER':
          await this.handleRandomizer(execution, node.id, node.data as IgRandomizerNodeData, edges);
          break;
        case 'GOTO_STEP':
          await this.handleGotoStep(execution, node.id, node.data as IgGotoStepNodeData);
          break;
        case 'UPDATE_TAG':
          await this.handleUpdateTag(execution, node.id, node.data as IgUpdateTagNodeData, edges);
          break;
        case 'UPDATE_FIELD':
          await this.handleUpdateField(execution, node.id, node.data as IgUpdateFieldNodeData, edges);
          break;
        case 'ADD_TO_FUNNEL':
          await this.handleAddToFunnel(execution, node.id, node.data as IgAddToFunnelNodeData, edges);
          break;
        case 'OPEN_CONVERSATION':
          await this.handleOpenConversation(execution, node.id, edges);
          break;
        case 'CLOSE_CONVERSATION':
          await this.handleCloseConversation(
            execution,
            node.id,
            node.data as IgCloseConversationNodeData,
            edges
          );
          break;
        case 'ASSIGN_TO':
          await this.handleAssignTo(execution, node.id, node.data as IgAssignToNodeData, edges);
          break;
        case 'WEBHOOK':
          await this.handleWebhook(execution, node.id, node.data as IgWebhookNodeData, edges);
          break;
        case 'TRIGGER_JOURNEY':
          await this.handleTriggerJourney(
            execution,
            node.id,
            node.data as IgTriggerJourneyNodeData,
            edges
          );
          break;
        case 'END':
          await this.handleEnd(executionId, node.id);
          break;
        default:
          await this.failExecution(executionId, nodeId, `Unsupported IG node: ${node.type}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Node execution failed';
      await this.failExecution(executionId, nodeId, message);
    }
  }

  async resumeAfterReply(
    executionId: string,
    replyText: string,
    nextNodeId: string,
    messageId?: string
  ) {
    const execution = await this.executionRepo.findById(executionId);
    if (!execution || execution.status !== 'waiting') return;

    const ctx = (execution.context ?? {}) as IgExecutionWaitContext & Record<string, unknown>;
    if (messageId && ctx.resumeMessageId === messageId) return;

    if (ctx.saveReplyTo) {
      await mergeContactCustomFields(execution.contactId, {
        [ctx.saveReplyTo]: replyText,
      });
    }

    // A WAIT timer can fire at almost the exact moment this reply arrives —
    // version-check so only whichever trigger gets here first advances the
    // execution; the loser backs off instead of double-executing.
    const advanced = await this.executionRepo.updateProgressIfVersion(
      executionId,
      execution.version,
      {
        status: 'running',
        context: {
          ...ctx,
          last_reply: replyText,
          waitKind: undefined,
          nextNodeId: undefined,
          syncSteps: 0,
          ...(messageId ? { resumeMessageId: messageId } : {}),
        },
      }
    );
    if (!advanced) return;
    await this.executionRepo.appendLog({
      executionId,
      nodeId: execution.currentNodeId,
      status: 'success',
      payload: { action: 'reply_received', text: replyText, messageId },
    });
    await this.executeNode(executionId, nextNodeId);
  }

  async continueAfterDelay(executionId: string, nextNodeId: string) {
    const execution = await this.executionRepo.findById(executionId);
    if (!execution || execution.status !== 'waiting') return;

    // A reply can arrive at almost the exact moment this WAIT timer fires —
    // version-check so only whichever trigger gets here first advances the
    // execution; the loser backs off instead of double-executing.
    const advanced = await this.executionRepo.updateProgressIfVersion(
      executionId,
      execution.version,
      {
        status: 'running',
        context: {
          ...((execution.context as Record<string, unknown>) ?? {}),
          waitKind: undefined,
          nextNodeId: undefined,
          // A real WAIT elapsed — this is a fresh burst, not a continuation of a loop.
          syncSteps: 0,
        },
      }
    );
    if (!advanced) return;
    await this.executionRepo.appendLog({
      executionId,
      nodeId: execution.currentNodeId,
      status: 'success',
      payload: { action: 'delay_complete' },
    });
    await this.executeNode(executionId, nextNodeId);
  }

  /** Manual/admin recovery for a stalled execution — e.g. a webhook step that exhausted retries. */
  async resumeExecution(workspaceId: string, executionId: string): Promise<void> {
    const execution = await this.executionRepo.findById(executionId);
    if (!execution || execution.journey.workspaceId !== workspaceId) {
      // Same error for "not found" and "belongs to another workspace" — don't
      // let the response distinguish a cross-tenant id from a bad one.
      throw new Error('Execution not found');
    }
    if (execution.status === 'completed' || execution.status === 'cancelled') {
      return;
    }

    const ctx = (execution.context ?? {}) as Record<string, unknown>;
    if (execution.status === 'waiting' && typeof ctx.nextNodeId === 'string') {
      await this.continueAfterDelay(executionId, ctx.nextNodeId);
      return;
    }

    if (!execution.currentNodeId) {
      throw new Error('Execution has no current node');
    }
    // Manual resume of a stalled/failed execution — a fresh burst. Version-check
    // in case some other trigger is concurrently advancing the same execution.
    const advanced = await this.executionRepo.updateProgressIfVersion(
      executionId,
      execution.version,
      { context: { ...ctx, syncSteps: 0 } }
    );
    if (!advanced) return;
    await this.executeNode(executionId, execution.currentNodeId);
  }

  private async passThrough(executionId: string, nodeId: string, edges: Edge[]) {
    await this.executionRepo.appendLog({
      executionId,
      nodeId,
      status: 'success',
      payload: { action: 'trigger' },
    });
    await this.advance(executionId, edges);
  }

  private async handleSendMessage(
    execution: ExecutionRow,
    nodeId: string,
    data: IgSendMessageNodeData,
    edges: Edge[]
  ) {
    if (!execution.contact) throw new Error('Contact missing');
    const contact = execution.contact;
    const workspaceId = execution.journey.workspaceId;
    const ctx = (execution.context ?? {}) as Record<string, unknown>;
    // Filters out anything Meta would reject for this node's sendAs — belt-and-suspenders,
    // publish validation should already have stripped these (findDisallowedSendMessageBlockTypes).
    const blocks = allowedIgSendMessageBlocks(data);

    let commentId = resolvePrivateReplyCommentId(ctx, data);
    let lastResult: { messageId: string; conversationId: string } | null = null;
    let usedPrivateReply = false;

    for (const block of blocks) {
      const metadata = { executionId: execution.id, nodeId, blockId: block.id, blockType: block.type };

      if (block.type === 'text' || block.type === 'buttons') {
        const text = renderTemplateVariables(block.text || '', contact).trim();
        if (!text) continue;

        if (commentId && !usedPrivateReply) {
          try {
            // Meta's private-reply endpoint is text-only — a 'buttons' block's quick replies
            // are dropped for this send (provider warns), which is why this only fires once.
            lastResult = await this.messaging.sendPrivateReply({
              workspaceId,
              contactId: execution.contactId,
              text,
              commentId,
              metadata,
            });
            usedPrivateReply = true;
            // One private reply per comment — remaining blocks/nodes in this run use normal DM.
            await this.executionRepo.updateProgress(execution.id, {
              context: { ...ctx, privateReplySent: true },
            });
            continue;
          } catch (err) {
            console.warn('[IgJourney] private_reply failed, falling back to DM', err);
            commentId = null;
          }
        }

        const quickReplies =
          block.type === 'buttons'
            ? block.buttons
                .map((b) => ({ title: b.title?.trim() || '', payload: b.id }))
                .filter((b) => b.title)
                .slice(0, 13)
            : undefined;
        lastResult = await this.messaging.send({
          workspaceId,
          contactId: execution.contactId,
          text,
          quickReplies,
          simulateTyping: Boolean(data.simulateTyping),
          metadata,
        });
        continue;
      }

      if (block.type === 'image' || block.type === 'pdf' || block.type === 'audio' || block.type === 'video') {
        const mediaUrl = await this.resolveBlockMediaUrl(workspaceId, block);
        if (!mediaUrl) {
          console.warn('[IgJourney] media block skipped — no fetchable URL', metadata);
          continue;
        }
        lastResult = await this.messaging.sendMedia({
          workspaceId,
          contactId: execution.contactId,
          kind: block.type === 'pdf' ? 'file' : block.type,
          mediaUrl,
          caption: block.caption,
          metadata,
        });
        continue;
      }

      if (block.type === 'card') {
        const element = await this.resolveCardElement(workspaceId, block);
        if (!element.title) continue;
        lastResult = await this.messaging.sendTemplate({
          workspaceId,
          contactId: execution.contactId,
          elements: [element],
          previewText: `🃏 ${element.title}`,
          metadata,
        });
        continue;
      }

      if (block.type === 'gallery') {
        const elements = (
          await Promise.all((block.cards ?? []).map((c) => this.resolveCardElement(workspaceId, c)))
        ).filter((el) => el.title);
        if (elements.length === 0) continue;
        lastResult = await this.messaging.sendTemplate({
          workspaceId,
          contactId: execution.contactId,
          elements,
          previewText: `🖼️ ${elements[0].title}${elements.length > 1 ? ` +${elements.length - 1} more` : ''}`,
          metadata,
        });
        continue;
      }

      // 'dynamic' / 'data_collection': no send path yet — allowedIgSendMessageBlocks doesn't
      // filter these out, but there is nothing to execute (picker keeps them disabled).
    }

    if (!lastResult) throw new Error('Send Message needs at least one block with content');

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: {
        action: 'send_message',
        messageId: lastResult.messageId,
        sentAs: usedPrivateReply ? 'private_reply' : 'window_24h',
        blockCount: blocks.length,
      },
    });
    await this.advance(execution.id, edges);
  }

  private async resolveBlockMediaUrl(
    workspaceId: string,
    block: { mediaId?: string; url?: string }
  ): Promise<string | null> {
    if (block.mediaId) {
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: block.mediaId, workspaceId, isActive: true },
      });
      if (asset) {
        const resolved = await resolveMetaFetchableMediaUrl(asset);
        if (resolved) return resolved;
      }
    }
    if (block.url?.startsWith('https://')) return block.url;
    return null;
  }

  private async resolveCardElement(
    workspaceId: string,
    card: IgCardElement
  ): Promise<InstagramTemplateElement> {
    let imageUrl = card.imageUrl?.startsWith('https://') ? card.imageUrl : undefined;
    if (!imageUrl && card.imageMediaId) {
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: card.imageMediaId, workspaceId, isActive: true },
      });
      if (asset) imageUrl = (await resolveMetaFetchableMediaUrl(asset)) ?? undefined;
    }
    return {
      title: (card.title || '').trim(),
      subtitle: card.subtitle?.trim() || undefined,
      imageUrl,
      buttonTitle: card.buttonTitle?.trim() || undefined,
      buttonUrl: card.buttonUrl?.trim() || undefined,
    };
  }

  private async handleAskQuestion(
    execution: ExecutionRow,
    nodeId: string,
    data: IgAskQuestionNodeData,
    edges: Edge[]
  ) {
    if (!execution.contact) throw new Error('Contact missing');
    const question = renderTemplateVariables(data.text || '', execution.contact).trim();
    if (!question) throw new Error('Ask Question needs text');

    const next = this.pickDefaultEdge(edges);
    if (!next) {
      await this.failExecution(execution.id, nodeId, 'Ask Question has no outgoing edge');
      return;
    }

    const quickReplies = Array.isArray(data.quickReplies) ? data.quickReplies : [];
    await this.messaging.send({
      workspaceId: execution.journey.workspaceId,
      contactId: execution.contactId,
      text: question,
      quickReplies,
      simulateTyping: Boolean(data.simulateTyping),
      metadata: { executionId: execution.id, nodeId, action: 'ask_question' },
    });

    const context: IgExecutionWaitContext = {
      waitKind: 'reply',
      nextNodeId: next.targetNodeId,
      ...(data.saveReplyTo ? { saveReplyTo: data.saveReplyTo } : {}),
    };

    await this.executionRepo.updateProgress(execution.id, {
      status: 'waiting',
      currentNodeId: nodeId,
      context: {
        ...((execution.context as Record<string, unknown>) ?? {}),
        ...context,
        resumeMessageId: undefined,
      },
    });
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'ask_question', waiting: true },
    });
  }

  private async handleButtons(
    execution: ExecutionRow,
    nodeId: string,
    data: IgButtonsNodeData,
    edges: Edge[]
  ) {
    if (!execution.contact) throw new Error('Contact missing');
    const text = renderTemplateVariables(data.text || '', execution.contact).trim();
    if (!text) throw new Error('Buttons needs text');
    const buttons = (Array.isArray(data.buttons) ? data.buttons : [])
      .map((b, i) => ({
        id: String(b?.id ?? `btn_${i}`).trim() || `btn_${i}`,
        title: String(b?.title ?? '').trim().slice(0, 20),
      }))
      .filter((b) => b.title)
      .slice(0, 13);
    // Meta IG quick replies allow 1–13; single-CTA flows (e.g. "I'm following") are valid.
    if (buttons.length < 1) throw new Error('Buttons needs at least 1 option');

    await this.messaging.send({
      workspaceId: execution.journey.workspaceId,
      contactId: execution.contactId,
      text,
      quickReplies: buttons.map((b) => ({ title: b.title, payload: b.id })),
      simulateTyping: Boolean(data.simulateTyping),
      metadata: { executionId: execution.id, nodeId, action: 'buttons' },
    });

    await this.executionRepo.updateProgress(execution.id, {
      status: 'waiting',
      currentNodeId: nodeId,
      context: {
        ...((execution.context as Record<string, unknown>) ?? {}),
        waitKind: 'button',
        buttonNodeId: nodeId,
        nextNodeId: undefined,
        resumeMessageId: undefined,
      } satisfies IgExecutionWaitContext,
    });
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'buttons', waiting: true, buttons: buttons.map((b) => b.id), edgeCount: edges.length },
    });
  }

  private async handleRandomizer(
    execution: ExecutionRow,
    nodeId: string,
    data: IgRandomizerNodeData,
    edges: Edge[]
  ) {
    const paths = normalizeRandomizerPaths(data.paths);
    const next = pickWeightedEdge(edges, paths);
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'randomizer', picked: next?.conditionValue ?? null, paths },
    });
    if (!next) {
      await this.executionRepo.updateProgress(execution.id, { status: 'completed' });
      return;
    }
    await this.executeNode(execution.id, next.targetNodeId);
  }

  private async handleWait(
    execution: ExecutionRow,
    nodeId: string,
    data: IgWaitNodeData,
    edges: Edge[]
  ) {
    const next = this.pickDefaultEdge(edges);
    if (!next) {
      await this.failExecution(execution.id, nodeId, 'Wait has no outgoing edge');
      return;
    }

    const amount = Math.max(0, Number(data.amount) || 0);
    const unit = data.unit === 'days' || data.unit === 'minutes' ? data.unit : 'hours';
    const baseMs = igDelayMs(amount, unit);
    const workspace = await prisma.workspace.findUnique({
      where: { id: execution.journey.workspaceId },
      select: { timezone: true },
    });
    const tz = workspace?.timezone?.trim() || 'Asia/Kolkata';
    const businessHours = normalizeBusinessHours(data.businessHours);
    const waitMs = resolveWaitMs(baseMs, businessHours, tz);

    await this.executionRepo.updateProgress(execution.id, {
      status: 'waiting',
      currentNodeId: nodeId,
      context: {
        ...((execution.context as Record<string, unknown>) ?? {}),
        waitKind: 'delay',
        nextNodeId: next.targetNodeId,
      },
    });

    await scheduleIgJourneyDelay(
      {
        executionId: execution.id,
        nextNodeId: next.targetNodeId,
        workspaceId: execution.journey.workspaceId,
      },
      waitMs
    );

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: {
        action: 'wait',
        amount,
        unit,
        waitMs,
        baseMs,
        businessHours: businessHours?.enabled ?? false,
        timezone: tz,
      },
    });
  }

  private async handleGotoStep(
    execution: ExecutionRow,
    nodeId: string,
    data: IgGotoStepNodeData
  ) {
    const targetNodeId = data.targetNodeId?.trim();
    if (!targetNodeId) {
      await this.failExecution(execution.id, nodeId, 'Go to Step needs a target step');
      return;
    }
    if (targetNodeId === nodeId) {
      await this.failExecution(execution.id, nodeId, 'Go to Step cannot target itself');
      return;
    }

    const target = await this.journeyRepo.getNodeWithEdges(execution.journeyId, targetNodeId);
    if (!target) {
      await this.failExecution(execution.id, nodeId, 'Go to Step target not found');
      return;
    }

    const ctx = (execution.context as Record<string, unknown>) ?? {};
    const hops = Number(ctx.gotoHops ?? 0) + 1;
    if (hops > GOTO_STEP_MAX_HOPS) {
      await this.failExecution(
        execution.id,
        nodeId,
        `Go to Step loop limit (${GOTO_STEP_MAX_HOPS}) exceeded`
      );
      return;
    }

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'goto_step', targetNodeId, hops },
    });
    await this.executionRepo.updateProgress(execution.id, {
      status: 'running',
      context: { ...ctx, gotoHops: hops },
    });
    await this.executeNode(execution.id, targetNodeId);
  }

  private async handleCondition(
    execution: ExecutionRow,
    nodeId: string,
    data: ConditionNodeData,
    edges: Edge[]
  ) {
    if (!execution.contact) throw new Error('Contact missing');
    const workspaceId = execution.journey.workspaceId;
    const result = await evaluateCondition(execution.contact, data, {
      checkFollowsBusiness: (contact) => checkInstagramFollowsBusiness(workspaceId, contact),
      getContactActivity: (c) => getContactActivity(c),
      getTimezone: () => getWorkspaceTimezone(workspaceId),
    });
    const next = pickBranchEdge(edges, result);
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'condition', result, field: data.field },
    });
    if (!next) {
      await this.executionRepo.updateProgress(execution.id, { status: 'completed' });
      return;
    }
    await this.executeNode(execution.id, next.targetNodeId);
  }

  private async handleUpdateTag(
    execution: ExecutionRow,
    nodeId: string,
    data: IgUpdateTagNodeData,
    edges: Edge[]
  ) {
    const contact = execution.contact;
    if (!contact) throw new Error('Contact missing');
    let tags = [...contact.tags];
    const incoming = data.tags ?? [];

    if (data.action === 'set') tags = [...incoming];
    else if (data.action === 'add') {
      for (const tag of incoming) {
        if (!tags.includes(tag)) tags.push(tag);
      }
    } else {
      tags = tags.filter((t) => !incoming.includes(t));
    }

    await prisma.contact.update({ where: { id: contact.id }, data: { tags } });
    if (data.action !== 'remove' && incoming.length) {
      void registerWorkspaceTags(execution.journey.workspaceId, incoming);
    }
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'update_tag', tags },
    });
    await this.advance(execution.id, edges);
  }

  private async handleUpdateField(
    execution: ExecutionRow,
    nodeId: string,
    data: IgUpdateFieldNodeData,
    edges: Edge[]
  ) {
    await updateContactField(
      execution.contactId,
      data.field ?? 'custom',
      String(data.value ?? ''),
      data.customFieldKey
    );
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'update_field', field: data.field },
    });
    await this.advance(execution.id, edges);
  }

  private async handleAddToFunnel(
    execution: ExecutionRow,
    nodeId: string,
    data: IgAddToFunnelNodeData,
    edges: Edge[]
  ) {
    const funnelId = data.funnelId?.trim();
    if (!funnelId) throw new Error('Select a lead funnel');

    const result = await upsertLeadForContact({
      workspaceId: execution.journey.workspaceId,
      contactId: execution.contactId,
      funnelId,
      stageId: data.stageId?.trim() || undefined,
      source: 'instagram',
    });

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: {
        action: 'add_to_funnel',
        funnelId,
        stageId: data.stageId ?? null,
        leadId: result.leadId,
        created: result.created,
      },
    });
    await this.advance(execution.id, edges);
  }

  private async handleOpenConversation(execution: ExecutionRow, nodeId: string, edges: Edge[]) {
    await openContactConversation(execution.journey.workspaceId, execution.contactId);
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'open_conversation' },
    });
    await this.advance(execution.id, edges);
  }

  private async handleCloseConversation(
    execution: ExecutionRow,
    nodeId: string,
    data: IgCloseConversationNodeData,
    edges: Edge[]
  ) {
    await closeContactConversation(
      execution.journey.workspaceId,
      execution.contactId,
      data.closingNote
    );
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'close_conversation' },
    });
    await this.advance(execution.id, edges);
  }

  private async handleAssignTo(
    execution: ExecutionRow,
    nodeId: string,
    data: IgAssignToNodeData,
    edges: Edge[]
  ) {
    await assignContactConversation(
      execution.journey.workspaceId,
      execution.contactId,
      data.assigneeType === 'user' || data.assigneeType === 'ai' ? data.assigneeType : 'unassigned',
      data.assigneeId
    );
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'assign_to', assigneeType: data.assigneeType },
    });
    await this.advance(execution.id, edges);
  }

  private async handleWebhook(
    execution: ExecutionRow,
    nodeId: string,
    data: IgWebhookNodeData,
    edges: Edge[]
  ) {
    if (!execution.contact) throw new Error('Contact missing');
    if (!data.url?.trim()) throw new Error('Webhook needs a URL');

    const result = await executeWebhookNode(data as WebhookNodeData, execution.contact);
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: {
        action: 'webhook',
        statusCode: result.statusCode,
        attempts: result.attempts,
      },
    });
    await this.advance(execution.id, edges);
  }

  private async handleTriggerJourney(
    execution: ExecutionRow,
    nodeId: string,
    data: IgTriggerJourneyNodeData,
    edges: Edge[]
  ) {
    const journeyId = data.journeyId?.trim();
    if (!journeyId) throw new Error('Select an Instagram automation to start');
    if (journeyId === execution.journeyId) {
      throw new Error('Cannot trigger the same automation');
    }
    if (this.onStartJourney) {
      await this.onStartJourney(
        execution.journey.workspaceId,
        journeyId,
        execution.contactId
      );
    }
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'trigger_journey', journeyId },
    });
    await this.advance(execution.id, edges);
  }

  private async handleEnd(executionId: string, nodeId: string) {
    await this.executionRepo.appendLog({
      executionId,
      nodeId,
      status: 'success',
      payload: { action: 'end' },
    });
    await this.executionRepo.updateProgress(executionId, {
      status: 'completed',
      currentNodeId: nodeId,
    });
  }

  private async advance(executionId: string, edges: Edge[]) {
    const next = this.pickDefaultEdge(edges);
    if (!next) {
      await this.executionRepo.updateProgress(executionId, { status: 'completed' });
      return;
    }
    await this.executeNode(executionId, next.targetNodeId);
  }

  private pickDefaultEdge(edges: Edge[]) {
    return (
      edges.find((e) => e.conditionValue === 'default' || e.conditionValue == null) ?? edges[0]
    );
  }

  private async failExecution(executionId: string, nodeId: string, message: string) {
    await this.executionRepo.appendLog({
      executionId,
      nodeId,
      status: 'failed',
      payload: { error: message },
    });
    await this.executionRepo.updateProgress(executionId, { status: 'failed' });
  }
}
