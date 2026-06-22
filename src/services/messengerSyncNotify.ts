import { io } from '../index.js';

export type MessengerSyncPhase =
  | 'started'
  | 'list_page'
  | 'messages_fetch'
  | 'thread_saved'
  | 'completed'
  | 'error';

export type MessengerSyncProgressPayload = {
  workspaceId: string;
  phase: MessengerSyncPhase;
  loadedConversations: number;
  syncedConversations: number;
  importedMessages: number;
  pageNumber?: number;
  message?: string;
  warning?: string;
  hasMore?: boolean;
};

export function emitMessengerSyncProgress(
  workspaceId: string,
  payload: Omit<MessengerSyncProgressPayload, 'workspaceId'>
): void {
  if (!io) return;
  io.to(workspaceId).emit('messenger_sync_progress', { workspaceId, ...payload });
}
