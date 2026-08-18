import { prisma } from '../index.js';
import { decryptSecret } from '../lib/field-encryption.js';

export type TelegramCredentials = {
  botId: string;
  botToken: string;
  botUsername?: string | null;
};

export async function getWorkspaceTelegramCredentials(
  workspaceId: string,
  botIdHint?: string | null
): Promise<TelegramCredentials> {
  const account = botIdHint
    ? await prisma.telegramAccount.findFirst({
        where: { workspaceId, botId: botIdHint },
      })
    : await prisma.telegramAccount.findFirst({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
      });

  const botToken = decryptSecret(account?.botToken);
  if (!account || !botToken) {
    throw new Error('Telegram not connected for this workspace');
  }

  return {
    botId: account.botId,
    botToken,
    botUsername: account.botUsername,
  };
}
