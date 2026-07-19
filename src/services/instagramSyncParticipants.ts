/** Pure Instagram conversation participant helpers (no Graph / DB I/O). */

export type InstagramGraphParticipant = { id?: string; name?: string; username?: string };

export type InstagramGraphMessage = {
  id?: string;
  message?: string;
  from?: InstagramGraphParticipant;
};

export function isInstagramPageSender(
  fromId: string | undefined,
  pageId: string,
  instagramUserId: string
): boolean {
  if (!fromId) return false;
  return fromId === pageId || fromId === instagramUserId;
}

/** Customer = first participant that is not the Page / IG pro account. */
export function pickCustomerParticipant(
  participants: InstagramGraphParticipant[],
  pageId: string,
  instagramUserId: string
): InstagramGraphParticipant | undefined {
  const ours = new Set([pageId, instagramUserId].filter(Boolean));
  return participants.find((participant) => participant.id && !ours.has(participant.id));
}

/**
 * When Meta omits participants (or only returns the business), derive the customer
 * from message `from` — first non-page sender.
 */
export function pickCustomerFromMessages(
  messages: InstagramGraphMessage[],
  pageId: string,
  instagramUserId: string
): InstagramGraphParticipant | undefined {
  for (const msg of messages) {
    const from = msg.from;
    if (from?.id && !isInstagramPageSender(from.id, pageId, instagramUserId)) {
      return from;
    }
  }
  return undefined;
}

export function resolveInstagramThreadCustomer(
  participants: InstagramGraphParticipant[],
  messages: InstagramGraphMessage[],
  pageId: string,
  instagramUserId: string
): InstagramGraphParticipant | undefined {
  return (
    pickCustomerParticipant(participants, pageId, instagramUserId) ||
    pickCustomerFromMessages(messages, pageId, instagramUserId)
  );
}
