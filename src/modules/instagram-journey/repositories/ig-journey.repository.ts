import type { Prisma, PrismaClient } from '@prisma/client';
import type { IgJourneyGraph } from '../types/ig-journey.types.js';

export class InstagramJourneyRepository {
  constructor(private readonly db: PrismaClient) {}

  listByWorkspace(workspaceId: string) {
    return this.db.instagramJourney.findMany({
      where: { workspaceId },
      include: {
        _count: { select: { executions: true, nodes: true } },
        nodes: {
          where: { type: 'TRIGGER' },
          select: { data: true },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  findById(workspaceId: string, id: string) {
    return this.db.instagramJourney.findFirst({
      where: { id, workspaceId },
      include: { _count: { select: { executions: true } } },
    });
  }

  create(workspaceId: string, name: string) {
    return this.db.instagramJourney.create({
      data: { name, workspaceId, status: 'draft' },
    });
  }

  update(workspaceId: string, id: string, data: { name?: string; status?: string }) {
    return this.db.instagramJourney.updateMany({
      where: { id, workspaceId },
      data,
    });
  }

  delete(workspaceId: string, id: string) {
    return this.db.instagramJourney.deleteMany({ where: { id, workspaceId } });
  }

  async getGraph(workspaceId: string, journeyId: string): Promise<IgJourneyGraph | null> {
    const journey = await this.db.instagramJourney.findFirst({
      where: { id: journeyId, workspaceId },
      include: { nodes: true, edges: true },
    });
    if (!journey) return null;
    return {
      nodes: journey.nodes.map((n) => ({
        id: n.id,
        type: n.type as IgJourneyGraph['nodes'][0]['type'],
        data: (n.data as Record<string, unknown>) ?? {},
        positionX: n.positionX,
        positionY: n.positionY,
      })),
      edges: journey.edges.map((e) => ({
        id: e.id,
        sourceNodeId: e.sourceNodeId,
        targetNodeId: e.targetNodeId,
        conditionValue: e.conditionValue,
      })),
    };
  }

  async saveGraph(workspaceId: string, journeyId: string, graph: IgJourneyGraph) {
    const journey = await this.db.instagramJourney.findFirst({
      where: { id: journeyId, workspaceId },
    });
    if (!journey) return null;

    await this.db.$transaction(async (tx) => {
      await tx.instagramJourneyEdge.deleteMany({ where: { journeyId } });
      await tx.instagramJourneyNode.deleteMany({ where: { journeyId } });

      if (graph.nodes.length) {
        await tx.instagramJourneyNode.createMany({
          data: graph.nodes.map((node) => ({
            id: node.id,
            journeyId,
            type: node.type,
            data: node.data as Prisma.InputJsonValue,
            positionX: node.positionX,
            positionY: node.positionY,
          })),
        });
      }

      if (graph.edges.length) {
        await tx.instagramJourneyEdge.createMany({
          data: graph.edges.map((edge) => ({
            id: edge.id,
            journeyId,
            sourceNodeId: edge.sourceNodeId,
            targetNodeId: edge.targetNodeId,
            conditionValue: edge.conditionValue ?? null,
          })),
        });
      }

      await tx.instagramJourney.update({
        where: { id: journeyId },
        data: { updatedAt: new Date() },
      });
    });

    return this.getGraph(workspaceId, journeyId);
  }

  findPublishedWithNodes(workspaceId: string) {
    return this.db.instagramJourney.findMany({
      where: { workspaceId, status: 'published' },
      include: { nodes: true, edges: true },
    });
  }

  getNodeWithEdges(journeyId: string, nodeId: string) {
    return this.db.instagramJourneyNode.findFirst({
      where: { id: nodeId, journeyId },
      include: { outgoingEdges: true, journey: true },
    });
  }
}
