import crypto from 'crypto';
import axios from 'axios';
import { config } from '../../../config.js';
import type { DevelopersRepository } from '../repositories/developers.repository.js';
import type {
  IncomingWebhookRecord,
  OutgoingWebhookRecord,
  WebhookLogRecord,
} from '../types/developers.types.js';
import type {
  CreateOutgoingWebhookDto,
  UpdateIncomingWebhookDto,
  UpdateOutgoingWebhookDto,
} from '../dto/developers.dto.js';

export class WebhooksService {
  constructor(private readonly repo: DevelopersRepository) {}

  async getIncomingWebhook(workspaceId: string): Promise<IncomingWebhookRecord> {
    const row = await this.repo.ensureIncomingWebhook(workspaceId);
    return this.serializeIncoming(row);
  }

  async updateIncomingWebhook(
    workspaceId: string,
    dto: UpdateIncomingWebhookDto
  ): Promise<IncomingWebhookRecord> {
    const secret = dto.regenerateSecret ? crypto.randomBytes(32).toString('hex') : undefined;
    const row = await this.repo.updateIncomingWebhook(workspaceId, {
      enabled: dto.enabled,
      subscribedEvents: dto.subscribedEvents,
      secret,
    });
    return this.serializeIncoming(row);
  }

  async listOutgoingWebhooks(workspaceId: string): Promise<OutgoingWebhookRecord[]> {
    const rows = await this.repo.listOutgoingWebhooks(workspaceId);
    return rows.map((r) => this.serializeOutgoing(r));
  }

  async createOutgoingWebhook(
    workspaceId: string,
    dto: CreateOutgoingWebhookDto
  ): Promise<OutgoingWebhookRecord> {
    const row = await this.repo.createOutgoingWebhook(workspaceId, dto);
    return this.serializeOutgoing(row);
  }

  async updateOutgoingWebhook(
    workspaceId: string,
    id: string,
    dto: UpdateOutgoingWebhookDto
  ): Promise<OutgoingWebhookRecord | null> {
    const row = await this.repo.updateOutgoingWebhook(workspaceId, id, dto);
    return row ? this.serializeOutgoing(row) : null;
  }

  async deleteOutgoingWebhook(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.deleteOutgoingWebhook(workspaceId, id);
  }

  async listWebhookLogs(
    workspaceId: string,
    opts: { direction?: 'incoming' | 'outgoing'; limit: number }
  ): Promise<WebhookLogRecord[]> {
    const rows = await this.repo.listWebhookLogs(workspaceId, opts);
    return rows.map((r) => ({
      id: r.id,
      direction: r.direction as 'incoming' | 'outgoing',
      eventType: r.eventType,
      status: r.status,
      statusCode: r.statusCode,
      attempt: r.attempt,
      errorMessage: r.errorMessage,
      outgoingWebhookId: r.outgoingWebhookId,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async handleIncomingWebhook(
    slug: string,
    secretHeader: string | undefined,
    body: { event?: string; type?: string; data?: unknown }
  ): Promise<{ ok: boolean; error?: string }> {
    const hook = await this.repo.findIncomingBySlug(slug);
    if (!hook || !hook.enabled) {
      return { ok: false, error: 'Webhook not found or disabled' };
    }

    if (!secretHeader || secretHeader !== hook.secret) {
      await this.repo.createWebhookLog({
        workspaceId: hook.workspaceId,
        direction: 'incoming',
        eventType: body.event ?? body.type ?? 'unknown',
        payload: body,
        status: 'failed',
        errorMessage: 'Invalid webhook secret',
      });
      return { ok: false, error: 'Unauthorized' };
    }

    const eventType = body.event ?? body.type ?? 'unknown';

    await this.repo.createWebhookLog({
      workspaceId: hook.workspaceId,
      direction: 'incoming',
      eventType,
      payload: body,
      status: 'success',
      statusCode: 200,
    });
    await this.repo.touchIncomingLastEvent(hook.workspaceId);

    return { ok: true };
  }

  /** Dispatch outbound webhooks for platform events (with retries). */
  async dispatchOutgoingEvent(
    workspaceId: string,
    eventType: string,
    payload: unknown
  ): Promise<void> {
    const hooks = await this.repo.listOutgoingForEvent(workspaceId, eventType);
    if (!hooks.length) return;

    await Promise.all(
      hooks.map(async (hook) => {
        await this.deliverWithRetries(hook, eventType, payload);
      })
    );
  }

  private async deliverWithRetries(
    hook: {
      id: string;
      workspaceId: string;
      url: string;
      secret: string | null;
      maxRetries: number;
      timeoutMs: number;
    },
    eventType: string,
    payload: unknown
  ): Promise<void> {
    const envelope = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    const body = JSON.stringify(envelope);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-ConvoSync-Event': eventType,
    };
    if (hook.secret) {
      headers['X-ConvoSync-Signature'] = crypto
        .createHmac('sha256', hook.secret)
        .update(body)
        .digest('hex');
    }

    let lastError = 'Delivery failed';
    for (let attempt = 1; attempt <= hook.maxRetries + 1; attempt += 1) {
      try {
        const res = await axios.post(hook.url, envelope, {
          headers,
          timeout: hook.timeoutMs,
          validateStatus: () => true,
        });
        const ok = res.status >= 200 && res.status < 300;
        await this.repo.createWebhookLog({
          workspaceId: hook.workspaceId,
          direction: 'outgoing',
          outgoingWebhookId: hook.id,
          eventType,
          payload: envelope,
          status: ok ? 'success' : attempt <= hook.maxRetries ? 'retrying' : 'failed',
          statusCode: res.status,
          responseBody: truncate(String(res.data ?? ''), 2000),
          attempt,
          errorMessage: ok ? undefined : `HTTP ${res.status}`,
          nextRetryAt: ok ? undefined : new Date(Date.now() + attempt * 5000),
        });
        if (ok) return;
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Request failed';
        await this.repo.createWebhookLog({
          workspaceId: hook.workspaceId,
          direction: 'outgoing',
          outgoingWebhookId: hook.id,
          eventType,
          payload: envelope,
          status: attempt <= hook.maxRetries ? 'retrying' : 'failed',
          attempt,
          errorMessage: lastError,
          nextRetryAt: new Date(Date.now() + attempt * 5000),
        });
      }
    }
    console.warn(`[Developers] Outgoing webhook ${hook.id} failed: ${lastError}`);
  }

  private serializeIncoming(row: {
    id: string;
    slug: string;
    secret: string;
    enabled: boolean;
    subscribedEvents: string[];
    lastEventAt: Date | null;
    createdAt: Date;
  }): IncomingWebhookRecord {
    return {
      id: row.id,
      slug: row.slug,
      secret: row.secret,
      enabled: row.enabled,
      subscribedEvents: row.subscribedEvents,
      webhookUrl: `${config.backendPublicUrl}/api/developers/incoming/${row.slug}`,
      lastEventAt: row.lastEventAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private serializeOutgoing(row: {
    id: string;
    name: string;
    url: string;
    secret: string | null;
    enabled: boolean;
    subscribedEvents: string[];
    maxRetries: number;
    timeoutMs: number;
    createdAt: Date;
    updatedAt: Date;
  }): OutgoingWebhookRecord {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      secret: row.secret,
      enabled: row.enabled,
      subscribedEvents: row.subscribedEvents,
      maxRetries: row.maxRetries,
      timeoutMs: row.timeoutMs,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
