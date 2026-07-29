import axios from 'axios';
import { formatInstagramSendError, sendInstagramMessage } from './instagram.js';
import {
  sendInstagramMediaMessage,
  type InstagramAttachmentKind,
} from './instagramMedia.js';

export type MessengerUserProfile = {
  first_name?: string;
  last_name?: string;
  name?: string;
  profile_pic?: string;
};

export type SendMessengerResult = {
  messageId: string;
};

export { formatInstagramSendError as formatMessengerSendError };

/** Meta Page Send API — same endpoint/shape as Instagram messaging. */
export async function sendMessengerMessage(
  pageId: string,
  pageAccessToken: string,
  recipientPsid: string,
  text: string
): Promise<SendMessengerResult> {
  return sendInstagramMessage(pageId, pageAccessToken, recipientPsid, text);
}

export async function sendMessengerMediaMessage(
  pageId: string,
  pageAccessToken: string,
  recipientPsid: string,
  kind: InstagramAttachmentKind,
  mediaUrl: string
): Promise<SendMessengerResult> {
  return sendInstagramMediaMessage(pageId, pageAccessToken, recipientPsid, kind, mediaUrl);
}

export async function fetchMessengerUserProfile(
  psid: string,
  pageAccessToken: string
): Promise<MessengerUserProfile> {
  try {
    const res = await axios.get(`https://graph.facebook.com/v25.0/${psid}`, {
      params: {
        fields: 'first_name,last_name,name,profile_pic',
        access_token: pageAccessToken,
      },
    });
    return res.data as MessengerUserProfile;
  } catch {
    return { name: `Messenger ${psid.slice(-6)}` };
  }
}

export function resolveMessengerContactName(profile: MessengerUserProfile, psid: string): string {
  if (profile.name?.trim()) return profile.name.trim();
  const parts = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
  if (parts) return parts;
  return `Messenger ${psid.slice(-6)}`;
}
