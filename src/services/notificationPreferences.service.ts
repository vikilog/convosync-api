import type { PrismaClient } from '@prisma/client';

export const NOTIFICATION_EVENT_TYPES = ['human_handoff'] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export function isNotificationEventType(value: string): value is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

/** Keys available in email/WA notification templates for human_handoff. */
export const HANDOFF_TEMPLATE_VARS = [
  'customer_name',
  'customer_phone',
  'reason',
  'conversation_id',
  'agent_name',
  'intent',
] as const;

export type EmailRecipientsConfig = {
  workspaceEmail: boolean;
  userIds: string[];
  extraEmails: string[];
};

export type WhatsAppNotifyConfig = {
  enabled: boolean;
  /** E.164 (or local) numbers to page */
  phoneNumbers: string[];
  /** Members whose User.phone should also receive the template */
  userIds: string[];
  templateId: string | null;
  /** Map Meta template variable name → event var key (e.g. var_1 → customer_name) */
  variableMap: Record<string, string>;
};

export type NotificationChannels = {
  email: {
    enabled: boolean;
    recipients: EmailRecipientsConfig;
    subjectTemplate: string;
    bodyTemplate: string;
  };
  whatsapp: WhatsAppNotifyConfig;
  inApp: { enabled: boolean };
};

export type NotificationPreferenceView = {
  eventType: NotificationEventType;
  enabled: boolean;
  channels: NotificationChannels;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const DEFAULT_HANDOFF_EMAIL_SUBJECT =
  'Human handoff needed — {{customer_name}}';

export const DEFAULT_HANDOFF_EMAIL_BODY =
  `AI agent escalated a conversation.\n\n` +
  `Reason: {{reason}}\n` +
  `Customer: {{customer_name}} ({{customer_phone}})\n` +
  `Conversation ID: {{conversation_id}}`;

export function defaultChannels(): NotificationChannels {
  return {
    email: {
      enabled: true,
      recipients: { workspaceEmail: true, userIds: [], extraEmails: [] },
      subjectTemplate: DEFAULT_HANDOFF_EMAIL_SUBJECT,
      bodyTemplate: DEFAULT_HANDOFF_EMAIL_BODY,
    },
    whatsapp: {
      enabled: false,
      phoneNumbers: [],
      userIds: [],
      templateId: null,
      variableMap: {},
    },
    inApp: { enabled: true },
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

function clampText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  const t = value.trim();
  if (!t) return fallback;
  return t.length > max ? t.slice(0, max) : t;
}

/** Replace {{key}} placeholders; unknown keys → empty string. */
export function applyNotifyTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    return vars[key] ?? '';
  });
}

export function parseChannels(raw: unknown): NotificationChannels {
  const base = defaultChannels();
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;

  const email = obj.email && typeof obj.email === 'object' ? (obj.email as Record<string, unknown>) : null;
  if (email) {
    base.email.enabled = email.enabled !== false;
    const recipients =
      email.recipients && typeof email.recipients === 'object'
        ? (email.recipients as Record<string, unknown>)
        : null;
    if (recipients) {
      base.email.recipients = {
        workspaceEmail: recipients.workspaceEmail !== false,
        userIds: asStringArray(recipients.userIds),
        extraEmails: asStringArray(recipients.extraEmails)
          .map((e) => e.trim().toLowerCase())
          .filter((e) => EMAIL_RE.test(e)),
      };
    }
    base.email.subjectTemplate = clampText(
      email.subjectTemplate,
      DEFAULT_HANDOFF_EMAIL_SUBJECT,
      200
    );
    base.email.bodyTemplate = clampText(
      email.bodyTemplate,
      DEFAULT_HANDOFF_EMAIL_BODY,
      5000
    );
  }

  const wa =
    obj.whatsapp && typeof obj.whatsapp === 'object'
      ? (obj.whatsapp as Record<string, unknown>)
      : null;
  if (wa) {
    base.whatsapp.enabled = wa.enabled === true;
    base.whatsapp.phoneNumbers = asStringArray(wa.phoneNumbers)
      .map((p) => p.replace(/[\s()-]/g, ''))
      .filter((p) => p.replace(/\D/g, '').length >= 8)
      .slice(0, 20);
    base.whatsapp.userIds = asStringArray(wa.userIds).slice(0, 50);
    base.whatsapp.templateId =
      typeof wa.templateId === 'string' && wa.templateId.trim()
        ? wa.templateId.trim()
        : null;
    base.whatsapp.variableMap = asStringMap(wa.variableMap);
  }

  const inApp = obj.inApp && typeof obj.inApp === 'object' ? (obj.inApp as Record<string, unknown>) : null;
  if (inApp) {
    base.inApp.enabled = inApp.enabled !== false;
  }

  return base;
}

