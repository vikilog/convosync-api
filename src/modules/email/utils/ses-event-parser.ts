import type { EmailLogStatus } from '../types/email.types.js';

/** SNS envelope around SES event notifications (and subscription confirms). */
export type SnsEnvelope = {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  SubscribeURL?: string;
  Token?: string;
  SigningCertURL?: string;
};

export type SesMailEvent = {
  eventType?: string;
  notificationType?: string;
  mail?: {
    messageId?: string;
    destination?: string[];
    commonHeaders?: { subject?: string; from?: string[] };
  };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Array<{ diagnosticCode?: string; emailAddress?: string }>;
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: Array<{ emailAddress?: string }>;
  };
  reject?: { reason?: string };
  click?: { link?: string };
  open?: { ipAddress?: string };
};

export function parseSnsEnvelope(raw: string): SnsEnvelope {
  const parsed = JSON.parse(raw) as SnsEnvelope;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid SNS payload');
  }
  return parsed;
}

export function parseSesEventFromSnsMessage(message: string): SesMailEvent {
  return JSON.parse(message) as SesMailEvent;
}

export function sesEventType(event: SesMailEvent): string {
  return (event.eventType || event.notificationType || '').trim();
}

export function mapSesEventToStatus(eventType: string): EmailLogStatus | null {
  switch (eventType.toLowerCase()) {
    case 'send':
      return 'sent';
    case 'delivery':
      return 'delivered';
    case 'open':
      return 'opened';
    case 'click':
      return 'clicked';
    case 'bounce':
      return 'bounced';
    case 'complaint':
      return 'complained';
    case 'reject':
      return 'rejected';
    case 'renderingfailure':
      return 'failed';
    default:
      return null;
  }
}

export function extractSesEventDetail(event: SesMailEvent): string | undefined {
  const type = sesEventType(event).toLowerCase();
  if (type === 'bounce') {
    const diag = event.bounce?.bouncedRecipients?.[0]?.diagnosticCode;
    const kind = [event.bounce?.bounceType, event.bounce?.bounceSubType]
      .filter(Boolean)
      .join('/');
    if (diag && kind) return `${kind}: ${diag}`;
    return diag || kind || 'Email bounced';
  }
  if (type === 'complaint') {
    return event.complaint?.complaintFeedbackType || 'Complaint received';
  }
  if (type === 'reject') {
    return event.reject?.reason || 'Message rejected';
  }
  if (type === 'click' && event.click?.link) {
    return event.click.link;
  }
  return undefined;
}

export function extractSesMessageId(event: SesMailEvent): string | undefined {
  return event.mail?.messageId?.trim() || undefined;
}
