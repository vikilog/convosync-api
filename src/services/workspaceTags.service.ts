import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { groupTagsByFolder, normalizeTagFolder } from '../lib/tagFolders.js';

export type WorkspaceTagRecord = {
  id: string;
  name: string;
  folder: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Default folder for tags explicitly created via the "New Tag" modal with a blank folder. */
const DEFAULT_TAG_FOLDER = 'Tags';

export function isDuplicateTagNameError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    Array.isArray(err.meta?.target) &&
    (err.meta.target as string[]).includes('name')
  );
}

export async function listWorkspaceTags(workspaceId: string) {
  const items = await prisma.workspaceTag.findMany({
    where: { workspaceId },
    orderBy: { name: 'asc' },
  });
  return {
    items,
    groups: groupTagsByFolder(items),
    tags: groupTagsByFolder(items).flatMap((g) => g.items.map((i) => i.name)),
  };
}

/** Create a registry entry from the Settings "New Tag" modal — blank folder defaults to "Tags". */
export async function createWorkspaceTag(
  workspaceId: string,
  input: { name: string; folder?: string | null }
): Promise<WorkspaceTagRecord> {
  const name = input.name.trim();
  if (!name) throw new Error('Tag name is required');
  const folder = normalizeTagFolder(input.folder) ?? DEFAULT_TAG_FOLDER;
  return prisma.workspaceTag.create({ data: { workspaceId, name, folder } });
}

export async function updateWorkspaceTag(
  workspaceId: string,
  id: string,
  input: { name?: string; folder?: string | null }
): Promise<WorkspaceTagRecord> {
  const data: Prisma.WorkspaceTagUpdateInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error('Tag name is required');
    data.name = name;
  }
  if (input.folder !== undefined) {
    data.folder = normalizeTagFolder(input.folder) ?? DEFAULT_TAG_FOLDER;
  }
  const { count } = await prisma.workspaceTag.updateMany({ where: { id, workspaceId }, data });
  if (count === 0) throw new Error('Tag not found');
  return prisma.workspaceTag.findUniqueOrThrow({ where: { id } });
}

export async function deleteWorkspaceTag(workspaceId: string, id: string): Promise<void> {
  await prisma.workspaceTag.deleteMany({ where: { id, workspaceId } });
}

/**
 * Registers tag names in the workspace registry without touching folder assignment for tags
 * that already exist. Called wherever tags get applied to a contact on the fly (contact forms,
 * CSV import, journeys, AI agent actions) so the registry stays complete for pickers.
 * ponytail: best-effort — silently ignores a race-lost create (unique violation is fine, someone
 * else just registered the same name).
 */
export async function registerWorkspaceTags(
  workspaceId: string,
  names: string[],
  folder: string | null = null
): Promise<void> {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (!clean.length) return;
  await prisma.workspaceTag.createMany({
    data: clean.map((name) => ({ workspaceId, name, folder })),
    skipDuplicates: true,
  });
}
