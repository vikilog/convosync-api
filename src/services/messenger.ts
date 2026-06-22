import axios from 'axios';
import { formatInstagramSendError, sendInstagramMessage } from './instagram.js';

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

export async function sendMessengerMessage(
  pageId: string,
  pageAccessToken: string,
  recipientPsid: string,
  text: string
): Promise<SendMessengerResult> {
  return sendInstagramMessage(pageId, pageAccessToken, recipientPsid, text);
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
