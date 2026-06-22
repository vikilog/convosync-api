import type { JourneyRepository } from '../repositories/journey.repository.js';
import type { SaveGraphDto } from '../dto/journey.dto.js';
import type { JourneyGraph, JourneyNodeType } from '../types/journey.types.js';

export class JourneyGraphService {
  constructor(private readonly journeyRepo: JourneyRepository) {}

  getGraph(workspaceId: string, journeyId: string) {
    return this.journeyRepo.getGraph(workspaceId, journeyId);
  }

  saveGraph(workspaceId: string, journeyId: string, dto: SaveGraphDto) {
    const graph: JourneyGraph = {
      nodes: dto.nodes.map((n) => ({
        id: n.id,
        type: n.type as JourneyNodeType,
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
      errors.push('Journey must have exactly one Trigger node');
    }
    if (!graph.nodes.some((n) => n.type === 'END')) {
      errors.push('Journey must have at least one End node');
    }
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
        errors.push(`Edge ${edge.id} references missing nodes`);
      }
    }
    return errors;
  }
}
