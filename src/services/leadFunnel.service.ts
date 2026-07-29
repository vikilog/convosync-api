import { prisma } from '../index.js';

export type PublicLeadFunnelStage = {
  id: string;
  name: string;
  position: number;
  isFinal: boolean;
};

export type PublicLeadFunnel = {
  id: string;
  name: string;
  description: string;
  goal: string;
  leadCount: number;
  stages: PublicLeadFunnelStage[];
  createdAt: string;
  updatedAt: string;
};

export function toPublicStage(row: {
  id: string;
  name: string;
  position: number;
  isFinal?: boolean;
}): PublicLeadFunnelStage {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    isFinal: Boolean(row.isFinal),
  };
}

export function toPublicFunnel(
  row: {
    id: string;
    name: string;
    description: string;
    goal: string;
    createdAt: Date;
    updatedAt: Date;
    _count?: { leads: number };
    stages?: Array<{ id: string; name: string; position: number; isFinal?: boolean }>;
  },
  leadCount?: number
): PublicLeadFunnel {
  const stages = [...(row.stages ?? [])].sort((a, b) => a.position - b.position);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    goal: row.goal,
    leadCount: leadCount ?? row._count?.leads ?? 0,
    stages: stages.map(toPublicStage),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const funnelInclude = {
  _count: { select: { leads: true } },
  stages: { orderBy: [{ position: 'asc' as const }, { createdAt: 'asc' as const }] },
};

/** Ensure at least the default "New" board exists (no full funnel auto-create). */
export async function ensureDefaultNewStage(funnelId: string): Promise<PublicLeadFunnelStage> {
  const existing = await prisma.leadFunnelStage.findFirst({
    where: { funnelId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  if (existing) return toPublicStage(existing);

  const created = await prisma.leadFunnelStage.create({
    data: { funnelId, name: 'New', position: 0 },
  });
  return toPublicStage(created);
}

export async function listLeadFunnels(workspaceId: string): Promise<PublicLeadFunnel[]> {
  const rows = await prisma.leadFunnel.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    include: funnelInclude,
  });
  for (const row of rows) {
    if (row.stages.length === 0) {
      await ensureDefaultNewStage(row.id);
    }
  }
  const refreshed = await prisma.leadFunnel.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    include: funnelInclude,
  });
  return refreshed.map((r) => toPublicFunnel(r));
}

export async function getLeadFunnel(
  workspaceId: string,
  funnelId: string
): Promise<PublicLeadFunnel | null> {
  let row = await prisma.leadFunnel.findFirst({
    where: { id: funnelId, workspaceId },
    include: funnelInclude,
  });
  if (!row) return null;
  if (row.stages.length === 0) {
    await ensureDefaultNewStage(funnelId);
    row = await prisma.leadFunnel.findFirst({
      where: { id: funnelId, workspaceId },
      include: funnelInclude,
    });
  }
  return row ? toPublicFunnel(row) : null;
}

export async function createLeadFunnel(
  workspaceId: string,
  input: { name: string; description?: string; goal?: string }
): Promise<PublicLeadFunnel> {
  const name = input.name.trim();
  if (!name) throw new Error('Name is required');

  const row = await prisma.leadFunnel.create({
    data: {
      workspaceId,
      name,
      description: (input.description || '').trim(),
      goal: (input.goal || '').trim(),
      stages: {
        create: [{ name: 'New', position: 0 }],
      },
    },
    include: funnelInclude,
  });
  return toPublicFunnel(row);
}

export async function updateLeadFunnel(
  workspaceId: string,
  funnelId: string,
  patch: { name?: string; description?: string; goal?: string }
): Promise<PublicLeadFunnel> {
  const existing = await prisma.leadFunnel.findFirst({
    where: { id: funnelId, workspaceId },
  });
  if (!existing) throw new Error('Funnel not found');

  if (patch.name !== undefined && !patch.name.trim()) {
    throw new Error('Name is required');
  }

  const row = await prisma.leadFunnel.update({
    where: { id: funnelId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal.trim() } : {}),
    },
    include: funnelInclude,
  });
  return toPublicFunnel(row);
}

export async function deleteLeadFunnel(
  workspaceId: string,
  funnelId: string
): Promise<void> {
  const existing = await prisma.leadFunnel.findFirst({
    where: { id: funnelId, workspaceId },
  });
  if (!existing) throw new Error('Funnel not found');
  await prisma.leadFunnel.delete({ where: { id: funnelId } });
}

export async function assertFunnelInWorkspace(
  workspaceId: string,
  funnelId: string
): Promise<boolean> {
  const row = await prisma.leadFunnel.findFirst({
    where: { id: funnelId, workspaceId },
    select: { id: true },
  });
  return Boolean(row);
}

export async function getDefaultStageForFunnel(funnelId: string): Promise<PublicLeadFunnelStage> {
  return ensureDefaultNewStage(funnelId);
}

