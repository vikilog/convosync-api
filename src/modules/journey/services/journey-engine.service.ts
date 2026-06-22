import { prisma } from '../../../index.js';
import type { JourneyExecutionRepository } from '../repositories/journey-execution.repository.js';
import type { JourneyRepository } from '../repositories/journey.repository.js';
import type { MessagingProvider } from '../providers/messaging.provider.js';
import { wrapMetaSendError } from '../providers/meta-cloud.messaging.provider.js';
import { evaluateCondition, pickBranchEdge } from './condition-evaluator.service.js';
import { executeWebhookNode } from './webhook-executor.service.js';
import { applyWebhookResponseMappings } from './webhook-response-mapper.service.js';
import { renderTemplateVariables, resolveSendMessageVariables } from './message-renderer.service.js';
import { delayMs, scheduleJourneyDelay } from '../queue/journey.queue.js';
import {
  assignContactConversation,
  closeContactConversation,
  openContactConversation,
  updateContactField,
} from './journey-contact-actions.service.js';
import type {
  AskQuestionNodeData,
  AssignToNodeData,
  CloseConversationNodeData,
  ConditionNodeData,
  SendMessageNodeData,
  TriggerJourneyNodeData,
  UpdateFieldNodeData,
  UpdateLifecycleNodeData,
  UpdateTagNodeData,
  WaitNodeData,
  WebhookNodeData,
  ExecutionWaitContext,
} from '../types/journey.types.js';

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
    await this.executionRepo.updateProgress(executionId, {
      status: 'running',
      currentNodeId: nextNodeId,
    });
    await this.executeNode(executionId, nextNodeId);
  }

  async resumeExecution(executionId: string): Promise<void> {
    const execution = await this.executionRepo.findById(executionId);
    if (!execution) {
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

    await this.executionRepo.updateProgress(executionId, {
      currentNodeId: nodeId,
      status: 'running',
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
        case 'ASSIGN_TO':
          await this.handleAssignTo(execution, node.id, node.data as AssignToNodeData, node.outgoingEdges);
          break;
        case 'WAIT':
          await this.handleWait(execution, node.id, node.data as WaitNodeData, node.outgoingEdges);
          break;
        case 'CONDITION':
          await this.handleCondition(execution, node.id, node.data as ConditionNodeData, node.outgoingEdges);
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
    const variables = isTemplate
      ? resolveSendMessageVariables(data.variables, execution.contact)
      : [];
    const text =
      !isTemplate && data.text
        ? renderTemplateVariables(data.text, execution.contact)
        : undefined;

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

  async resumeAfterReply(
    executionId: string,
    replyText: string,
    nextNodeId: string
  ): Promise<void> {
    const execution = await this.executionRepo.findById(executionId);
    if (!execution || execution.status !== 'waiting') return;

    await this.executionRepo.appendLog({
      executionId,
      nodeId: execution.currentNodeId ?? undefined,
      status: 'success',
      payload: { action: 'reply_received', replyText: replyText.slice(0, 500) },
    });

    await this.executionRepo.updateProgress(executionId, {
      status: 'running',
      context: {
        ...(execution.context as Record<string, unknown>),
        waitKind: undefined,
        lastReply: replyText,
      },
    });

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

    const waitMs = delayMs(data.amount ?? 1, data.unit ?? 'hours');
    await this.executionRepo.updateProgress(execution.id, {
      status: 'waiting',
      currentNodeId: nodeId,
    });
    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'pending',
      payload: { action: 'wait', waitMs, nextNodeId: next.targetNodeId },
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

  private async handleCondition(
    execution: NonNullable<Awaited<ReturnType<JourneyExecutionRepository['findById']>>>,
    nodeId: string,
    data: ConditionNodeData,
    edges: Array<{ targetNodeId: string; conditionValue: string | null }>
  ) {
    const result = evaluateCondition(execution.contact, data);
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

    await this.executionRepo.appendLog({
      executionId: execution.id,
      nodeId,
      status: 'success',
      payload: { action: 'update_tag', tags },
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
