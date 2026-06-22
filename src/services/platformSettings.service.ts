import { prisma } from '../index.js';

const CONFIG_ID = 'default';

export async function getPlatformConfig() {
  const row =
    (await prisma.platformConfig.findUnique({ where: { id: CONFIG_ID } })) ??
    (await prisma.platformConfig.create({
      data: { id: CONFIG_ID, platformName: 'ConvoSync' },
    }));

  return {
    platformName: row.platformName,
    supportEmail: row.supportEmail,
    platformPhone: row.platformPhone,
    platformPhoneNumberId: row.platformPhoneNumberId,
    platformWabaId: row.platformWabaId,
    hasWaToken: Boolean(row.platformWaToken),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function updatePlatformConfig(input: {
  platformName?: string;
  supportEmail?: string | null;
  platformPhone?: string | null;
  platformPhoneNumberId?: string | null;
  platformWabaId?: string | null;
  platformWaToken?: string | null;
}) {
  const row = await prisma.platformConfig.upsert({
    where: { id: CONFIG_ID },
    create: {
      id: CONFIG_ID,
      platformName: input.platformName ?? 'ConvoSync',
      supportEmail: input.supportEmail ?? null,
      platformPhone: input.platformPhone ?? null,
      platformPhoneNumberId: input.platformPhoneNumberId ?? null,
      platformWabaId: input.platformWabaId ?? null,
      platformWaToken: input.platformWaToken ?? null,
    },
    update: {
      ...(input.platformName !== undefined ? { platformName: input.platformName } : {}),
      ...(input.supportEmail !== undefined ? { supportEmail: input.supportEmail } : {}),
      ...(input.platformPhone !== undefined ? { platformPhone: input.platformPhone } : {}),
      ...(input.platformPhoneNumberId !== undefined
        ? { platformPhoneNumberId: input.platformPhoneNumberId }
        : {}),
      ...(input.platformWabaId !== undefined ? { platformWabaId: input.platformWabaId } : {}),
      ...(input.platformWaToken !== undefined ? { platformWaToken: input.platformWaToken } : {}),
    },
  });

  return {
    platformName: row.platformName,
    supportEmail: row.supportEmail,
    platformPhone: row.platformPhone,
    platformPhoneNumberId: row.platformPhoneNumberId,
    platformWabaId: row.platformWabaId,
    hasWaToken: Boolean(row.platformWaToken),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPlatformMessageTemplates() {
  const rows = await prisma.platformMessageTemplate.findMany({
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    language: row.language,
    body: row.body,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function createPlatformMessageTemplate(input: {
  name: string;
  category?: string;
  language?: string;
  body: string;
  status?: string;
}) {
  const row = await prisma.platformMessageTemplate.create({
    data: {
      name: input.name.trim(),
      category: input.category ?? 'utility',
      language: input.language ?? 'en',
      body: input.body.trim(),
      status: input.status ?? 'draft',
    },
  });
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    language: row.language,
    body: row.body,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function updatePlatformMessageTemplate(
  id: string,
  input: Partial<{
    name: string;
    category: string;
    language: string;
    body: string;
    status: string;
  }>
) {
  const row = await prisma.platformMessageTemplate.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.body !== undefined ? { body: input.body.trim() } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    language: row.language,
    body: row.body,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function deletePlatformMessageTemplate(id: string) {
  await prisma.platformMessageTemplate.delete({ where: { id } });
  return { ok: true };
}