export async function listFunnelStages(
  workspaceId: string,
  funnelId: string
): Promise<PublicLeadFunnelStage[]> {
  const funnel = await prisma.leadFunnel.findFirst({
    where: { id: funnelId, workspaceId },
    select: { id: true },
  });
  if (!funnel) throw new Error('Funnel not found');
  await ensureDefaultNewStage(funnelId);
  const rows = await prisma.leadFunnelStage.findMany({
    where: { funnelId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(toPublicStage);
}

export async function createFunnelStage(
  workspaceId: string,
  funnelId: string,
  input: { name: string; isFinal?: boolean }
): Promise<PublicLeadFunnelStage> {
  const funnel = await prisma.leadFunnel.findFirst({
    where: { id: funnelId, workspaceId },
    select: { id: true },
  });
  if (!funnel) throw new Error('Funnel not found');

  const name = input.name.trim();
  if (!name) throw new Error('Board name is required');

  const existingFinal = await prisma.leadFunnelStage.findFirst({
    where: { funnelId, isFinal: true },
    select: { id: true, position: true },
  });
  if (input.isFinal && existingFinal) {
    throw new Error('Final board already exists');
  }

  let position: number;
  if (existingFinal && !input.isFinal) {
    // Insert before the final board so Final stays last
    position = existingFinal.position;
    await prisma.leadFunnelStage.updateMany({
      where: { funnelId, position: { gte: existingFinal.position } },
      data: { position: { increment: 1 } },
    });
  } else {
    const agg = await prisma.leadFunnelStage.aggregate({
      where: { funnelId },
      _max: { position: true },
    });
    position = (agg._max.position ?? -1) + 1;
  }

  const row = await prisma.leadFunnelStage.create({
    data: {
      funnelId,
      name,
      position,
      isFinal: Boolean(input.isFinal),
    },
  });
  return toPublicStage(row);
}

export async function updateFunnelStage(
  workspaceId: string,
  funnelId: string,
  stageId: string,
  patch: { name?: string; isFinal?: boolean }
): Promise<PublicLeadFunnelStage> {
  const stage = await prisma.leadFunnelStage.findFirst({
    where: { id: stageId, funnelId, funnel: { workspaceId } },
  });
  if (!stage) throw new Error('Board not found');

  if (patch.name !== undefined && !patch.name.trim()) {
    throw new Error('Board name is required');
  }

  if (patch.isFinal === true) {
    await prisma.leadFunnelStage.updateMany({
      where: { funnelId, isFinal: true, NOT: { id: stageId } },
      data: { isFinal: false },
    });
  }

  const row = await prisma.leadFunnelStage.update({
    where: { id: stageId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.isFinal !== undefined ? { isFinal: Boolean(patch.isFinal) } : {}),
    },
  });

  if (patch.name !== undefined) {
    await prisma.lead.updateMany({
      where: { stageId },
      data: { stage: row.name },
    });
  }

  return toPublicStage(row);
}

export async function deleteFunnelStage(
  workspaceId: string,
  funnelId: string,
  stageId: string
): Promise<void> {
  const stages = await prisma.leadFunnelStage.findMany({
    where: { funnelId, funnel: { workspaceId } },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  if (stages.length === 0) throw new Error('Funnel not found');
  if (stages.length <= 1) throw new Error('Keep at least one board (New)');

  const target = stages.find((s) => s.id === stageId);
  if (!target) throw new Error('Board not found');

  const fallback = stages.find((s) => s.id !== stageId)!;
  await prisma.lead.updateMany({
    where: { stageId },
    data: { stageId: fallback.id, stage: fallback.name },
  });
  await prisma.leadFunnelStage.delete({ where: { id: stageId } });
}

export async function assertStageInFunnel(
  funnelId: string,
  stageId: string
): Promise<{ id: string; name: string } | null> {
  const stage = await prisma.leadFunnelStage.findFirst({
    where: { id: stageId, funnelId },
    select: { id: true, name: true },
  });
  return stage;
}

export type FunnelInsights = {
  funnelId: string;
  funnelName: string;
  entered: number;
  converted: number;
  conversionRate: number;
  stageMoves: number;
  avgDaysToConvert: number | null;
  byStage: Array<{ stageId: string; name: string; isFinal: boolean; count: number }>;
};

export async function getFunnelInsights(
  workspaceId: string,
  funnelId: string
): Promise<FunnelInsights | null> {
  const funnel = await prisma.leadFunnel.findFirst({
    where: { id: funnelId, workspaceId },
    include: {
      stages: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
    },
  });
  if (!funnel) return null;

  const leads = await prisma.lead.findMany({
    where: { workspaceId, funnelId },
    select: {
      id: true,
      stageId: true,
      contactId: true,
      createdAt: true,
      activity: true,
    },
  });

  const byStageCount = new Map<string, number>();
  let converted = 0;
  let stageMoves = 0;
  const convertDays: number[] = [];

  for (const lead of leads) {
    if (lead.stageId) {
      byStageCount.set(lead.stageId, (byStageCount.get(lead.stageId) || 0) + 1);
    }
    if (lead.contactId) converted += 1;

    const activity = Array.isArray(lead.activity) ? lead.activity : [];
    let convertedAt: Date | null = null;
    for (const raw of activity) {
      const a = raw as { type?: string; at?: string };
      if (a.type === 'stage_change') stageMoves += 1;
      if (a.type === 'converted' && a.at) {
        const d = new Date(a.at);
        if (!Number.isNaN(d.getTime())) convertedAt = d;
      }
    }
    if (lead.contactId && convertedAt) {
      const days =
        (convertedAt.getTime() - lead.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      if (days >= 0) convertDays.push(days);
    }
  }

  const entered = leads.length;
  const avgDaysToConvert =
    convertDays.length > 0
      ? Math.round((convertDays.reduce((s, n) => s + n, 0) / convertDays.length) * 10) / 10
      : null;

  return {
    funnelId: funnel.id,
    funnelName: funnel.name,
    entered,
    converted,
    conversionRate: entered > 0 ? Math.round((converted / entered) * 1000) / 1000 : 0,
    stageMoves,
    avgDaysToConvert,
    byStage: funnel.stages.map((s) => ({
      stageId: s.id,
      name: s.name,
      isFinal: s.isFinal,
      count: byStageCount.get(s.id) || 0,
    })),
  };
}
