import { prisma } from '../../../index.js';
import type { JourneyExecutionRepository } from '../repositories/journey-execution.repository.js';
import type { JourneyRepository } from '../repositories/journey.repository.js';
import type { MessagingProvider } from '../providers/messaging.provider.js';
import { wrapMetaSendError } from '../providers/meta-cloud.messaging.provider.js';
import { evaluateCondition, pickBranchEdge } from './condition-evaluator.service.js';
import { getContactActivity, getWorkspaceTimezone } from './contact-activity.service.js';
import {
  normalizeRandomizerPaths,
  pickWeightedEdge,
} from './randomizer.service.js';
import {
  normalizeBusinessHours,
  resolveWaitMs,
} from './businessHours.service.js';
import { executeWebhookNode } from './webhook-executor.service.js';
import { applyWebhookResponseMappings } from './webhook-response-mapper.service.js';
import { renderTemplateVariables, resolveSendMessageVariables } from './message-renderer.service.js';
import { delayMs, scheduleJourneyDelay } from '../queue/journey.queue.js';
import {
  assignContactConversation,
  closeContactConversation,
  mergeContactCustomFields,
  openContactConversation,
  updateContactField,
} from './journey-contact-actions.service.js';
import { upsertLeadForContact } from '../../../services/lead.service.js';
import { registerWorkspaceTags } from '../../../services/workspaceTags.service.js';
import { randomUUID } from 'node:crypto';
import { recordFlowSend } from '../../../services/whatsappFlowToken.service.js';
import type {
  AddToFunnelNodeData,
  AskQuestionNodeData,
  AssignToNodeData,
  ButtonsNodeData,
  CloseConversationNodeData,
  ConditionNodeData,
  GotoStepNodeData,
  RandomizerNodeData,
  SendFlowNodeData,
  SendMessageNodeData,
  TriggerJourneyNodeData,
  UpdateFieldNodeData,
  UpdateLifecycleNodeData,
  UpdateTagNodeData,
  WaitNodeData,
  WebhookNodeData,
  ExecutionWaitContext,
} from '../types/journey.types.js';
import { GOTO_STEP_MAX_HOPS, MAX_SYNC_EXECUTION_STEPS } from '../types/journey.types.js';

export class JourneyEngine {
  constructor(
    private readonly journeyRepo: JourneyRepository,
    private readonly executionRepo: JourneyExecutionRepository,
    private readonly messagingProvider: MessagingProvider
  ) {}

  async continueAfterDelay(executionId: string, nextNodeId: string): Promise<void> {
    const execution = await this.executionRepo.findById(executionId);
    if (!execution || execution.status === 'completed' || execution.status === 'cancelled') {
      return;
    }
    // A reply can arrive at almost the exact moment this WAIT timer fires —
    // version-check so only whichever trigger gets here first advances the
    // execution; the loser backs off instead of double-executing.
    const advanced = await this.executionRepo.updateProgressIfVersion(
      executionId,
      execution.version,
      {
        status: 'running',
        currentNodeId: nextNodeId,
        // A real WAIT elapsed — this is a fresh burst, not a continuation of a loop.
        context: { ...((execution.context as Record<string, unknown>) ?? {}), syncSteps: 0 },
      }
    );
    if (!advanced) return;
    await this.executeNode(executionId, nextNodeId);
  }

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

