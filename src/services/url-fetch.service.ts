import axios, { AxiosError } from 'axios';
import { prisma } from '../index.js';
import {
  indexKnowledgeItemInBackground,
  knowledgeIndexService,
} from '../modules/ai-agent/knowledge/knowledge-index.service.js';
import { extractTextFromHtml, wordCountOf } from './html-text-extract.js';

const FETCH_TIMEOUT_MS = 10_000;
const RATE_LIMIT_MS = 60 * 60 * 1000;

const NON_HTML_TYPES = [
  'application/pdf',
  'image/',
  'video/',
  'audio/',
  'application/octet-stream',
];

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new UrlFetchError('Please enter a valid URL', 'INVALID_URL', 400);
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export { extractTextFromHtml } from './html-text-extract.js';

export async function fetchUrlKnowledge(params: {
  agentId: string;
  workspaceId: string;
  url: string;
  refreshInterval: string;
}): Promise<{
  success: true;
  title: string;
  wordCount: number;
  preview: string;
  item: Awaited<ReturnType<typeof prisma.aiAgentKnowledgeItem.create>>;
}> {
  const normalizedUrl = normalizeUrl(params.url);
  if (!isValidUrl(normalizedUrl)) {
    throw new UrlFetchError('Please enter a valid URL', 'INVALID_URL', 400);
  }

  const oneHourAgo = new Date(Date.now() - RATE_LIMIT_MS);
  const recent = await prisma.aiAgentKnowledgeItem.findFirst({
    where: {
      agentId: params.agentId,
      type: 'online_data',
      url: normalizedUrl,
      createdAt: { gte: oneHourAgo },
    },
    orderBy: { createdAt: 'desc' },
  });
  // Allow retry when the last fetch captured no usable text (e.g. SPA shell before meta fallback).
  const recentWordCount = Number(
    (recent?.metadata as { wordCount?: number } | null)?.wordCount ?? -1
  );
  if (recent && recentWordCount > 0) {
    throw new UrlFetchError(
      'This URL was fetched recently. Please wait up to an hour before fetching again.',
      'RATE_LIMITED',
      429
    );
  }
  if (recent && recentWordCount <= 0) {
    await knowledgeIndexService.deleteItemVectors(params.workspaceId, recent.id);
    await prisma.aiAgentKnowledgeItem.delete({ where: { id: recent.id } });
  }

  let response;
  try {
    response = await axios.get<string>(normalizedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 5,
      responseType: 'text',
      validateStatus: (status) => status < 500,
    });
  } catch (err) {
    throw mapFetchError(err);
  }

  if (response.status === 401 || response.status === 403) {
    throw new UrlFetchError('This website blocks automated access', 'ACCESS_DENIED', 403);
  }
  if (response.status >= 400) {
    throw new UrlFetchError(
      'Could not fetch this URL. Please check if the URL is publicly accessible.',
      'FETCH_FAILED',
      400
    );
  }

  const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
  if (NON_HTML_TYPES.some((t) => contentType.includes(t))) {
    throw new UrlFetchError(
      'This URL contains a file. Please use Document upload instead.',
      'NON_HTML',
      400
    );
  }

  const html = typeof response.data === 'string' ? response.data : '';
  if (!html.trim()) {
    throw new UrlFetchError(
      'Could not fetch this URL. Please check if the URL is publicly accessible.',
      'EMPTY_RESPONSE',
      400
    );
  }

  const { title, metaDesc, bodyText, source } = extractTextFromHtml(html);
  const wordCount = wordCountOf(bodyText);

  if (wordCount === 0) {
    throw new UrlFetchError(
      'No readable text found on this page (it may be JavaScript-rendered). Paste the content as a Document or Q&A instead.',
      'NO_TEXT',
      422
    );
  }

  const displayTitle = title || normalizedUrl;
  const extractedContent = `Title: ${displayTitle}\nDescription: ${metaDesc}\nContent: ${bodyText}`;
  const preview = bodyText.substring(0, 200);

  const item = await prisma.aiAgentKnowledgeItem.create({
    data: {
      agentId: params.agentId,
      type: 'online_data',
      title: displayTitle,
      content: extractedContent,
      url: normalizedUrl,
      metadata: {
        refreshInterval: params.refreshInterval,
        lastFetched: new Date().toISOString(),
        wordCount,
        extractSource: source,
      },
      status: 'ready',
    },
  });

  void indexKnowledgeItemInBackground(params.workspaceId, item);

  return {
    success: true,
    title: displayTitle,
    wordCount,
    preview,
    item,
  };
}

function mapFetchError(err: unknown): UrlFetchError {
  if (err instanceof UrlFetchError) return err;
  if (err instanceof AxiosError) {
    if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      return new UrlFetchError('Website took too long to respond', 'TIMEOUT', 408);
    }
    if (err.response?.status === 401 || err.response?.status === 403) {
      return new UrlFetchError('This website blocks automated access', 'ACCESS_DENIED', 403);
    }
  }
  return new UrlFetchError(
    'Could not fetch this URL. Please check if the URL is publicly accessible.',
    'FETCH_FAILED',
    400
  );
}

export class UrlFetchError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'UrlFetchError';
  }
}
