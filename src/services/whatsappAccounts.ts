import { prisma } from '../index.js';

/** Backfill WhatsAppPhoneAccount from legacy workspace fields after schema upgrade. */
export async function ensureWhatsAppAccountsMigrated(workspaceId: string) {
  const existing = await prisma.whatsAppPhoneAccount.count({ where: { workspaceId } });
  if (existing > 0) return;

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { waNumberId: true, wabaId: true, waPhoneNumber: true },
  });

  if (!workspace?.waNumberId || !workspace.wabaId) return;

  await prisma.whatsAppPhoneAccount.create({
    data: {
      workspaceId,
      phoneNumberId: workspace.waNumberId,
      wabaId: workspace.wabaId,
      phoneNumber: workspace.waPhoneNumber,
    },
  });
}

export async function listWhatsAppAccounts(workspaceId: string) {
  await ensureWhatsAppAccountsMigrated(workspaceId);
  return prisma.whatsAppPhoneAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
  });
}
