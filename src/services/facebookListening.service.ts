import axios from 'axios';
import { getWorkspaceFacebookPageCredentials } from './facebookCredentials.js';

const GRAPH = 'https://graph.facebook.com/v25.0';

function graphErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return err.response?.data?.error?.message || JSON.stringify(err.response?.data) || err.message;
  }
  return err instanceof Error ? err.message : 'Facebook Graph API request failed';
}

async function resolveFacebookCredentials(workspaceId: string) {
  const creds = await getWorkspaceFacebookPageCredentials(workspaceId);
  if (!creds) throw new Error('Facebook Page not connected for this workspace');
  return creds;
}

/** Public reply on a Facebook Page comment — POST /{comment-id}/comments. */
export async function replyToFacebookComment(
  workspaceId: string,
  commentId: string,
  message: string
): Promise<{ id: string }> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error('Reply message is required');

  const creds = await resolveFacebookCredentials(workspaceId);

  try {
    const res = await axios.post<{ id?: string }>(
      `${GRAPH}/${commentId}/comments`,
      { message: trimmed },
      { params: { access_token: creds.pageAccessToken } }
    );
    if (!res.data?.id) throw new Error('Reply failed — no comment id returned');
    return { id: res.data.id };
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

/**
 * Meta Private Reply — DM to commenter within ~7 days of the comment.
 * POST /{page-id}/messages with recipient.comment_id — same mechanism
 * Instagram uses in instagramListening.service.ts, just Page id/token
 * instead of the IG business account id/token.
 * @see https://developers.facebook.com/docs/messenger-platform/reference/send-api/#private_replies
 */
export async function sendFacebookPrivateReply(
  workspaceId: string,
  commentId: string,
  message: string
): Promise<{ messageId: string; recipientId?: string }> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error('DM message is required');

  const creds = await resolveFacebookCredentials(workspaceId);

  try {
    const res = await axios.post<{ message_id?: string; recipient_id?: string }>(
      `${GRAPH}/${creds.pageId}/messages`,
      {
        recipient: { comment_id: commentId },
        message: { text: trimmed },
      },
      {
        params: { access_token: creds.pageAccessToken },
        headers: { 'Content-Type': 'application/json' },
      }
    );

    console.info('[facebook.private_reply] ok', {
      pageId: creds.pageId,
      commentId,
      messageId: res.data?.message_id,
      recipientId: res.data?.recipient_id,
    });

    if (!res.data?.message_id) throw new Error('Private reply failed — no message id returned');
    return { messageId: res.data.message_id, recipientId: res.data.recipient_id };
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

/** Hide/unhide a Facebook Page comment — POST /{comment-id} with is_hidden. */
export async function hideFacebookComment(
  workspaceId: string,
  commentId: string,
  hidden: boolean
): Promise<void> {
  const creds = await resolveFacebookCredentials(workspaceId);

  try {
    await axios.post(`${GRAPH}/${commentId}`, null, {
      params: {
        is_hidden: hidden !== false,
        access_token: creds.pageAccessToken,
      },
    });
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}

/** Permanently delete a Facebook Page comment — DELETE /{comment-id}. */
export async function deleteFacebookComment(
  workspaceId: string,
  commentId: string
): Promise<void> {
  const creds = await resolveFacebookCredentials(workspaceId);

  try {
    await axios.delete(`${GRAPH}/${commentId}`, {
      params: { access_token: creds.pageAccessToken },
    });
  } catch (err) {
    throw new Error(graphErrorMessage(err));
  }
}
