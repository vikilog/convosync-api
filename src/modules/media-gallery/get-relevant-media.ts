import type { MediaAsset } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AiProviderConfigService } from '../ai-agent/services/ai-provider-config.service.js';
import { LlmClient } from '../ai-agent/services/llm-client.service.js';
import {
  buildMediaSelectPrompt,
  keywordMediaFallback,
  parseMediaPickJson,
  type MediaCatalogItem,
} from './media-match.js';

export type MediaAudienceScope = 'customer' | 'partner';

export type GetRelevantMediaResult =
  | { match: MediaAsset; reason: 'matched' }
  | { match: null; reason: 'none' | 'no_assets' | 'error'; detail?: string };

function toCatalog(item: MediaAsset): MediaCatalogItem {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    description: item.description,
    tags: item.tags,
  };
}

/**
 * Reusable Media Gallery picker — not tied to AI agent.
 * Catalog / agent / future modules call with different `usageFilter`.
 *
 * @param workspaceId tenant (= workspaceId in this app)
 * @param queryText user / customer query
 * @param scope audience filter: customer | partner (includes "both")
 * @param usageFilter e.g. "agent" or "catalog"
 */
export async function getRelevantMedia(
  workspaceId: string,
  queryText: string,
  scope: MediaAudienceScope = 'customer',
  usageFilter: string = 'agent'
): Promise<GetRelevantMediaResult> {
  try {
    // Scope has to be part of the query itself, not a post-fetch filter —
    // filtering in application code after the `take: 40` recency cap meant
    // 40 assets in the WRONG scope (e.g. a batch of partner-only collateral
    // updated more recently than any customer-facing media) could crowd out
    // perfectly valid, older customer-scoped media entirely, silently
    // returning "no media" even though real matches exist further down the
    // table.
    const scoped = await prisma.mediaAsset.findMany({
      where: {
        workspaceId,
        isActive: true,
        usage: { has: usageFilter },
        scope: { in: [scope, 'both'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 40,
    });

    if (scoped.length === 0) return { match: null, reason: 'no_assets' };

    const catalog = scoped.map(toCatalog);
    const resolved = await new AiProviderConfigService(prisma).resolveForWorkspace(workspaceId);
    const llm = new LlmClient(resolved);
    const prompt = buildMediaSelectPrompt(queryText, catalog);
    const { content } = await llm.complete(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      {
        maxTokens: 80,
        temperature: 0,
        jsonMode: true,
        workspaceId,
      }
    );

    let mediaId = parseMediaPickJson(content).mediaId;
    if (!mediaId) mediaId = keywordMediaFallback(queryText, catalog);
    if (!mediaId) return { match: null, reason: 'none' };

    const match = scoped.find((a) => a.id === mediaId) ?? null;
    if (!match) return { match: null, reason: 'none' };
    return { match, reason: 'matched' };
  } catch (err) {
    return {
      match: null,
      reason: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
