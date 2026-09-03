import { prisma } from '../lib/prisma.js';
import { resolveFlowSend } from './whatsappFlowToken.service.js';
import { registerWorkspaceTags } from './workspaceTags.service.js';

/** Flow -> tag applied to the contact when they submit it. */
const FLOW_COMPLETION_TAGS: Record<string, string> = {
  cmtkf35dq0006i62z1kvpn912: 'demo-requested', // SMB outreach — demo request
};

/**
 * Tags a contact when they submit a WhatsApp Flow that has a completion tag
 * configured — lets later automations (e.g. a follow-up nudge) check "did this
 * contact already give us what we asked for" instead of re-pitching them.
 */
export async function tagContactOnFlowCompletion(input: {
  workspaceId: string;
  contactId: string;
  fields: Record<string, unknown>;
}): Promise<void> {
  const flowToken = input.fields.flow_token;
  if (typeof flowToken !== 'string' || !flowToken) return;

  const send = await resolveFlowSend(flowToken);
  if (!send || send.workspaceId !== input.workspaceId) return;

  const tag = FLOW_COMPLETION_TAGS[send.flowId];
  if (!tag) return;

  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, workspaceId: input.workspaceId },
    select: { tags: true },
  });
  if (!contact || contact.tags.includes(tag)) return;

  await prisma.contact.update({
    where: { id: input.contactId },
    data: { tags: [...contact.tags, tag] },
  });
  void registerWorkspaceTags(input.workspaceId, [tag]);
}
