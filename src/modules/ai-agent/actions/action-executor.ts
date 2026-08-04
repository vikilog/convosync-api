import type { Prisma, PrismaClient } from '@prisma/client';
import { recordConversationEvent } from '../../../services/conversation-event.service.js';
import { registerWorkspaceTags } from '../../../services/workspaceTags.service.js';

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

const KNOWN_CONTACT_COLUMNS = ['name', 'email', 'phone', 'source', 'journeyStatus'] as const;
type KnownContactColumn = (typeof KNOWN_CONTACT_COLUMNS)[number];
function isKnownColumn(key: string): key is KnownContactColumn {
  return (KNOWN_CONTACT_COLUMNS as readonly string[]).includes(key);
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

        try {
          const { notifyWorkspaceEvent } = await import(
            '../../../services/notificationPreferences.service.js'
          );
          await notifyWorkspaceEvent({
            prisma: ctx.prisma,
            workspaceId: ctx.workspaceId,
            eventType: 'human_handoff',
            payload: {
              vars: {
                customer_name: conv?.contact?.name?.trim() || 'a customer',
                customer_phone: conv?.contact?.phone?.trim() || 'N/A',
                reason: ctx.triggerReason,
                conversation_id: ctx.conversationId,
                agent_name: ctx.agentName?.trim() || 'AI agent',
                intent: ctx.intent,
              },
            },
          });
        } catch (notifyErr) {
          console.error('Escalation notify failed:', (notifyErr as Error).message);
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
        void registerWorkspaceTags(ctx.workspaceId, action.config.tags);
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