    if (execution.status === 'waiting') {
      const pending = await prisma.journeyExecutionLog.findFirst({
        where: { executionId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      const nextNodeId = (pending?.payload as { nextNodeId?: string } | null)?.nextNodeId;
      if (nextNodeId) {
        await this.continueAfterDelay(executionId, nextNodeId);
        return;
      }
    }

    if (!execution.currentNodeId) {
      throw new Error('Execution has no current node');
    }
    // Manual resume of a stalled/failed execution — a fresh burst. Version-check
    // in case some other trigger is concurrently advancing the same execution.
    const advanced = await this.executionRepo.updateProgressIfVersion(
      executionId,
      execution.version,
      { context: { ...((execution.context as Record<string, unknown>) ?? {}), syncSteps: 0 } }
    );
    if (!advanced) return;
    await this.executeNode(executionId, execution.currentNodeId);
  }

  async executeNode(executionId: string, nodeId: string): Promise<void> {
    const execution = await this.executionRepo.findById(executionId);
    if (!execution) {
      throw new Error('Execution not found');
    }
    if (execution.status === 'completed' || execution.status === 'cancelled') {
      return;
    }

    const node = await this.journeyRepo.getNodeWithEdges(execution.journeyId, nodeId);
    if (!node) {
      await this.failExecution(executionId, nodeId, 'Node not found');
      return;
    }

    // CONDITION/RANDOMIZER/linear nodes recurse into executeNode in-process with
    // no per-node hop counter of their own (only GOTO_STEP has one) — a flow with
    // a cycle and no WAIT in it would otherwise recurse unbounded. syncSteps is
    // reset to 0 on every real pause (see continueAfterDelay/resumeAfterReply/
    // resumeExecution), so this only bounds a single uninterrupted burst.
    const ctx = (execution.context ?? {}) as Record<string, unknown>;
    const syncSteps = Number(ctx.syncSteps ?? 0) + 1;
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
      context: { ...ctx, syncSteps },
    });

    try {
      switch (node.type) {
        case 'TRIGGER':
          await this.handlePassThrough(executionId, node.id, node.outgoingEdges);
          break;
        case 'SEND_MESSAGE':
          await this.handleSendMessage(execution, node.id, node.data as SendMessageNodeData, node.outgoingEdges);
          break;
        case 'ASK_QUESTION':
          await this.handleAskQuestion(execution, node.id, node.data as AskQuestionNodeData, node.outgoingEdges);
          break;
        case 'BUTTONS':
          await this.handleButtons(execution, node.id, node.data as ButtonsNodeData, node.outgoingEdges);
          break;
        case 'SEND_FLOW':
          await this.handleSendFlow(execution, node.id, node.data as SendFlowNodeData, node.outgoingEdges);
          break;
        case 'ASSIGN_TO':
          await this.handleAssignTo(execution, node.id, node.data as AssignToNodeData, node.outgoingEdges);
          break;
        case 'WAIT':
          await this.handleWait(execution, node.id, node.data as WaitNodeData, node.outgoingEdges);
          break;
        case 'CONDITION':
          await this.handleCondition(execution, node.id, node.data as ConditionNodeData, node.outgoingEdges);
          break;
        case 'RANDOMIZER':
          await this.handleRandomizer(execution, node.id, node.data as RandomizerNodeData, node.outgoingEdges);
          break;
        case 'GOTO_STEP':
          await this.handleGotoStep(execution, node.id, node.data as GotoStepNodeData);
          break;
        case 'WEBHOOK':
          await this.handleWebhook(execution, node.id, node.data as WebhookNodeData, node.outgoingEdges);
          break;
        case 'UPDATE_TAG':
          await this.handleUpdateTag(execution, node.id, node.data as UpdateTagNodeData, node.outgoingEdges);
          break;
        case 'UPDATE_FIELD':
          await this.handleUpdateField(execution, node.id, node.data as UpdateFieldNodeData, node.outgoingEdges);
          break;
        case 'ADD_TO_FUNNEL':
          await this.handleAddToFunnel(execution, node.id, node.data as AddToFunnelNodeData, node.outgoingEdges);
          break;
        case 'OPEN_CONVERSATION':
          await this.handleOpenConversation(execution, node.id, node.outgoingEdges);
          break;
        case 'CLOSE_CONVERSATION':
          await this.handleCloseConversation(
            execution,
            node.id,
            node.data as CloseConversationNodeData,
            node.outgoingEdges
          );
          break;
        case 'TRIGGER_JOURNEY':
          await this.handleTriggerJourney(
            execution,
            node.id,
            node.data as TriggerJourneyNodeData,
            node.outgoingEdges
          );
          break;
        case 'UPDATE_LIFECYCLE':
          await this.handleUpdateLifecycle(
            execution,
            node.id,
            node.data as UpdateLifecycleNodeData,
            node.outgoingEdges
          );
          break;
        case 'SEND_CAPI':
        case 'SEND_TIKTOK':
        case 'GOOGLE_SHEETS':
        case 'AI_OBJECTIVE':
          await this.handleComingSoon(execution, node.id, node.type, node.outgoingEdges);
          break;
        case 'END':
          await this.handleEnd(executionId, node.id);
          break;
        default:
          await this.failExecution(executionId, node.id, `Unsupported node type: ${node.type}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Node execution failed';
      await this.failExecution(executionId, nodeId, message);
    }
  }

  private async handlePassThrough(
    executionId: string,
    nodeId: string,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    await this.executionRepo.appendLog({
      executionId,
      nodeId,
      status: 'success',
      payload: { action: 'trigger' },
    });
    await this.advance(executionId, nodeId, edges);
  }

  private async handleSendMessage(
    execution: Awaited<ReturnType<JourneyExecutionRepository['findById']>>,
    nodeId: string,
    data: SendMessageNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    if (!execution?.contact) {
      throw new Error('Contact missing on execution');
    }

    const isTemplate =
      data.messageMode === 'template' || Boolean(data.templateName || data.templateId);
    const isCtaUrl = !isTemplate && data.messageMode === 'cta_url';
    const variables = isTemplate
      ? resolveSendMessageVariables(data.variables, execution.contact)
      : [];
    const text =
      !isTemplate && data.text
        ? renderTemplateVariables(data.text, execution.contact)
        : undefined;

    if (isCtaUrl && !data.ctaUrl?.trim()) {
      throw new Error('Open website step needs a URL');
    }

    try {
      const result = await this.messagingProvider.send({
        workspaceId: execution.journey.workspaceId,
        contactId: execution.contactId,
        phone: execution.contact.phone,
        templateName: isTemplate ? data.templateName : undefined,
        templateId: isTemplate ? data.templateId : undefined,
        language: data.language,
        variables,
        text,
        ctaUrl: isCtaUrl ? data.ctaUrl!.trim() : undefined,
        ctaButtonLabel: isCtaUrl ? data.ctaLabel : undefined,
        simulateTyping: Boolean(data.simulateTyping) && !isTemplate,
        metadata: { executionId: execution.id, nodeId },
      });

      await this.executionRepo.appendLog({
        executionId: execution.id,
        nodeId,
        status: 'success',
        payload: {
          action: 'send_message',
          messageId: result.messageId,
          conversationId: result.conversationId,
          metric: 'sent',
        },
      });
      await this.executionRepo.logAnalytics(execution.id, nodeId, 'sent', {
        messageId: result.messageId,
      });

      await this.advance(execution.id, nodeId, edges);
    } catch (err) {
      throw wrapMetaSendError(err);
    }
  }

  private async handleAskQuestion(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: AskQuestionNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    if (!execution.contact) throw new Error('Contact missing on execution');
    const question = data.text?.trim();
    if (!question) {
      throw new Error('Ask Question node needs message text');
    }

    const next = this.pickDefaultEdge(edges);
    if (!next) {
      await this.failExecution(execution.id, nodeId, 'Ask Question node has no outgoing edge');
      return;
    }

    const result = await this.messagingProvider.send({
      workspaceId: execution.journey.workspaceId,
      contactId: execution.contactId,
      phone: execution.contact.phone,
      text: renderTemplateVariables(question, execution.contact),
      simulateTyping: Boolean(data.simulateTyping),
      metadata: { executionId: execution.id, nodeId, action: 'ask_question' },
    });

    const context: ExecutionWaitContext = {
      waitKind: 'reply',
      nextNodeId: next.targetNodeId,
      ...(data.saveReplyTo ? { saveReplyTo: data.saveReplyTo } : {}),
    };

    await this.executionRepo.updateProgress(execution.id, {
      status: 'waiting',
      currentNodeId: nodeId,
      context: {
        ...(execution.context as Record<string, unknown>),
        ...context,
      },
    });

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'pending',
      payload: {
        action: 'ask_question',
        messageId: result.messageId,
        nextNodeId: next.targetNodeId,
      },
    });
  }

  private async handleSendFlow(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: SendFlowNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    if (!execution.contact) throw new Error('Contact missing on execution');
    const flowId = data.flowId?.trim();
    if (!flowId) throw new Error('Send Flow node needs a flow selected');

    const flow = await prisma.whatsAppFlow.findFirst({
      where: { id: flowId, workspaceId: execution.journey.workspaceId },
    });
    if (!flow) throw new Error('Selected flow no longer exists');
    if (flow.status !== 'published' || !flow.metaFlowId) {
      throw new Error(`Flow "${flow.name}" must be published before a journey can send it`);
    }
    const screens = (flow.flowJson as { screens?: Array<{ id?: string }> })?.screens ?? [];
    const firstScreenId = screens[0]?.id;
    if (!firstScreenId) throw new Error(`Flow "${flow.name}" has no screens`);

    const next = this.pickDefaultEdge(edges);
    if (!next) {
      await this.failExecution(execution.id, nodeId, 'Send Flow node has no outgoing edge');
      return;
    }

    const text = data.text?.trim() || `Please complete: ${flow.name}`;
    const flowToken = randomUUID();

    const result = await this.messagingProvider.send({
      workspaceId: execution.journey.workspaceId,
      contactId: execution.contactId,
      phone: execution.contact.phone,
      text: renderTemplateVariables(text, execution.contact),
      flow: {
        metaFlowId: flow.metaFlowId,
        flowToken,
        ctaLabel: data.ctaLabel || 'Open',
        firstScreenId,
        headerText: data.headerText,
      },
      metadata: { executionId: execution.id, nodeId, action: 'send_flow', flowId: flow.id },
    });

    await recordFlowSend({ flowToken, flowId: flow.id, workspaceId: execution.journey.workspaceId });

    const context: ExecutionWaitContext = {
      waitKind: 'flow',
      nextNodeId: next.targetNodeId,
      flowNodeId: nodeId,
    };

    await this.executionRepo.updateProgress(execution.id, {
      status: 'waiting',
      currentNodeId: nodeId,
      context: {
        ...(execution.context as Record<string, unknown>),
        ...context,
        ...(data.saveFieldsPrefix ? { flowSaveFieldsPrefix: data.saveFieldsPrefix } : {}),
        ...(data.mapNameField ? { flowMapNameField: data.mapNameField } : {}),
        ...(data.mapPhoneField ? { flowMapPhoneField: data.mapPhoneField } : {}),
        ...(data.mapEmailField ? { flowMapEmailField: data.mapEmailField } : {}),
        ...(data.funnelId ? { flowFunnelId: data.funnelId, flowStageId: data.stageId } : {}),
      },
    });

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'pending',
      payload: { action: 'send_flow', messageId: result.messageId, flowId: flow.id },
    });
  }

  private async handleButtons(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: ButtonsNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    if (!execution.contact) throw new Error('Contact missing on execution');
    const text = data.text?.trim();
    if (!text) throw new Error('Buttons node needs message text');
    const buttons = (Array.isArray(data.buttons) ? data.buttons : [])
      .map((b, i) => ({
        id: String(b?.id ?? `btn_${i}`).trim() || `btn_${i}`,
        title: String(b?.title ?? '').trim().slice(0, 20),
      }))
      .filter((b) => b.title)
      .slice(0, 3);
    if (buttons.length < 2) throw new Error('Buttons node needs at least 2 buttons');

    const result = await this.messagingProvider.send({
      workspaceId: execution.journey.workspaceId,
      contactId: execution.contactId,
      phone: execution.contact.phone,
      text: renderTemplateVariables(text, execution.contact),
      buttons,
      simulateTyping: Boolean(data.simulateTyping),
      metadata: { executionId: execution.id, nodeId, action: 'buttons' },
    });

    await this.executionRepo.updateProgress(execution.id, {
      status: 'waiting',
      currentNodeId: nodeId,
      context: {
        ...(execution.context as Record<string, unknown>),
        waitKind: 'button',
        buttonNodeId: nodeId,
        nextNodeId: undefined,
      } satisfies ExecutionWaitContext,
    });

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'pending',
      payload: {
        action: 'buttons',
        messageId: result.messageId,
        buttons: buttons.map((b) => b.id),
        edgeCount: edges.length,
      },
    });
  }

  private async handleRandomizer(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: RandomizerNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    const paths = normalizeRandomizerPaths(data.paths);
    const next = pickWeightedEdge(edges, paths);
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: {
        action: 'randomizer',
        picked: next?.conditionValue ?? null,
        paths,
      },
    });
    if (!next) {
      await this.executionRepo.updateProgress(execution.id, { status: 'completed' });
      return;
    }
    await this.executeNode(execution.id, next.targetNodeId);
  }

  async resumeAfterReply(
    executionId: string,
    replyText: string,
    nextNodeId: string,
    messageId?: string,
    extra?: { flowFields?: Record<string, unknown> }
  ): Promise<void> {
    const execution = await this.executionRepo.findById(executionId);
    if (!execution || execution.status !== 'waiting') return;

    const ctx = (execution.context ?? {}) as ExecutionWaitContext & {
      saveReplyTo?: string;
      resumeMessageId?: string;
      flowSaveFieldsPrefix?: string;
      flowMapNameField?: string;
      flowMapPhoneField?: string;
      flowMapEmailField?: string;
      flowFunnelId?: string;
      flowStageId?: string;
    };
    // A redelivered inbound webhook (common on slow/5xx responses) must not
    // advance the same waiting execution twice.
    if (messageId && ctx.resumeMessageId === messageId) return;

    if (ctx.waitKind === 'flow' && extra?.flowFields) {
      const fields = extra.flowFields;
      const fieldAsString = (key?: string) => {
        if (!key) return undefined;
        const v = fields[key];
        return v == null ? undefined : String(v);
      };

      if (ctx.flowSaveFieldsPrefix?.trim()) {
        const prefix = ctx.flowSaveFieldsPrefix.trim();
        const prefixed: Record<string, string> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (key === 'flow_token') continue;
          prefixed[`${prefix}${key}`] = String(value);
        }
        if (Object.keys(prefixed).length > 0) {
          await mergeContactCustomFields(execution.contactId, prefixed);
        }
      }

      const mappedName = fieldAsString(ctx.flowMapNameField);
      const mappedPhone = fieldAsString(ctx.flowMapPhoneField);
      const mappedEmail = fieldAsString(ctx.flowMapEmailField);
      if (mappedName) await updateContactField(execution.contactId, 'name', mappedName);
      if (mappedPhone) await updateContactField(execution.contactId, 'phone', mappedPhone);
      if (mappedEmail) await updateContactField(execution.contactId, 'email', mappedEmail);

      if (ctx.flowFunnelId) {
        try {
          await upsertLeadForContact({
            workspaceId: execution.journey.workspaceId,
            contactId: execution.contactId,
            funnelId: ctx.flowFunnelId,
            stageId: ctx.flowStageId,
            source: 'whatsapp',
          });
        } catch (err) {
          console.error('[journey] Send Flow → funnel upsert failed', err);
        }
      }
    }

    if (ctx.saveReplyTo?.trim()) {
      await mergeContactCustomFields(execution.contactId, {
        [ctx.saveReplyTo.trim()]: replyText,
      });
    }

    await this.executionRepo.appendLog({
      executionId,
      nodeId: execution.currentNodeId ?? undefined,
      status: 'success',
      payload: { action: 'reply_received', replyText: replyText.slice(0, 500), messageId },
    });

    // A WAIT timer can fire at almost the exact moment this reply arrives —
    // version-check so only whichever trigger gets here first advances the
    // execution; the loser backs off instead of double-executing.
    const advanced = await this.executionRepo.updateProgressIfVersion(
      executionId,
      execution.version,
      {
        status: 'running',
        context: {
          ...(execution.context as Record<string, unknown>),
          waitKind: undefined,
          lastReply: replyText,
          syncSteps: 0,
          ...(messageId ? { resumeMessageId: messageId } : {}),
        },
      }
    );
    if (!advanced) return;

    await this.executeNode(executionId, nextNodeId);
  }

  private async handleAssignTo(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: AssignToNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    await assignContactConversation(
      execution.journey.workspaceId,
      execution.contactId,
      data.assigneeType ?? 'unassigned',
      data.assigneeId
    );

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'assign_to', assigneeType: data.assigneeType, assigneeId: data.assigneeId },
    });
    await this.advance(execution.id, nodeId, edges);
  }

  private async handleUpdateField(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: UpdateFieldNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    const field = data.field ?? 'name';
    await updateContactField(
      execution.contactId,
      field,
      String(data.value ?? ''),
      data.customFieldKey
    );

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'update_field', field, value: data.value },
    });
    await this.advance(execution.id, nodeId, edges);
  }

  private async handleOpenConversation(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    await openContactConversation(execution.journey.workspaceId, execution.contactId);
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'open_conversation' },
    });
    await this.advance(execution.id, nodeId, edges);
  }

  private async handleCloseConversation(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: CloseConversationNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
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
      payload: { action: 'close_conversation', closingNote: data.closingNote },
    });
    await this.advance(execution.id, nodeId, edges);
  }

  private async handleTriggerJourney(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: TriggerJourneyNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    if (!data.journeyId?.trim()) {
      throw new Error('Select a journey to trigger');
    }

    const { initJourneyModule } = await import('../container.js');
    const { triggerService } = initJourneyModule(prisma);
    await triggerService.startAssignedJourney(
      execution.journey.workspaceId,
      data.journeyId,
      execution.contactId
    );

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'trigger_journey', journeyId: data.journeyId },
    });
    await this.advance(execution.id, nodeId, edges);
  }

  private async handleUpdateLifecycle(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: UpdateLifecycleNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    await updateContactField(
      execution.contactId,
      'journeyStatus',
      String(data.stage ?? '')
    );
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'update_lifecycle', stage: data.stage },
    });
    await this.advance(execution.id, nodeId, edges);
  }

  private async handleComingSoon(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    nodeType: string,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'skipped',
      payload: { action: 'coming_soon', nodeType },
    });
    await this.advance(execution.id, nodeId, edges);
  }

  private async handleWait(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: WaitNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    const next = this.pickDefaultEdge(edges);
    if (!next) {
      await this.failExecution(execution.id, nodeId, 'Wait node has no outgoing edge');
      return;
    }

    const baseMs = delayMs(data.amount ?? 0, data.unit ?? 'hours');
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
        ...(execution.context as Record<string, unknown>),
        waitKind: 'delay',
        nextNodeId: next.targetNodeId,
      },
    });
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'pending',
      payload: {
        action: 'wait',
        waitMs,
        baseMs,
        businessHours: businessHours?.enabled ?? false,
        timezone: tz,
        nextNodeId: next.targetNodeId,
      },
    });

    await scheduleJourneyDelay(
      {
        executionId: execution.id,
        nextNodeId: next.targetNodeId,
        workspaceId: execution.journey.workspaceId,
      },
      waitMs
    );
  }

  private async handleGotoStep(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: GotoStepNodeData
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
      await this.failExecution(execution.id, nodeId, 'Go to Step target not found in this journey');
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
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: ConditionNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    const result = await evaluateCondition(execution.contact, data, {
      getContactActivity: (c) => getContactActivity(c),
      getTimezone: () => getWorkspaceTimezone(execution.journey.workspaceId),
    });
    const edge = pickBranchEdge(edges, result);
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'condition', result, field: data.field, operator: data.operator },
    });

    if (!edge) {
      await this.failExecution(execution.id, nodeId, 'Condition node has no matching branch');
      return;
    }

    await this.executeNode(execution.id, edge.targetNodeId);
  }

  private async handleWebhook(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: WebhookNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    const result = await executeWebhookNode(data, execution.contact);
    const savedAttributes = await applyWebhookResponseMappings(
      execution.contactId,
      result.body,
      data.responseMappings
    );
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: {
        action: 'webhook',
        statusCode: result.statusCode,
        attempts: result.attempts,
        savedAttributes: savedAttributes.map((m) => ({
          key: m.attributeKey,
          path: m.jsonPath,
        })),
      },
    });
    await this.advance(execution.id, nodeId, edges);
  }

  private async handleUpdateTag(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: UpdateTagNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    const contact = execution.contact;
    let tags = [...contact.tags];
    const incoming = data.tags ?? [];

    if (data.action === 'set') {
      tags = [...incoming];
    } else if (data.action === 'add') {
      for (const tag of incoming) {
        if (!tags.includes(tag)) tags.push(tag);
      }
    } else {
      tags = tags.filter((t) => !incoming.includes(t));
    }

    await prisma.contact.update({
      where: { id: contact.id },
      data: { tags },
    });
    if (data.action !== 'remove' && incoming.length) {
      void registerWorkspaceTags(execution.journey.workspaceId, incoming);
    }

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'update_tag', tags },
    });
    await this.advance(execution.id, nodeId, edges);
  }

  private async handleAddToFunnel(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: AddToFunnelNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    const funnelId = data.funnelId?.trim();
    if (!funnelId) throw new Error('Select a lead funnel');

    const result = await upsertLeadForContact({
      workspaceId: execution.journey.workspaceId,
      contactId: execution.contactId,
      funnelId,
      stageId: data.stageId?.trim() || undefined,
      source: 'whatsapp',
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
    await this.advance(execution.id, nodeId, edges);
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

  private async advance(
    executionId: string,
    nodeId: string,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    const next = this.pickDefaultEdge(edges);
    if (!next) {
      await this.executionRepo.updateProgress(executionId, { status: 'completed' });
      return;
    }
    await this.executeNode(executionId, next.targetNodeId);
  }

  private pickDefaultEdge(edges: Array<{ targetNodeId: string; conditionValue: string | null }>) {
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
