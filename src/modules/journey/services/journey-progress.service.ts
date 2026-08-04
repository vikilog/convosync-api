import type { JourneyRepository } from '../repositories/journey.repository.js';
import type { JourneyExecutionRepository } from '../repositories/journey-execution.repository.js';

const NODE_LABELS: Record<string, string> = {
  TRIGGER: 'Trigger',
  SEND_MESSAGE: 'Send WhatsApp',
  WAIT: 'Delay',
  CONDITION: 'Condition',
  WEBHOOK: 'Webhook',
  UPDATE_TAG: 'Update Tag',
  END: 'End',
};

type StepState = 'done' | 'current' | 'pending' | 'failed';

export type JourneyProgressStep = {
  nodeId: string;
  type: string;
  label: string;
  state: StepState;
  detail?: string;
  waitUntil?: string | null;
};

export type ContactJourneyProgress = {
  executionId: string;
  journeyId: string;
  journeyName: string;
  status: string;
  currentNodeId: string | null;
  startedAt: string;
  lastExecutedAt: string | null;
  waitUntil?: string | null;
  steps: JourneyProgressStep[];
};

type ExecutionLogRow = {
  nodeId: string | null;
  status: string;
  createdAt: Date;
  payload: unknown;
};

/** Actual path taken — from execution logs only (avoids showing unvisited branch nodes after End). */
function orderedNodeIdsFromLogs(logs: ExecutionLogRow[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const log of logs) {
    if (!log.nodeId || seen.has(log.nodeId)) continue;

    const payload = log.payload as Record<string, unknown> | null;
    // Skip analytics-only duplicate log rows (e.g. metric: sent after action: send_message).
    if (payload?.metric && !payload?.action) continue;

    seen.add(log.nodeId);
    ordered.push(log.nodeId);
  }

  return ordered;
}

function nodeLabel(type: string, data: Record<string, unknown>): string {
  if (type === 'SEND_MESSAGE') {
    const mode = data.messageMode === 'template' ? 'Template' : 'Text';
    return `Send WhatsApp (${mode})`;
  }
  if (type === 'WAIT') {
    const amount = data.amount ?? 1;
    const unit = data.unit ?? 'hours';
    return `Delay ${amount} ${unit}`;
  }
  if (type === 'TRIGGER') {
    const event = String(data.event ?? 'message.received').replace(/\./g, ' ');
    return `Trigger · ${event}`;
  }
  if (type === 'WEBHOOK') {
    const name = String(data.name ?? '').trim();
    if (name) return name;
    const method = String(data.method ?? 'POST');
    return `HTTP ${method}`;
  }
  return NODE_LABELS[type] ?? type;
}

function resolveWaitUntil(
  logs: Array<{
    nodeId: string | null;
    status: string;
    createdAt: Date;
    payload: unknown;
  }>,
  currentNodeId: string | null
): string | null {
  if (!currentNodeId) return null;

  const pending = [...logs]
    .reverse()
    .find((log) => log.status === 'pending' && log.nodeId === currentNodeId);

  if (!pending) return null;

  const payload = pending.payload as { waitMs?: number } | null;
  const waitMs = payload?.waitMs ?? 0;
  if (waitMs <= 0) return null;

  return new Date(pending.createdAt.getTime() + waitMs).toISOString();
}

export class JourneyProgressService {
  constructor(
    private readonly journeyRepo: JourneyRepository,
    private readonly executionRepo: JourneyExecutionRepository
  ) {}

  async getContactProgress(
    workspaceId: string,
    contactId: string
  ): Promise<ContactJourneyProgress | null> {
    const executions = await this.executionRepo.findForContact(workspaceId, contactId, 5);
    // Newest first — prefer live, else latest finished result (skip cancelled).
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
      if (log.nodeId && log.status === 'success') {
        successNodes.add(log.nodeId);
      }
    }

    const isFailed = execution.status === 'failed';
    const isCompleted = execution.status === 'completed';
    const currentId = execution.currentNodeId;
    const waitUntil =
      execution.status === 'waiting' ? resolveWaitUntil(execution.logs, currentId) : null;

    const steps: JourneyProgressStep[] = [];

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
          detail = 'Step failed';
        } else if (execution.status === 'waiting' && node.type === 'WAIT') {
          state = 'current';
          detail = waitUntil ? undefined : 'Waiting for delay…';
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
        waitUntil:
          state === 'current' && node.type === 'WAIT' ? waitUntil : undefined,
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