export function resolveEmailRecipients(params: {
  channels: NotificationChannels;
  workspaceEmail: string | null | undefined;
  memberEmailsByUserId: Map<string, string>;
}): string[] {
  if (!params.channels.email.enabled) return [];
  const out = new Set<string>();
  const { recipients } = params.channels.email;

  if (recipients.workspaceEmail && params.workspaceEmail?.trim()) {
    const e = params.workspaceEmail.trim().toLowerCase();
    if (EMAIL_RE.test(e)) out.add(e);
  }
  for (const userId of recipients.userIds) {
    const e = params.memberEmailsByUserId.get(userId)?.trim().toLowerCase();
    if (e && EMAIL_RE.test(e)) out.add(e);
  }
  for (const e of recipients.extraEmails) {
    const normalized = e.trim().toLowerCase();
    if (EMAIL_RE.test(normalized)) out.add(normalized);
  }
  return [...out];
}

export function resolveWhatsAppPhones(params: {
  channels: NotificationChannels;
  memberPhonesByUserId: Map<string, string>;
}): string[] {
  if (!params.channels.whatsapp.enabled) return [];
  const out = new Set<string>();
  for (const p of params.channels.whatsapp.phoneNumbers) {
    const n = p.replace(/\D/g, '');
    if (n.length >= 8) out.add(n);
  }
  for (const userId of params.channels.whatsapp.userIds) {
    const p = params.memberPhonesByUserId.get(userId)?.replace(/\D/g, '');
    if (p && p.length >= 8) out.add(p);
  }
  return [...out];
}

/** Build ordered body params for a Meta template from variableMap + event vars. */
export function buildWhatsAppBodyParams(
  templateVariables: string[],
  variableMap: Record<string, string>,
  eventVars: Record<string, string>
): string[] {
  return templateVariables.map((tv) => {
    const eventKey = variableMap[tv] || '';
    return (eventKey ? eventVars[eventKey] : undefined) ?? '';
  });
}

export async function getNotificationPreference(
  prisma: PrismaClient,
  workspaceId: string,
  eventType: NotificationEventType
): Promise<NotificationPreferenceView> {
  const row = await prisma.notificationPreference.findUnique({
    where: { workspaceId_eventType: { workspaceId, eventType } },
  });
  if (!row) {
    return { eventType, enabled: true, channels: defaultChannels() };
  }
  return {
    eventType,
    enabled: row.enabled,
    channels: parseChannels(row.channels),
  };
}

export async function listNotificationPreferences(
  prisma: PrismaClient,
  workspaceId: string
): Promise<NotificationPreferenceView[]> {
  return Promise.all(
    NOTIFICATION_EVENT_TYPES.map((eventType) =>
      getNotificationPreference(prisma, workspaceId, eventType)
    )
  );
}

async function filterMemberUserIds(
  prisma: PrismaClient,
  workspaceId: string,
  userIds: string[]
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const members = await prisma.workspaceMembership.findMany({
    where: { workspaceId, userId: { in: userIds } },
    select: { userId: true },
  });
  const allowed = new Set(members.map((m) => m.userId));
  return userIds.filter((id) => allowed.has(id));
}

export async function upsertNotificationPreference(
  prisma: PrismaClient,
  workspaceId: string,
  input: {
    eventType: NotificationEventType;
    enabled?: boolean;
    channels?: unknown;
  }
): Promise<NotificationPreferenceView> {
  const existing = await getNotificationPreference(prisma, workspaceId, input.eventType);
  const channels = input.channels !== undefined ? parseChannels(input.channels) : existing.channels;
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : existing.enabled;

  channels.email.recipients.userIds = await filterMemberUserIds(
    prisma,
    workspaceId,
    channels.email.recipients.userIds
  );
  channels.whatsapp.userIds = await filterMemberUserIds(
    prisma,
    workspaceId,
    channels.whatsapp.userIds
  );

  if (channels.whatsapp.templateId) {
    const tmpl = await prisma.template.findFirst({
      where: {
        id: channels.whatsapp.templateId,
        workspaceId,
        status: 'approved',
      },
      select: { id: true },
    });
    if (!tmpl) {
      channels.whatsapp.templateId = null;
    }
  }

  await prisma.notificationPreference.upsert({
    where: { workspaceId_eventType: { workspaceId, eventType: input.eventType } },
    create: {
      workspaceId,
      eventType: input.eventType,
      enabled,
      channels,
    },
    update: { enabled, channels },
  });

  return { eventType: input.eventType, enabled, channels };
}

async function sendAlertEmail(params: {
  workspaceId: string;
  to: string[];
  emailIntegrationEnabled: boolean;
  subject: string;
  text: string;
}): Promise<void> {
  if (params.to.length === 0) return;
  // Logged/billed channel send when email integration is on (also honors BYO SES).
  if (params.emailIntegrationEnabled) {
    const { getEmailService } = await import('../modules/email/container.js');
    await getEmailService().sendEmail(params.workspaceId, {
      to: params.to.length === 1 ? params.to[0]! : params.to,
      subject: params.subject,
      text: params.text,
    });
    return;
  }
  // Shared helper: WorkspaceEmailConfig SES if active, else platform Resend.
  const { sendWorkspaceEmail } = await import(
    '../modules/email/services/send-workspace-email.js'
  );
  await sendWorkspaceEmail({
    workspaceId: params.workspaceId,
    to: params.to,
    subject: params.subject,
    text: params.text,
    fromName: 'ConvoSync Alerts',
  });
}

