import type { InstagramJourneyRepository } from '../repositories/ig-journey.repository.js';
import type { InstagramJourneyExecutionRepository } from '../repositories/ig-journey-execution.repository.js';

const NODE_LABELS: Record<string, string> = {
  TRIGGER: 'Trigger',
  SEND_MESSAGE: 'Send Message',
  ASK_QUESTION: 'Ask Question',
  WAIT: 'Wait',
  CONDITION: 'Condition',
  UPDATE_TAG: 'Update Tag',
  UPDATE_FIELD: 'Update Field',
  OPEN_CONVERSATION: 'Open Conversation',
  CLOSE_CONVERSATION: 'Close Conversation',
  ASSIGN_TO: 'Assign To',
  WEBHOOK: 'Webhook',
  TRIGGER_JOURNEY: 'Start Automation',
  END: 'End',
};

type StepState = 'done' | 'current' | 'pending' | 'failed';

export type IgJourneyProgressStep = {
  nodeId: string;
  type: string;
  label: string;
  state: StepState;
  detail?: string;
  waitUntil?: string | null;
};

export type IgContactJourneyProgress = {
  executionId: string;
  journeyId: string;
  journeyName: string;
  status: string;
  currentNodeId: string | null;
  startedAt: string;
  lastExecutedAt: string | null;
  waitUntil?: string | null;
  steps: IgJourneyProgressStep[];
};

type ExecutionLogRow = {
  nodeId: string | null;
  status: string;
  createdAt: Date;
  payload: unknown;
};

function orderedNodeIdsFromLogs(logs: ExecutionLogRow[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const log of logs) {
    if (!log.nodeId || seen.has(log.nodeId)) continue;
    const payload = log.payload as Record<string, unknown> | null;
    if (payload?.metric && !payload?.action) continue;
    seen.add(log.nodeId);
    ordered.push(log.nodeId);
  }

  return ordered;
}

function nodeLabel(type: string, data: Record<string, unknown>): string {
  if (type === 'SEND_MESSAGE' || type === 'ASK_QUESTION') {
    const text = String(data.text ?? '').trim();
    if (text) return text.length > 42 ? `${text.slice(0, 42)}…` : text;
  }
  if (type === 'WAIT') {
    return `Wait ${data.amount ?? 1} ${data.unit ?? 'hours'}`;
  }
  if (type === 'TRIGGER') {
    const events = Array.isArray(data.events) && data.events.length > 0
      ? data.events.map((e) => String(e))
      : [String(data.event ?? 'dm.received')];
    const event = events.join(' + ').replace(/\./g, ' ');
    return `Trigger · ${event}`;
  }
  if (type === 'CONDITION') {
    const field = String(data.field ?? '').trim();
    return field ? `Condition · ${field}` : 'Condition';
  }
  if (type === 'WEBHOOK') {
    const name = String(data.name ?? '').trim();
    if (name) return name;
    return `HTTP ${String(data.method ?? 'POST')}`;
  }
  return NODE_LABELS[type] ?? type;
}

function resolveWaitUntil(
  logs: ExecutionLogRow[],
  currentNodeId: string | null
): string | null {
  if (!currentNodeId) return null;
  const relevant = [...logs].reverse().find((log) => {
    if (log.nodeId !== currentNodeId) return false;
    const payload = log.payload as { waitMs?: number } | null;
    return Boolean(payload?.waitMs);
  });
  if (!relevant) return null;
  const waitMs = (relevant.payload as { waitMs?: number }).waitMs ?? 0;
  if (waitMs <= 0) return null;
  return new Date(relevant.createdAt.getTime() + waitMs).toISOString();
}

export class InstagramJourneyProgressService {
  constructor(
    private readonly journeyRepo: InstagramJourneyRepository,
    private readonly executionRepo: InstagramJourneyExecutionRepository
  ) {}

  async getContactProgress(
    workspaceId: string,
    contactId: string
  ): Promise<IgContactJourneyProgress | null> {
    const executions = await this.executionRepo.findForContact(workspaceId, contactId, 5);
    // Newest first from repo — prefer live, else latest finished result (skip cancelled).
    const execution =
      executions.find((e) => e.status === 'running' || e.status === 'waiting') ??
      executions.find((e) => e.status === 'failed' || e.status === 'completed');
    if (!execution) return null;

    const graph = await this.journeyRepo.getGraph(workspaceId, execution.journeyId);
    if (!graph) return null;

    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    let orderedIds = orderedNodeIdsFromLogs(execution.logs);
    if (orderedIds.length === 0) {
      const trigger = graph.nodes.find((n) => n.type === 'TRIGGER');
      if (trigger) orderedIds = [trigger.id];
      else if (execution.currentNodeId) orderedIds = [execution.currentNodeId];
    }

    const successNodes = new Set<string>();
    for (const log of execution.logs) {
      if (log.nodeId && log.status === 'success') successNodes.add(log.nodeId);
    }

    const isFailed = execution.status === 'failed';
    const isCompleted = execution.status === 'completed';
    const currentId = execution.currentNodeId;
    const waitUntil =
      execution.status === 'waiting' ? resolveWaitUntil(execution.logs, currentId) : null;

    const steps: IgJourneyProgressStep[] = [];

    for (const nodeId of orderedIds) {
      const node = nodeById.get(nodeId);
      if (!node) continue;

      const data = (node.data ?? {}) as Record<string, unknown>;
      let state: StepState = 'pending';
      let detail: string | undefined;

      if (isCompleted || (successNodes.has(nodeId) && nodeId !== currentId)) {
        state = 'done';
      } else if (nodeId === currentId) {
        if (isFailed) {
          state = 'failed';
          const failLog = [...execution.logs]
            .reverse()
            .find((l) => l.nodeId === nodeId && l.status === 'failed');
          const err = (failLog?.payload as { error?: string } | null)?.error;
          detail = err?.trim() || 'Step failed';
        } else if (execution.status === 'waiting' && node.type === 'WAIT') {
          state = 'current';
          detail = waitUntil ? undefined : 'Waiting for delay…';
        } else if (execution.status === 'waiting' && node.type === 'ASK_QUESTION') {
          state = 'current';
          detail = 'Waiting for reply…';
        } else if (isCompleted) {
          state = 'done';
        } else {
          state = 'current';
          detail =
            execution.status === 'waiting' ? 'Paused until next step' : 'Running now';
        }
      } else if (successNodes.has(nodeId)) {
        state = 'done';
      }

      steps.push({
        nodeId,
        type: node.type,
        label: nodeLabel(node.type, data),
        state,
        detail,
        waitUntil: state === 'current' && node.type === 'WAIT' ? waitUntil : undefined,
      });
    }

    return {
      executionId: execution.id,
      journeyId: execution.journeyId,
      journeyName: execution.journey.name,
      status: execution.status,
      currentNodeId: execution.currentNodeId,
      startedAt: execution.startedAt.toISOString(),
      lastExecutedAt: execution.lastExecutedAt?.toISOString() ?? null,
      waitUntil,
      steps,
    };
  }
}
