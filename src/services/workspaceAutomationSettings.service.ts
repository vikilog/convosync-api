import { prisma } from '../lib/prisma.js';

export type PersistentMenuItem = {
  id: string;
  title: string;
  type: 'postback' | 'web_url';
  payload?: string;
  url?: string;
};

export type PersistentMenuConfig = {
  enabled: boolean;
  items: PersistentMenuItem[];
};

export type WorkspaceAutomationSettings = {
  automationsPaused: boolean;
  defaultReplyEnabled: boolean;
  defaultReplyText: string | null;
  persistentMenu: PersistentMenuConfig;
};

const EMPTY_MENU: PersistentMenuConfig = { enabled: false, items: [] };

export function parsePersistentMenu(raw: unknown): PersistentMenuConfig {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_MENU, items: [] };
  const obj = raw as Record<string, unknown>;
  const items = Array.isArray(obj.items)
    ? obj.items
        .map((item, i) => {
          if (!item || typeof item !== 'object') return null;
          const row = item as Record<string, unknown>;
          const title = String(row.title ?? '').trim().slice(0, 30);
          if (!title) return null;
          const type = row.type === 'web_url' ? 'web_url' : 'postback';
          return {
            id: String(row.id ?? `item_${i}`).trim() || `item_${i}`,
            title,
            type: type as 'postback' | 'web_url',
            payload: String(row.payload ?? title).trim().slice(0, 1000) || title,
            url: type === 'web_url' ? String(row.url ?? '').trim() : undefined,
          };
        })
        .filter((x): x is PersistentMenuItem => Boolean(x))
        .slice(0, 5)
    : [];
  return { enabled: Boolean(obj.enabled), items };
}

export async function getWorkspaceAutomationSettings(
  workspaceId: string
): Promise<WorkspaceAutomationSettings | null> {
  const row = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      automationsPaused: true,
      defaultReplyEnabled: true,
      defaultReplyText: true,
      persistentMenu: true,
    },
  });
  if (!row) return null;
  return {
    automationsPaused: row.automationsPaused,
    defaultReplyEnabled: row.defaultReplyEnabled,
    defaultReplyText: row.defaultReplyText,
    persistentMenu: parsePersistentMenu(row.persistentMenu),
  };
}

export async function isWorkspaceAutomationsPaused(workspaceId: string): Promise<boolean> {
  const row = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { automationsPaused: true },
  });
  return Boolean(row?.automationsPaused);
}

export async function updateWorkspaceAutomationSettings(
  workspaceId: string,
  patch: Partial<{
    automationsPaused: boolean;
    defaultReplyEnabled: boolean;
    defaultReplyText: string | null;
    persistentMenu: PersistentMenuConfig;
  }>
): Promise<WorkspaceAutomationSettings> {
  const data: Record<string, unknown> = {};
  if (typeof patch.automationsPaused === 'boolean') {
    data.automationsPaused = patch.automationsPaused;
  }
  if (typeof patch.defaultReplyEnabled === 'boolean') {
    data.defaultReplyEnabled = patch.defaultReplyEnabled;
  }
  if (patch.defaultReplyText !== undefined) {
    data.defaultReplyText = patch.defaultReplyText?.trim() || null;
  }
  if (patch.persistentMenu) {
    data.persistentMenu = parsePersistentMenu(patch.persistentMenu);
  }

  const row = await prisma.workspace.update({
    where: { id: workspaceId },
    data,
    select: {
      automationsPaused: true,
      defaultReplyEnabled: true,
      defaultReplyText: true,
      persistentMenu: true,
    },
  });

  return {
    automationsPaused: row.automationsPaused,
    defaultReplyEnabled: row.defaultReplyEnabled,
    defaultReplyText: row.defaultReplyText,
    persistentMenu: parsePersistentMenu(row.persistentMenu),
  };
}
