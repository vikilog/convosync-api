import type { Prisma, PrismaClient } from '@prisma/client';
import { recordConversationEvent } from '../../../services/conversation-event.service.js';

export type AgentAction =
  | { type: 'close_conversations' }
  | { type: 'escalate_to_human' }
  | { type: 'add_contact_tags'; config: { tags: string[] } }
  | { type: 'update_contact_attributes'; config: { attributes: Record<string, string> } };

export interface ActionExecutionContext {
  prisma: PrismaClient;
  workspaceId: string;
  conversationId: string;
  contactId: string;
  agentId: string;
  agentName?: string;
  intent: string;
  triggerReason: string;
}

export interface ActionResult {
  type: string;
  success: boolean;
  detail?: string;
  error?: string;
}

const SYSTEM_ESCALATION_FROM =
  process.env.CONVOSYNC_SYSTEM_EMAIL_FROM || 'alerts@mail.convosync.io';

// Lazy: email.service → planUsageGuards → src/index.ts (starts HTTP). Keep off the tags path.
async function sendEscalationEmail(params: {
  workspaceId: string;
  to: string;
  emailIntegrationEnabled: boolean;
  subject: string;
  text: string;
}): Promise<void> {
  if (params.emailIntegrationEnabled) {
    const { getEmailService } = await import('../../email/container.js');
    await getEmailService().sendEmail(params.workspaceId, {
      to: params.to,
      subject: params.subject,
      text: params.text,
    });
    return;
  }
  const { ResendProvider } = await import('../../email/providers/resend.provider.js');
  await new ResendProvider().sendEmail({
    from: SYSTEM_ESCALATION_FROM,
    fromName: 'ConvoSync Alerts',
    to: params.to,
    subject: params.subject,
    text: params.text,
  });
}

const KNOWN_CONTACT_COLUMNS = ['name', 'email', 'phone', 'source', 'journeyStatus'] as const;
type KnownContactColumn = (typeof KNOWN_CONTACT_COLUMNS)[number];
function isKnownColumn(key: string): key is KnownContactColumn {
  return (KNOWN_CONTACT_COLUMNS as readonly string[]).includes(key);
}

function escalationEmailBody(
  ctx: ActionExecutionContext,
  conv: { contact?: { name?: string | null; phone?: string | null } | null } | null
): string {
  return (
    `AI agent escalated a conversation.\n\n` +
    `Reason: ${ctx.triggerReason}\n` +
    `Customer: ${conv?.contact?.name ?? 'Unknown'} (${conv?.contact?.phone ?? 'N/A'})\n` +
    `Conversation ID: ${ctx.conversationId}`
  );
}

export async function executeActions(
  actions: AgentAction[],
  ctx: ActionExecutionContext
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const action of actions) {
    results.push(await executeOne(action, ctx));
  }
  return results;
}

async function executeOne(action: AgentAction, ctx: ActionExecutionContext): Promise<ActionResult> {
  try {
    switch (action.type) {
      case 'close_conversations': {
        await ctx.prisma.conversation.update({
          where: { id: ctx.conversationId },
          data: { status: 'closed' },
        });
        await recordConversationEvent({
          conversationId: ctx.conversationId,
          workspaceId: ctx.workspaceId,
          type: 'CONVERSATION_RESOLVED',
          actorType: 'AI_AGENT',
          actorId: ctx.agentId,
          actorName: ctx.agentName,
          metadata: { reason: ctx.triggerReason },
        });
        return { type: action.type, success: true };
      }

      case 'escalate_to_human': {
        const conv = await ctx.prisma.conversation.findUnique({
          where: { id: ctx.conversationId },
          select: {
            assigneeType: true,
            assigneeId: true,
            contact: { select: { name: true, phone: true } },
          },
        });

        await ctx.prisma.conversation.update({
          where: { id: ctx.conversationId },
          data: {
            assigneeType: 'user',
            assigneeId: null,
            assignedTo: null,
            labels: { push: 'ai-escalated' },
          },
        });

        await recordConversationEvent({
          conversationId: ctx.conversationId,
          workspaceId: ctx.workspaceId,
          type: 'HUMAN_TAKEOVER',
          actorType: 'AI_AGENT',
          actorId: ctx.agentId,
          actorName: ctx.agentName,
          metadata: {
            previousAssigneeType: conv?.assigneeType,
            previousAssigneeId: conv?.assigneeId,
            reason: ctx.triggerReason,
            intent: ctx.intent,
          },
        });

        try {
          const { getIo } = await import('../../../socket.js');
          getIo().to(ctx.workspaceId).emit('conversation_updated', {
            conversationId: ctx.conversationId,
            assigneeType: 'user',
            assigneeId: null,
            reason: 'ai_escalated',
          });
        } catch {
          // socket optional outside HTTP server (scripts / early boot)
        }

        const workspace = await ctx.prisma.workspace.findUnique({
          where: { id: ctx.workspaceId },
          select: { email: true, emailIntegrationEnabled: true },
        });

        if (workspace?.email) {
          try {
            await sendEscalationEmail({
              workspaceId: ctx.workspaceId,
              to: workspace.email,
              emailIntegrationEnabled: workspace.emailIntegrationEnabled,
              subject: `Human handoff needed — ${conv?.contact?.name ?? 'a customer'}`,
              text: escalationEmailBody(ctx, conv),
            });
          } catch (emailErr) {
            console.error('Escalation email failed:', (emailErr as Error).message);
          }
        }

        return { type: action.type, success: true, detail: ctx.triggerReason };
      }

      case 'add_contact_tags': {
        const existing = await ctx.prisma.contact.findUnique({
          where: { id: ctx.contactId },
          select: { tags: true },
        });
        const merged = Array.from(new Set([...(existing?.tags ?? []), ...action.config.tags]));
        await ctx.prisma.contact.update({
          where: { id: ctx.contactId },
          data: { tags: { set: merged } },
        });
        return { type: action.type, success: true, detail: action.config.tags.join(', ') };
      }

      case 'update_contact_attributes': {
        const known: Partial<Record<KnownContactColumn, string>> = {};
        const custom: Record<string, string> = {};

        for (const [key, value] of Object.entries(action.config.attributes)) {
          if (isKnownColumn(key)) known[key] = value;
          else custom[key] = value;
        }

        const existing = Object.keys(custom).length
          ? await ctx.prisma.contact.findUnique({
              where: { id: ctx.contactId },
              select: { customFields: true },
            })
          : null;

        const prevCustom =
          existing?.customFields &&
          typeof existing.customFields === 'object' &&
          !Array.isArray(existing.customFields)
            ? (existing.customFields as Record<string, unknown>)
            : {};

        const mergedCustomFields = Object.keys(custom).length
          ? ({ ...prevCustom, ...custom } as Prisma.InputJsonValue)
          : undefined;

        await ctx.prisma.contact.update({
          where: { id: ctx.contactId },
          data: {
            ...known,
            ...(mergedCustomFields !== undefined ? { customFields: mergedCustomFields } : {}),
          },
        });

        return {
          type: action.type,
          success: true,
          detail: Object.keys(action.config.attributes).join(', '),
        };
      }

      default:
        return {
          type: (action as { type: string }).type,
          success: false,
          error: 'Unknown action type',
        };
    }
  } catch (err) {
    return { type: action.type, success: false, error: (err as Error).message };
  }
}
