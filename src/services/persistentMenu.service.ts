import axios from 'axios';
import { decryptSecret } from '../lib/field-encryption.js';
import { prisma } from '../lib/prisma.js';
import {
  parsePersistentMenu,
  type PersistentMenuConfig,
  type PersistentMenuItem,
} from './workspaceAutomationSettings.service.js';

function toMetaCallToActions(items: PersistentMenuItem[]) {
  return items.map((item) => {
    if (item.type === 'web_url' && item.url) {
      return {
        type: 'web_url' as const,
        title: item.title,
        url: item.url,
      };
    }
    return {
      type: 'postback' as const,
      title: item.title,
      payload: item.payload || item.title,
    };
  });
}

async function setMessengerProfile(
  pageId: string,
  pageAccessToken: string,
  menu: PersistentMenuConfig,
  platform?: 'instagram'
): Promise<void> {
  const url = `https://graph.facebook.com/v25.0/${pageId}/messenger_profile`;
  const params: Record<string, string> = { access_token: pageAccessToken };
  if (platform) params.platform = platform;

  if (!menu.enabled || menu.items.length === 0) {
    await axios.delete(url, {
      params: { ...params, fields: 'persistent_menu' },
    });
    return;
  }

  await axios.post(
    url,
    {
      persistent_menu: [
        {
          locale: 'default',
          composer_input_disabled: false,
          call_to_actions: toMetaCallToActions(menu.items),
        },
      ],
    },
    { params }
  );
}

/** Sync workspace persistent menu to connected Instagram + Messenger pages. */
export async function syncPersistentMenuToMeta(workspaceId: string): Promise<{
  instagram: 'ok' | 'skipped' | 'error';
  messenger: 'ok' | 'skipped' | 'error';
  errors: string[];
}> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { persistentMenu: true },
  });
  const menu = parsePersistentMenu(workspace?.persistentMenu);
  const errors: string[] = [];
  let instagram: 'ok' | 'skipped' | 'error' = 'skipped';
  let messenger: 'ok' | 'skipped' | 'error' = 'skipped';

  const ig = await prisma.instagramAccount.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
  if (ig) {
    const token = decryptSecret(ig.pageAccessToken);
    if (token) {
      try {
        await setMessengerProfile(ig.pageId, token, menu, 'instagram');
        instagram = 'ok';
      } catch (err) {
        instagram = 'error';
        errors.push(
          `Instagram: ${axios.isAxiosError(err) ? JSON.stringify(err.response?.data ?? err.message) : String(err)}`
        );
      }
    }
  }

  const ms = await prisma.messengerAccount.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
  if (ms) {
    const token = decryptSecret(ms.pageAccessToken);
    if (token) {
      try {
        await setMessengerProfile(ms.pageId, token, menu);
        messenger = 'ok';
      } catch (err) {
        messenger = 'error';
        errors.push(
          `Messenger: ${axios.isAxiosError(err) ? JSON.stringify(err.response?.data ?? err.message) : String(err)}`
        );
      }
    }
  }

  return { instagram, messenger, errors };
}
