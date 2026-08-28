import { prisma } from '../lib/prisma.js';

/**
 * Records which WhatsAppFlow a freshly generated flow_token belongs to, at the moment
 * it's sent — native send-test, a journey's Send Flow node, or a template's Flow button.
 * The completion webhook only carries the token back (Meta's nfm_reply.name is always the
 * fixed string "flow", never the flow's actual name), so this is the only way to trace a
 * submission back to its flow.
 */
export async function recordFlowSend(input: {
  flowToken: string;
  flowId: string;
  workspaceId: string;
}): Promise<void> {
  await prisma.whatsAppFlowSend.create({
    data: {
      flowToken: input.flowToken,
      flowId: input.flowId,
      workspaceId: input.workspaceId,
    },
  });
}

/** Resolves a completed flow's token back to the WhatsAppFlow it was sent from. */
export async function resolveFlowSend(
  flowToken: string
): Promise<{ flowId: string; workspaceId: string } | null> {
  const send = await prisma.whatsAppFlowSend.findUnique({
    where: { flowToken },
    select: { flowId: true, workspaceId: true },
  });
  return send;
}
