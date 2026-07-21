/**
 * App-insight metrics (LLM tokens/cost, calls, AI turn latency, queue depth).
 * Exported via OTel → Collector → Prometheus (`convosync_*` prefix on scrape).
 */
import { metrics, ValueType } from '@opentelemetry/api';

const meter = metrics.getMeter('convosync-backend', '1.0.0');

/** USD per 1M tokens — approximate public list prices (update occasionally). */
const LLM_USD_PER_1M: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'claude-3-5-haiku-latest': { input: 0.8, output: 4 },
  'claude-3-5-sonnet-latest': { input: 3, output: 15 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
};

function priceForModel(model: string): { input: number; output: number } {
  const key = (model || '').trim();
  if (LLM_USD_PER_1M[key]) return LLM_USD_PER_1M[key]!;
  const lower = key.toLowerCase();
  for (const [name, price] of Object.entries(LLM_USD_PER_1M)) {
    if (lower.includes(name.toLowerCase()) || name.toLowerCase().includes(lower)) {
      return price;
    }
  }
  // Safe default ≈ gpt-4o-mini
  return { input: 0.15, output: 0.6 };
}

const llmTokens = meter.createCounter('llm.tokens', {
  description: 'LLM tokens consumed',
  unit: '1',
  valueType: ValueType.INT,
});

const llmCostUsd = meter.createCounter('llm.estimated_cost_usd', {
  description: 'Estimated LLM spend (USD) from approx price table',
  unit: 'USD',
  valueType: ValueType.DOUBLE,
});

const llmDuration = meter.createHistogram('llm.duration', {
  description: 'LLM generate latency',
  unit: 'ms',
  valueType: ValueType.DOUBLE,
});

const aiTurnDuration = meter.createHistogram('ai.agent.turn.duration', {
  description: 'End-to-end AI agent turn (hybrid retrieve + LLM)',
  unit: 'ms',
  valueType: ValueType.DOUBLE,
});

const callEvents = meter.createCounter('call.events', {
  description: 'Voice call lifecycle events',
  unit: '1',
  valueType: ValueType.INT,
});

const callDuration = meter.createHistogram('call.duration', {
  description: 'Call duration when ended',
  unit: 's',
  valueType: ValueType.DOUBLE,
});

const campaignDuration = meter.createHistogram('campaign.broadcast.duration', {
  description: 'Campaign broadcast job duration',
  unit: 'ms',
  valueType: ValueType.DOUBLE,
});

/** Latest queue depths — written by poller, read by ObservableGauges. */
const queueDepthState = new Map<string, { waiting: number; active: number; delayed: number; failed: number }>();

meter
  .createObservableGauge('queue.waiting', {
    description: 'BullMQ jobs waiting',
    unit: '1',
  })
  .addCallback((obs) => {
    for (const [queue, c] of queueDepthState) {
      obs.observe(c.waiting, { queue });
    }
  });

meter
  .createObservableGauge('queue.active', {
    description: 'BullMQ jobs active',
    unit: '1',
  })
  .addCallback((obs) => {
    for (const [queue, c] of queueDepthState) {
      obs.observe(c.active, { queue });
    }
  });

meter
  .createObservableGauge('queue.failed', {
    description: 'BullMQ jobs failed (retained)',
    unit: '1',
  })
  .addCallback((obs) => {
    for (const [queue, c] of queueDepthState) {
      obs.observe(c.failed, { queue });
    }
  });

meter
  .createObservableGauge('queue.delayed', {
    description: 'BullMQ jobs delayed',
    unit: '1',
  })
  .addCallback((obs) => {
    for (const [queue, c] of queueDepthState) {
      obs.observe(c.delayed, { queue });
    }
  });

export function recordLlmUsage(params: {
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  workspaceId?: string;
}) {
  const attrs: Record<string, string> = { model: params.model || 'unknown' };
  if (params.workspaceId) attrs.workspaceId = params.workspaceId;

  const prompt = Math.max(0, params.promptTokens | 0);
  const completion = Math.max(0, params.completionTokens | 0);
  llmTokens.add(prompt, { ...attrs, type: 'prompt' });
  llmTokens.add(completion, { ...attrs, type: 'completion' });

  const price = priceForModel(params.model);
  const cost = (prompt / 1_000_000) * price.input + (completion / 1_000_000) * price.output;
  if (cost > 0) llmCostUsd.add(cost, attrs);

  if (params.durationMs >= 0) llmDuration.record(params.durationMs, attrs);
}

export function recordAiAgentTurn(params: {
  durationMs: number;
  path?: string;
  workspaceId?: string;
  ok: boolean;
}) {
  const attrs: Record<string, string> = {
    ok: params.ok ? 'true' : 'false',
  };
  if (params.path) attrs.path = params.path;
  if (params.workspaceId) attrs.workspaceId = params.workspaceId;
  aiTurnDuration.record(Math.max(0, params.durationMs), attrs);
}

export function recordCallEvent(
  event: 'started' | 'ended' | 'take_over' | 'listen' | 'ai_joined' | 'missed' | 'failed',
  attrs?: { workspaceId?: string; direction?: string }
) {
  callEvents.add(1, {
    event,
    ...(attrs?.workspaceId ? { workspaceId: attrs.workspaceId } : {}),
    ...(attrs?.direction ? { direction: attrs.direction } : {}),
  });
}

export function recordCallDurationSeconds(seconds: number, attrs?: { workspaceId?: string }) {
  if (seconds < 0) return;
  callDuration.record(seconds, attrs?.workspaceId ? { workspaceId: attrs.workspaceId } : {});
}

export function recordCampaignBroadcastDuration(durationMs: number, workspaceId?: string) {
  campaignDuration.record(Math.max(0, durationMs), workspaceId ? { workspaceId } : {});
}

export function setQueueDepths(
  queue: string,
  counts: { waiting: number; active: number; delayed: number; failed: number }
) {
  queueDepthState.set(queue, counts);
}
