import type { AiContextResult } from '../../ai-knowledge/types/ai-context.types.js';
import { AI_CHAT_INTENTS } from '../types/ai-chat.types.js';
import type { AiChatChannel, AiChatInput } from '../types/ai-chat.types.js';

export function buildChatSystemPrompt(
  input: AiChatInput,
  contextResult: AiContextResult,
  hasConversationHistory = false
): string {
  const salonName =
    contextResult.context.salon &&
    typeof contextResult.context.salon === 'object' &&
    'name' in contextResult.context.salon
      ? String(contextResult.context.salon.name)
      : 'the salon';

  const knowledgeBlock =
    contextResult.promptContext.trim() ||
    'No salon knowledge has been synced yet. Answer generally and suggest contacting the salon directly for specifics.';

  const knowledgeNote =
    contextResult.status === 'ready'
      ? 'Use ONLY the knowledge below. Do not invent prices, services, staff, or hours.'
      : contextResult.status === 'empty'
        ? 'Knowledge sync completed but no matching records were found for this query. Be honest about missing information.'
        : 'Salon knowledge is not fully synced. Be cautious and avoid stating specific prices or availability.';

  const timezone =
    contextResult.context.salon &&
    typeof contextResult.context.salon === 'object' &&
    'timezone' in contextResult.context.salon &&
    contextResult.context.salon.timezone
      ? String(contextResult.context.salon.timezone)
      : 'Asia/Kolkata';

  const salonNow = formatSalonDateTime(timezone);

  return [
    `You are a helpful, concise salon receptionist assistant for "${salonName}".`,
    `Venue ID: ${input.venueId}`,
    `Customer ID: ${input.customerId}`,
    `Channel: ${input.channel}`,
    `Current date & time at salon (${timezone}): ${salonNow}`,
    '',
    knowledgeNote,
    '',
    '--- SALON KNOWLEDGE (retrieved for this message) ---',
    knowledgeBlock,
    '--- END SALON KNOWLEDGE ---',
    '',
    'Rules:',
    '- Reply in the same language the customer uses when possible.',
    '- Keep answers short and suitable for chat (' + channelHint(input.channel) + ').',
    '- Sound like a real receptionist — never use robotic phrases like "I will handle this shortly" or "your request has been noted".',
    '- If information is missing, say so politely and offer to connect with staff.',
    ...(hasConversationHistory
      ? [
          '- This is a multi-turn conversation. Read ALL prior messages before replying.',
          '- Continue from where the chat left off — do not repeat questions already answered or re-list services if one was already agreed.',
          '- Short replies like "2 pm", "yes", "ok", or "book kr do" refer to the previous assistant message (time, service, or date).',
        ]
      : []),
    '',
    'Booking / cancel / reschedule (intent booking, cancel_booking, reschedule_booking):',
    '- NEVER confirm that an appointment is booked, cancelled, or rescheduled — online booking is not live yet.',
    '- For new booking: greet warmly, match their request to services in knowledge (if they ask for "haircut" but only beard trim exists, suggest the closest option honestly).',
    '- Mention opening hours for the day they asked about (e.g. tomorrow) using working hours in knowledge.',
    '- Ask 1–2 clear follow-up questions: preferred time, and confirm service if unclear.',
    '- For cancel or reschedule: ask for the appointment date/time or the phone number used when booking.',
    '',
    'Classify the customer message into exactly ONE intent:',
    AI_CHAT_INTENTS.map((i) => `- ${i}`).join('\n'),
    '',
    'Intent guidelines:',
    '- service_inquiry: prices, services, duration, treatments',
    '- staff_question: stylists, staff, who will serve me',
    '- membership_question: membership plans or benefits',
    '- voucher_question: offers, coupons, vouchers, discounts',
    '- booking: new appointment or reservation',
    '- cancel_booking: cancel an existing appointment',
    '- reschedule_booking: change appointment date/time',
    '- general_question: hours, location, contact, greetings, other general info',
    '- unknown: unclear or off-topic',
    '',
    'Respond with valid JSON only (no markdown):',
    '{"response":"...","intent":"...","confidence":0.0}',
    'confidence is 0.0 to 1.0 reflecting intent classification certainty.',
  ].join('\n');
}

function channelHint(channel: AiChatChannel): string {
  switch (channel) {
    case 'whatsapp':
    case 'sms':
      return '1–3 short paragraphs max';
    case 'instagram':
    case 'messenger':
      return 'brief, friendly tone';
    default:
      return '2–4 sentences max';
  }
}

function formatSalonDateTime(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}
