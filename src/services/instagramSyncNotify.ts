import { io } from '../index.js';

export type InstagramSyncPhase =
  | 'started'
  | 'list_page'
  | 'messages_fetch'
  | 'thread_saved'
  | 'completed'
  | 'error';

export type InstagramSyncProgressPayload = {
  workspaceId: string;
  phase: InstagramSyncPhase;
  loadedConversations: number;
  syncedConversations: number;
  importedMessages: number;
  pageNumber?: number;
  message?: string;
  warning?: string;
  hasMore?: boolean;
};

export function emitInstagramSyncProgress(
  workspaceId: string,
  payload: Omit<InstagramSyncProgressPayload, 'workspaceId'>
): void {
  if (!io) return;
  io.to(workspaceId).emit('instagram_sync_progress', { workspaceId, ...payload });
}
