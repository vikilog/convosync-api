import type { Prisma, PrismaClient } from '@prisma/client';
import type { JourneyGraph } from '../types/journey.types.js';

export class JourneyRepository {
  constructor(private readonly db: PrismaClient) {}

  listByWorkspace(workspaceId: string) {
    return this.db.journey.findMany({
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
    return this.db.journey.findFirst({
      where: { id, workspaceId },
      include: {
        _count: { select: { executions: true } },
      },
    });
  }

  create(workspaceId: string, name: string) {
    return this.db.journey.create({
      data: { name, workspaceId, status: 'draft' },
    });
  }

  update(workspaceId: string, id: string, data: { name?: string; status?: string }) {
    return this.db.journey.updateMany({
      where: { id, workspaceId },
      data,
    });
  }

  delete(workspaceId: string, id: string) {
    return this.db.journey.deleteMany({ where: { id, workspaceId } });
  }

  async getGraph(workspaceId: string, journeyId: string): Promise<JourneyGraph | null> {
    const journey = await this.db.journey.findFirst({
      where: { id: journeyId, workspaceId },
      include: { nodes: true, edges: true },
    });
    if (!journey) return null;
    return {
      nodes: journey.nodes.map((n) => ({
        id: n.id,
        type: n.type as JourneyGraph['nodes'][0]['type'],
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

  async saveGraph(workspaceId: string, journeyId: string, graph: JourneyGraph) {
    const journey = await this.db.journey.findFirst({ where: { id: journeyId, workspaceId } });
    if (!journey) return null;

    // Nodes are deleted + recreated wholesale below. currentNodeId on an active
    // execution is a plain string, not an FK, so removing a node a contact is
    // currently parked on would silently strand them (executeNode fails to find
    // the node and marks the execution 'failed' with no alert to anyone).
    const incomingNodeIds = new Set(graph.nodes.map((n) => n.id));
    const stuck = await this.db.journeyExecution.findMany({
      where: { journeyId, status: { in: ['running', 'waiting'] }, currentNodeId: { not: null } },
      select: { currentNodeId: true },
    });
    const blockedNodeIds = new Set(
      stuck
        .map((e) => e.currentNodeId)
        .filter((id): id is string => !!id && !incomingNodeIds.has(id))
    );
    if (blockedNodeIds.size > 0) {
      throw new Error(
        `${blockedNodeIds.size} contact(s) are currently on a step this save would remove. Wait for them to move past it, or leave that step in place.`
      );
    }

    await this.db.$transaction(async (tx) => {
      await tx.journeyEdge.deleteMany({ where: { journeyId } });
      await tx.journeyNode.deleteMany({ where: { journeyId } });

      if (graph.nodes.length) {
        await tx.journeyNode.createMany({
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
        await tx.journeyEdge.createMany({
          data: graph.edges.map((edge) => ({
            id: edge.id,
            journeyId,
            sourceNodeId: edge.sourceNodeId,
            targetNodeId: edge.targetNodeId,
            conditionValue: edge.conditionValue ?? null,
          })),
        });
      }

      await tx.journey.update({
        where: { id: journeyId },
        data: { updatedAt: new Date() },
      });
    });

    return this.getGraph(workspaceId, journeyId);
  }

  findPublishedWithTriggerEvent(workspaceId: string, event: string) {
    return this.db.journey.findMany({
      where: { workspaceId, status: 'published' },
      include: {
        nodes: { where: { type: 'TRIGGER' } },
        edges: true,
      },
    });
  }

  findPublishedById(workspaceId: string, journeyId: string) {
    return this.db.journey.findFirst({
      where: { id: journeyId, workspaceId, status: 'published' },
      include: {
        nodes: true,
        edges: true,
      },
    });
  }

  getNodeWithEdges(journeyId: string, nodeId: string) {
    return this.db.journeyNode.findFirst({
      where: { id: nodeId, journeyId },
      include: {
        outgoingEdges: true,
        journey: true,
      },
    });
  }

  getTriggerNode(journeyId: string) {
    return this.db.journeyNode.findFirst({
      where: { journeyId, type: 'TRIGGER' },
    });
  }
}