export type WorkspaceEventPayload = {
  /** Structured vars for templates — preferred */
  vars: Record<string, string>;
};

/**
 * Fan-out workspace alerts from preferences (email + WhatsApp template paging).
 * In-app (Socket.IO) stays in the caller.
 */
export async function notifyWorkspaceEvent(params: {
  prisma: PrismaClient;
  workspaceId: string;
  eventType: NotificationEventType;
  payload: WorkspaceEventPayload;
}): Promise<{ emailed: string[]; whatsapped: string[] }> {
  const pref = await getNotificationPreference(
    params.prisma,
    params.workspaceId,
    params.eventType
  );
  if (!pref.enabled) return { emailed: [], whatsapped: [] };

  const vars = params.payload.vars;
  const emailed: string[] = [];
  const whatsapped: string[] = [];

  const workspace = await params.prisma.workspace.findUnique({
    where: { id: params.workspaceId },
    select: { email: true, emailIntegrationEnabled: true },
  });
  if (!workspace) return { emailed, whatsapped };

  const allUserIds = [
    ...new Set([
      ...pref.channels.email.recipients.userIds,
      ...pref.channels.whatsapp.userIds,
    ]),
  ];
  const memberEmailsByUserId = new Map<string, string>();
  const memberPhonesByUserId = new Map<string, string>();
  if (allUserIds.length > 0) {
    const members = await params.prisma.workspaceMembership.findMany({
      where: { workspaceId: params.workspaceId, userId: { in: allUserIds } },
      select: {
        userId: true,
        user: { select: { email: true, phone: true } },
      },
    });
    for (const m of members) {
      if (m.user.email) memberEmailsByUserId.set(m.userId, m.user.email);
      if (m.user.phone) memberPhonesByUserId.set(m.userId, m.user.phone);
    }
  }

  if (pref.channels.email.enabled) {
    const to = resolveEmailRecipients({
      channels: pref.channels,
      workspaceEmail: workspace.email,
      memberEmailsByUserId,
    });
    if (to.length > 0) {
      const subject = applyNotifyTemplate(pref.channels.email.subjectTemplate, vars);
      const text = applyNotifyTemplate(pref.channels.email.bodyTemplate, vars);
      try {
        await sendAlertEmail({
          workspaceId: params.workspaceId,
          to,
          emailIntegrationEnabled: workspace.emailIntegrationEnabled,
          subject: subject || DEFAULT_HANDOFF_EMAIL_SUBJECT,
          text: text || DEFAULT_HANDOFF_EMAIL_BODY,
        });
        emailed.push(...to);
      } catch (err) {
        console.error(
          `notifyWorkspaceEvent(${params.eventType}) email failed:`,
          (err as Error).message
        );
      }
    }
  }

  if (pref.channels.whatsapp.enabled && pref.channels.whatsapp.templateId) {
    const phones = resolveWhatsAppPhones({
      channels: pref.channels,
      memberPhonesByUserId,
    });
    if (phones.length > 0) {
      try {
        const template = await params.prisma.template.findFirst({
          where: {
            id: pref.channels.whatsapp.templateId,
            workspaceId: params.workspaceId,
            status: 'approved',
          },
        });
        if (!template) {
          console.error(
            `notifyWorkspaceEvent(${params.eventType}): WhatsApp template missing/not approved`
          );
        } else {
          const { getWorkspaceWhatsAppCredentials } = await import('./whatsappCredentials.js');
          const { sendWhatsAppTemplateMessage } = await import('./whatsapp.js');
          const credentials = await getWorkspaceWhatsAppCredentials(params.workspaceId);
          if (!credentials.phoneNumberId || !credentials.accessToken) {
            console.error(
              `notifyWorkspaceEvent(${params.eventType}): no WhatsApp credentials on workspace`
            );
          } else {
            const bodyParams = buildWhatsAppBodyParams(
              template.variables,
              pref.channels.whatsapp.variableMap,
              vars
            );
            for (const phone of phones) {
              try {
                await sendWhatsAppTemplateMessage(
                  credentials.accessToken,
                  credentials.phoneNumberId,
                  phone,
                  template.name,
                  template.language,
                  bodyParams
                );
                whatsapped.push(phone);
              } catch (waErr) {
                console.error(
                  `notifyWorkspaceEvent WA to ${phone} failed:`,
                  (waErr as Error).message
                );
              }
            }
          }
        }
      } catch (err) {
        console.error(
          `notifyWorkspaceEvent(${params.eventType}) WhatsApp failed:`,
          (err as Error).message
        );
      }
    }
  }

  return { emailed, whatsapped };
}
