import { Prisma } from '@prisma/client';
import { prisma } from '../index.js';

function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function listInstalledApps(workspaceId: string): Promise<string[]> {
  const rows = await prisma.installedApp.findMany({
    where: { workspaceId },
    select: { appId: true },
  });
  return rows.map((r) => r.appId);
}

export async function installApp(workspaceId: string, appId: string): Promise<void> {
  try {
    await prisma.installedApp.create({ data: { workspaceId, appId } });
  } catch (err) {
    if (isPrismaUniqueViolation(err)) return; // already installed — no-op
    throw err;
  }
}

export async function uninstallApp(workspaceId: string, appId: string): Promise<void> {
  await prisma.installedApp.deleteMany({ where: { workspaceId, appId } });
}
