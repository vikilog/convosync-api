import { google, type gmail_v1 } from 'googleapis';
import { BaseGoogleProvider, type GoogleProviderContext } from './base.provider.js';

export type GmailMessageSummary = {
  id: string;
  threadId: string | null;
  snippet: string | null;
  labelIds: string[];
  internalDate: string | null;
  from: string;
  to: string;
  subject: string;
  date: string;
  isUnread: boolean;
  isStarred: boolean;
};

function parseHeaders(headers: gmail_v1.Schema$MessagePartHeader[] | undefined) {
  const map = new Map<string, string>();
  for (const h of headers ?? []) {
    if (h.name) map.set(h.name.toLowerCase(), h.value ?? '');
  }
  return map;
}

function decodePartData(data: string | undefined): string {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function extractBodies(payload: gmail_v1.Schema$MessagePart | undefined): {
  text: string;
  html: string;
} {
  if (!payload) return { text: '', html: '' };

  if (payload.body?.data) {
    const decoded = decodePartData(payload.body.data);
    if (payload.mimeType === 'text/html') return { text: '', html: decoded };
    if (payload.mimeType === 'text/plain') return { text: decoded, html: '' };
  }

  let text = '';
  let html = '';
  for (const part of payload.parts ?? []) {
    const nested = extractBodies(part);
    if (!text && nested.text) text = nested.text;
    if (!html && nested.html) html = nested.html;
  }
  return { text, html };
}

function toSummary(msg: gmail_v1.Schema$Message): GmailMessageSummary {
  const headers = parseHeaders(msg.payload?.headers);
  const labelIds = msg.labelIds ?? [];
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? null,
    snippet: msg.snippet ?? null,
    labelIds,
    internalDate: msg.internalDate ?? null,
    from: headers.get('from') ?? '',
    to: headers.get('to') ?? '',
    subject: headers.get('subject') ?? '(No subject)',
    date: headers.get('date') ?? '',
    isUnread: labelIds.includes('UNREAD'),
    isStarred: labelIds.includes('STARRED'),
  };
}

export class GoogleGmailProvider extends BaseGoogleProvider {
  readonly product = 'gmail' as const;

  async connect(ctx: GoogleProviderContext): Promise<Record<string, unknown>> {
    const gmail = google.gmail({ version: 'v1', auth: ctx.auth });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    return {
      emailAddress: profile.data.emailAddress,
      messagesTotal: profile.data.messagesTotal,
      threadsTotal: profile.data.threadsTotal,
    };
  }

  async sendEmail(
    ctx: GoogleProviderContext,
    input: { to: string; subject: string; body: string; html?: boolean }
  ) {
    const gmail = google.gmail({ version: 'v1', auth: ctx.auth });
    const contentType = input.html ? 'text/html' : 'text/plain';
    const raw = [
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      `Content-Type: ${contentType}; charset=utf-8`,
      '',
      input.body,
    ].join('\n');
    const encoded = Buffer.from(raw).toString('base64url');
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encoded },
    });
    return res.data;
  }

  async readMessages(
    ctx: GoogleProviderContext,
    input?: { maxResults?: number; query?: string; pageToken?: string }
  ) {
    const gmail = google.gmail({ version: 'v1', auth: ctx.auth });
    const maxResults = Math.min(input?.maxResults ?? 25, 50);
    const list = await gmail.users.messages.list({
      userId: 'me',
      maxResults,
      q: input?.query,
      pageToken: input?.pageToken,
    });
    const ids = list.data.messages ?? [];
    const messages = await Promise.all(
      ids.map(async (row) => {
        if (!row.id) return null;
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: row.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });
        return toSummary(msg.data);
      })
    );
    return {
      messages: messages.filter((m): m is GmailMessageSummary => m !== null),
      nextPageToken: list.data.nextPageToken ?? null,
      resultSizeEstimate: list.data.resultSizeEstimate ?? null,
    };
  }

  async getMessage(ctx: GoogleProviderContext, messageId: string) {
    const gmail = google.gmail({ version: 'v1', auth: ctx.auth });
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    const bodies = extractBodies(res.data.payload);
    return {
      ...toSummary(res.data),
      bodyText: bodies.text,
      bodyHtml: bodies.html,
    };
  }

  async syncConversations(ctx: GoogleProviderContext, input?: { maxResults?: number }) {
    const messages = await this.readMessages(ctx, {
      maxResults: input?.maxResults ?? 50,
      query: 'in:inbox',
    });
    return {
      syncedAt: new Date().toISOString(),
      ...messages,
    };
  }
}
