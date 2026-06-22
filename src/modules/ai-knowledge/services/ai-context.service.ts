import type { AiKnowledgeRepository } from '../repositories/ai-knowledge.repository.js';
import type { AiContextResult, AiContextStatus } from '../types/ai-context.types.js';
import {
  buildContextPayload,
  formatContextForLlm,
  knowledgeToSections,
} from '../utils/context-prompt-formatter.js';
import { resolveSectionsForQuery } from '../utils/query-section-router.js';

export class AiContextService {
  constructor(private readonly repo: AiKnowledgeRepository) {}

  /**
   * Loads synced AI knowledge for a venue and returns only the sections
   * relevant to the user query. Designed for LLM prompt injection — no vector DB.
   */
  async getContextForQuery(
    query: string,
    venueId: string,
    workspaceId: string
  ): Promise<AiContextResult> {
    const record = await this.repo.findByVenue(workspaceId, venueId);
    const resolution = resolveSectionsForQuery(query);

    if (!record) {
      return this.emptyResult(query, venueId, resolution.sections, 'not_synced', null);
    }

    if (record.status === 'failed') {
      return this.emptyResult(query, venueId, resolution.sections, 'sync_failed', null);
    }

    if (record.status !== 'success') {
      return this.emptyResult(query, venueId, resolution.sections, 'not_synced', null);
    }

    const knowledge = knowledgeToSections(record.data);
    const context = buildContextPayload(
      resolution.sections,
      knowledge,
      resolution.salonMode
    );

    const hasContent = Object.values(context).some((value) => {
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === 'object') return Object.keys(value).length > 0;
      return Boolean(value);
    });

    const syncedAt = record.syncedAt?.toISOString() ?? null;

    return {
      venueId,
      query,
      matchedSections: resolution.sections,
      context,
      promptContext: formatContextForLlm(venueId, context, resolution.sections),
      status: hasContent ? 'ready' : 'empty',
      syncedAt,
    };
  }

  private emptyResult(
    query: string,
    venueId: string,
    matchedSections: AiContextResult['matchedSections'],
    status: AiContextStatus,
    syncedAt: string | null
  ): AiContextResult {
    return {
      venueId,
      query,
      matchedSections,
      context: {},
      promptContext: '',
      status,
      syncedAt,
    };
  }
}
