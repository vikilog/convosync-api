import type { InstagramJourneyRepository } from '../repositories/ig-journey.repository.js';
import type { SaveIgGraphDto } from '../dto/ig-journey.dto.js';
import type { IgJourneyGraph, IgJourneyNodeType } from '../types/ig-journey.types.js';
import {
  IG_TRIGGER_EVENTS,
  findDisallowedSendMessageBlockTypes,
  findDisallowedSendMessageKeys,
  normalizeIgTriggerEvents,
} from '../types/ig-journey.types.js';

export class InstagramJourneyGraphService {
  constructor(private readonly journeyRepo: InstagramJourneyRepository) {}

  getGraph(workspaceId: string, journeyId: string) {
    return this.journeyRepo.getGraph(workspaceId, journeyId);
  }

  saveGraph(workspaceId: string, journeyId: string, dto: SaveIgGraphDto) {
    const graph: IgJourneyGraph = {
      nodes: dto.nodes.map((n) => ({
        id: n.id,
        type: n.type as IgJourneyNodeType,
        data: n.data,
        positionX: n.positionX,
        positionY: n.positionY,
      })),
      edges: dto.edges.map((e) => ({
        id: e.id,
        sourceNodeId: e.sourceNodeId,
        targetNodeId: e.targetNodeId,
        conditionValue: e.conditionValue ?? null,
      })),
    };
    return this.journeyRepo.saveGraph(workspaceId, journeyId, graph);
  }

  async validateForPublish(workspaceId: string, journeyId: string): Promise<string[]> {
    const graph = await this.journeyRepo.getGraph(workspaceId, journeyId);
    if (!graph) return ['Journey not found'];
    const errors: string[] = [];
    const triggers = graph.nodes.filter((n) => n.type === 'TRIGGER');
    if (triggers.length !== 1) {
      errors.push('Must have exactly one Trigger');
    } else {
      const events = normalizeIgTriggerEvents(triggers[0].data as Record<string, unknown>);
      const allowed = new Set(IG_TRIGGER_EVENTS.map((e) => e.value));
      if (events.length === 0) {
        errors.push('Trigger needs at least one event (DM or Comment)');
      }
      for (const event of events) {
        if (!allowed.has(event)) {
          errors.push(`Unknown trigger event: ${event}`);
        }
      }
    }
    if (!graph.nodes.some((n) => n.type === 'END')) {
      errors.push('Must have at least one End node');
    }
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
        errors.push(`Edge ${edge.id} references missing nodes`);
      }
    }
    for (const node of graph.nodes) {
      if (node.type !== 'SEND_MESSAGE') continue;
      const disallowed = findDisallowedSendMessageKeys(node.data as Record<string, unknown>);
      if (disallowed.length > 0) {
        errors.push(
          `Send Message step is Private Reply — remove unsupported content (${disallowed.join(', ')}); Meta only allows text and buttons on a comment reply`
        );
      }
      const disallowedBlocks = findDisallowedSendMessageBlockTypes(node.data as Record<string, unknown>);
      if (disallowedBlocks.length > 0) {
        errors.push(
          `Send Message step is Private Reply — remove ${disallowedBlocks.join(', ')} block(s); Meta only allows text and buttons on a comment reply`
        );
      }
    }
    for (const node of graph.nodes) {
      if (node.type !== 'ASK_QUESTION') continue;
      const replies = (node.data as { quickReplies?: unknown }).quickReplies;
      if (!Array.isArray(replies)) continue;
      if (replies.length > 13) {
        errors.push('Ask Question allows at most 13 quick replies');
      }
      for (const r of replies) {
        const title = typeof r === 'object' && r && 'title' in r ? String((r as { title: unknown }).title) : '';
        if (title.length > 20) {
          errors.push(`Quick reply title too long (max 20): "${title.slice(0, 24)}…"`);
        }
      }
    }
    return errors;
  }
}
