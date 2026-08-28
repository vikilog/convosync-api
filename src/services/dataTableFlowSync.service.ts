import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { resolveFlowSend } from './whatsappFlowToken.service.js';

/**
 * Appends one DataTableRow when an inbound WhatsApp Flow response belongs to a
 * flow connected to a Data Table — regardless of whether the response arrived
 * via a journey, a campaign template button, or a manual test-send, since all
 * three land here through the same webhook. Matched via the flow_token that was
 * recorded (recordFlowSend) when the flow was sent: Meta's nfm_reply.name is
 * always the fixed string "flow", never the flow's actual name, so it can't be
 * used to identify which flow was submitted.
 */
export async function syncFlowResponseToDataTable(input: {
  workspaceId: string;
  fields: Record<string, unknown>;
}): Promise<void> {
  const flowToken = input.fields.flow_token;
  if (typeof flowToken !== 'string' || !flowToken) return;

  const send = await resolveFlowSend(flowToken);
  if (!send || send.workspaceId !== input.workspaceId) return;

  const flow = await prisma.whatsAppFlow.findFirst({
    where: { id: send.flowId, workspaceId: input.workspaceId, dataTableId: { not: null } },
    select: { dataTableId: true, dataTableFieldMap: true },
  });
  if (!flow?.dataTableId) return;

  const fieldMap = (flow.dataTableFieldMap as Record<string, string> | null) ?? {};
  const columns = await prisma.dataTableColumn.findMany({
    where: { tableId: flow.dataTableId },
    select: { key: true, type: true },
  });
  const columnTypes = new Map(columns.map((c) => [c.key, c.type]));

  const data: Record<string, unknown> = {};
  for (const [columnKey, flowFieldName] of Object.entries(fieldMap)) {
    if (!columnTypes.has(columnKey)) continue;
    const value = input.fields[flowFieldName];
    if (value === undefined) continue;
    data[columnKey] = value === null ? null : String(value);
  }
  if (Object.keys(data).length === 0) return;

  await prisma.dataTableRow.create({
    data: {
      tableId: flow.dataTableId,
      data: data as Prisma.InputJsonValue,
      source: 'flow',
    },
  });
}
