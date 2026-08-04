import { prisma } from '../../../lib/prisma.js';
import { applyConversationAssignee } from '../../../services/conversation-assignee.service.js';
import { onConversationResolved } from '../../../services/conversationThread.service.js';
import { syncLinkedLeadsFromContact } from '../../../services/lead.service.js';

const CONTACT_IDENTITY_KEYS = new Set(['name', 'email', 'phone']);

export async function findActiveConversationForContact(workspaceId: string, contactId: string) {
  return prisma.conversation.findFirst({
    where: { workspaceId, contactId },
    orderBy: [{ status: 'asc' }, { lastMessageAt: 'desc' }],
  });
}

export async function openContactConversation(workspaceId: string, contactId: string) {
  const conv = await findActiveConversationForContact(workspaceId, contactId);
  if (!conv) return null;

  if (conv.status === 'resolved') {
    return prisma.conversation.update({
      where: { id: conv.id },
      data: { status: 'open', unreadCount: conv.unreadCount },
    });
  }

  return prisma.conversation.update({
    where: { id: conv.id },
    data: { status: 'open' },
  });
}

export async function closeContactConversation(
  workspaceId: string,
  contactId: string,
  closingNote?: string
) {
  const conv = await findActiveConversationForContact(workspaceId, contactId);
  if (!conv) return null;

  const note = closingNote?.trim();
  const updated = await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      status: 'resolved',
      ...(note ? { lastMessage: note.slice(0, 500) } : {}),
    },
  });
  await onConversationResolved(updated.id);
  return updated;
}

export async function assignContactConversation(
  workspaceId: string,
  contactId: string,
  assigneeType: 'user' | 'ai' | 'rule_based' | 'journey' | 'unassigned',
  assigneeId?: string
) {
  const conv = await findActiveConversationForContact(workspaceId, contactId);
  if (!conv) return null;

  if (assigneeType === 'unassigned') {
    await prisma.conversation.updateMany({
      where: { id: conv.id, workspaceId },
      data: { assigneeType: null, assigneeId: null, assignedTo: null },
    });
    return conv;
  }

  await applyConversationAssignee(workspaceId, conv.id, {
    assigneeType,
    assigneeId: assigneeId ?? null,
  });
  return conv;
}

function readCustomFieldsRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  return {};
}

export async function mergeContactCustomFields(
  contactId: string,
  fields: Record<string, string>
) {
  if (Object.keys(fields).length === 0) return null;

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { customFields: true },
  });
  const existing = readCustomFieldsRecord(contact?.customFields);

  const columnPatch: { name?: string; email?: string; phone?: string } = {};
  const customPatch: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(fields)) {
    const key = rawKey.trim();
    if (!key) continue;
    const lower = key.toLowerCase();
    if (CONTACT_IDENTITY_KEYS.has(lower)) {
      columnPatch[lower as 'name' | 'email' | 'phone'] = value;
      customPatch[lower] = value;
    } else {
      customPatch[key] = value;
    }
  }

  const updated = await prisma.contact.update({
    where: { id: contactId },
    data: {
      ...columnPatch,
      customFields: { ...existing, ...customPatch } as object,
    },
  });

  if (Object.keys(columnPatch).length > 0) {
    await syncLinkedLeadsFromContact(contactId);
  }
  return updated;
}

export async function updateContactField(
  contactId: string,
  field: 'name' | 'email' | 'phone' | 'journeyStatus' | 'custom',
  value: string,
  customFieldKey?: string
) {
  if (field === 'custom') {
    const key = customFieldKey?.trim() || 'value';
    return mergeContactCustomFields(contactId, { [key]: value });
  }

  const updated = await prisma.contact.update({
    where: { id: contactId },
    data: { [field]: value },
  });

  if (field === 'name' || field === 'email' || field === 'phone') {
    await syncLinkedLeadsFromContact(contactId);
  }
  return updated;
}
