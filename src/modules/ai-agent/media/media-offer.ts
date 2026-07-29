import { getRedis } from '../../../lib/redis.js';
import { INTENTS, looksLikeMediaRequest } from '../intent.service.js';

export type PendingMediaOffer = {
  mediaId: string;
  title: string;
  type: string;
};

const OFFER_TTL_SEC = 30 * 60;

function offerKey(workspaceId: string, conversationId: string): string {
  return `ai:media-offer:${workspaceId}:${conversationId}`;
}

/** User confirming a previous "bhej doon?" offer. */
export function looksLikeMediaAffirmation(message: string): boolean {
  const t = message.trim().toLowerCase();
  if (!t) return false;
  if (
    /^(haan+|han+|ha+|yes+|yep|yeah|ok+|okay|sure|ji+|please|pls|bhejo|bhej\s*do|send(\s+it)?|kar\s*do|kr\s*do)[.!]?$/i.test(
      t
    )
  ) {
    return true;
  }
  return /\b(haan|han|yes|ok|okay|sure|bhejo|bhej\s*do|send\s*(it|karo|do)?|please\s*send)\b/i.test(
    t
  );
}

/** Explicit ask or pricing → attach without asking. Never auto-offer on feature/Q&A. */
export function shouldAutoSendMedia(intent: string): boolean {
  return intent === INTENTS.MEDIA_REQUEST || intent === INTENTS.PRICING;
}

/** Only run gallery pick/offer when the user clearly wants a file, or pricing (price-list PDF). */
export function shouldConsiderMediaAttachment(intent: string, message: string): boolean {
  return (
    looksLikeMediaRequest(message) ||
    intent === INTENTS.MEDIA_REQUEST ||
    intent === INTENTS.PRICING
  );
}

export function buildMediaOfferLine(title: string, type: string): string {
  const kind = type === 'pdf' || type === 'document' ? 'PDF' : 'image';
  return `Isse related ${kind} available hai (“${title}”). Bhej doon?`;
}

/** LLM sometimes invents "I can't share images" — treat as bad reply for media asks. */
export function isMediaCapabilityRefusal(reply: string): boolean {
  return /capability nahi|cannot share|can't share|nahi (hai|kar sakta|bhej)|images? share|specific images|share karne ki/i.test(
    reply
  );
}

export function mediaSendAck(title: string): string {
  return `Bilkul — “${title}” bhej raha hoon.`;
}

export function mediaNoMatchReply(): string {
  return 'Gallery me is request se matching image/PDF nahi mili. Thoda specific title batao (jaise price list, brochure, intro image).';
}

export async function getPendingMediaOffer(
  workspaceId: string,
  conversationId: string
): Promise<PendingMediaOffer | null> {
  try {
    const raw = await getRedis().get(offerKey(workspaceId, conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingMediaOffer;
    if (!parsed?.mediaId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function setPendingMediaOffer(
  workspaceId: string,
  conversationId: string,
  offer: PendingMediaOffer
): Promise<void> {
  await getRedis().set(
    offerKey(workspaceId, conversationId),
    JSON.stringify(offer),
    'EX',
    OFFER_TTL_SEC
  );
}

export async function clearPendingMediaOffer(
  workspaceId: string,
  conversationId: string
): Promise<void> {
  await getRedis().del(offerKey(workspaceId, conversationId));
}
