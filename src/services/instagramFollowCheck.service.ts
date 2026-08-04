import axios from 'axios';
import type { Contact } from '@prisma/client';
import { parseInstagramScopedUserId } from '../lib/channelContact.js';
import { getWorkspaceInstagramCredentials } from './instagramCredentials.js';

const GRAPH = 'https://graph.facebook.com/v25.0';

/**
 * "Follows your account" condition — Meta User Profile API.
 * GET /{IGSID}?fields=is_user_follow_business&access_token={page_access_token}
 * @see https://developers.facebook.com/docs/messenger-platform/instagram/features/user-profile
 *
 * Requires: Page access token with instagram_manage_messages / instagram_basic (+
 * pages_messaging for the underlying Page). Only resolves once the user has established
 * messaging consent with the business (sent a DM, tapped an icebreaker, or opened the
 * persistent menu) — comment-only users have no consent yet and the Graph call errors.
 *
 * Fail-closed by design: any error (no consent yet, token/permission issue, network) is
 * caught and treated as "not following" rather than throwing, so a bad/expired consent
 * state never crashes the journey — it just routes down the "doesn't match" branch.
 */
export async function checkInstagramFollowsBusiness(
  workspaceId: string,
  contact: Pick<Contact, 'phone'>
): Promise<boolean> {
  const igsid = parseInstagramScopedUserId(contact.phone);
  if (!igsid) return false;

  try {
    const creds = await getWorkspaceInstagramCredentials(workspaceId);
    const res = await axios.get<{ is_user_follow_business?: boolean }>(`${GRAPH}/${igsid}`, {
      params: {
        fields: 'is_user_follow_business',
        access_token: creds.pageAccessToken,
      },
    });
    return Boolean(res.data?.is_user_follow_business);
  } catch (err) {
    const message =
      (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
        ?.message ||
      (err as Error)?.message ||
      'unknown error';
    console.warn('[instagramFollowCheck] is_user_follow_business failed, treating as not-following', {
      workspaceId,
      igsid,
      error: message,
    });
    return false;
  }
}
