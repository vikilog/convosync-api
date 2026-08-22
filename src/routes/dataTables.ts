import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getJwtUser } from '../middleware/auth.js';
import { companyAuth } from '../middleware/workspaceScope.js';

/**
 * User-designed "Data" tables: the user defines columns with types, then rows
 * come in either by manual entry (this API) or by connecting a WhatsAppFlow so
 * every submission of that flow appends a row (see conversation-inbound-router
 * / webhooks.ts flow-response handling).
 */

const COLUMN_TYPES = ['text', 'number', 'date', 'boolean', 'select', 'phone', 'email'] as const;

function slugifyKey(label: string): string {
  const base = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'field';
}

function uniqueKey(label: string, taken: Set<string>): string {
  const base = slugifyKey(label);
  let key = base;
  let n = 2;
  while (taken.has(key)) {
    key = `${base}_${n}`;
    n += 1;
  }
  taken.add(key);
  return key;
}

const columnInputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  type: z.enum(COLUMN_TYPES),
  options: z.array(z.string().trim().min(1)).max(50).optional(),
});

const createTableSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  columns: z.array(columnInputSchema).min(1).max(50),
});

const updateTableSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

const addColumnSchema = columnInputSchema;

const updateColumnSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  options: z.array(z.string().trim().min(1)).max(50).optional(),
});

const rowDataSchema = z.record(z.string(), z.unknown());

function serializeTable(row: {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  columns: Array<{
    id: string;
    key: string;
    label: string;
    type: string;
    options: unknown;
    order: number;
  }>;
  _count?: { rows: number };
}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rowCount: row._count?.rows ?? 0,
    columns: [...row.columns]
      .sort((a, b) => a.order - b.order)
      .map((c) => ({
        id: c.id,
        key: c.key,
        label: c.label,
        type: c.type,
        options: (c.options as string[] | null) ?? undefined,
      })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeRow(row: { id: string; data: unknown; source: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: row.id,
    data: (row.data as Record<string, unknown>) ?? {},
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Drop keys from row data that no longer match any column, coerce booleans/numbers loosely. */
function sanitizeRowData(
  input: Record<string, unknown>,
  columns: Array<{ key: string; type: string }>
): Prisma.InputJsonValue {
  const byKey = new Map(columns.map((c) => [c.key, c.type]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const type = byKey.get(key);
    if (!type || value === undefined) continue;
    if (value === null || value === '') {
      out[key] = null;
      continue;
    }
    if (type === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      out[key] = Number.isFinite(n) ? n : null;
    } else if (type === 'boolean') {
      out[key] = value === true || value === 'true';
    } else {
      out[key] = String(value);
    }
  }
  return out as Prisma.InputJsonValue;
}

export default async function dataTableRoutes(fastify: FastifyInstance) {
  fastify.get('/', companyAuth, async (request) => {
    const { workspaceId } = getJwtUser(request);
    const rows = await prisma.dataTable.findMany({
      where: { workspaceId },
      include: { columns: true, _count: { select: { rows: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    return { items: rows.map(serializeTable) };
  });

  fastify.get('/:id', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const row = await prisma.dataTable.findFirst({
      where: { id, workspaceId },
      include: { columns: true, _count: { select: { rows: true } } },
    });
    if (!row) return reply.code(404).send({ error: 'Table not found' });
    return { item: serializeTable(row) };
  });

  fastify.post('/', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const body = createTableSchema.parse(request.body ?? {});

    const existing = await prisma.dataTable.findFirst({
      where: { workspaceId, name: body.name },
      select: { id: true },
    });
    if (existing) return reply.code(409).send({ error: 'A table with this name already exists' });

    const taken = new Set<string>();
    const columns = body.columns.map((c, i) => ({
      key: uniqueKey(c.label, taken),
      label: c.label,
      type: c.type,
      options: c.type === 'select' ? (c.options ?? []) : undefined,
      order: i,
    }));

    const row = await prisma.dataTable.create({
      data: {
        workspaceId,
        name: body.name,
        description: body.description || null,
        columns: {
          create: columns.map((c) => ({
            key: c.key,
            label: c.label,
            type: c.type,
            options: c.options as unknown as Prisma.InputJsonValue,
            order: c.order,
          })),
        },
      },
      include: { columns: true, _count: { select: { rows: true } } },
    });
    return reply.code(201).send({ item: serializeTable(row) });
  });

  fastify.put('/:id', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = updateTableSchema.parse(request.body ?? {});

    const existing = await prisma.dataTable.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Table not found' });

    if (body.name && body.name !== existing.name) {
      const nameTaken = await prisma.dataTable.findFirst({
        where: { workspaceId, name: body.name, id: { not: id } },
        select: { id: true },
      });
      if (nameTaken) return reply.code(409).send({ error: 'A table with this name already exists' });
    }

    const row = await prisma.dataTable.update({
      where: { id },
      data: {
        name: body.name ?? undefined,
        description: body.description === undefined ? undefined : body.description,
      },
      include: { columns: true, _count: { select: { rows: true } } },
    });
    return { item: serializeTable(row) };
  });

  fastify.delete('/:id', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.dataTable.findFirst({ where: { id, workspaceId } });
    if (!existing) return reply.code(404).send({ error: 'Table not found' });
    await prisma.dataTable.delete({ where: { id } });
    return { ok: true };
  });

  // --- Columns ---

  fastify.post('/:id/columns', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = addColumnSchema.parse(request.body ?? {});

    const table = await prisma.dataTable.findFirst({
      where: { id, workspaceId },
      include: { columns: true },
    });
    if (!table) return reply.code(404).send({ error: 'Table not found' });

    const taken = new Set(table.columns.map((c) => c.key));
    const key = uniqueKey(body.label, taken);
    const maxOrder = table.columns.reduce((m, c) => Math.max(m, c.order), -1);

    const column = await prisma.dataTableColumn.create({
      data: {
        tableId: id,
        key,
        label: body.label,
        type: body.type,
        options: (body.type === 'select' ? body.options ?? [] : undefined) as unknown as
          | Prisma.InputJsonValue
          | undefined,
        order: maxOrder + 1,
      },
    });
    return reply.code(201).send({
      item: { id: column.id, key: column.key, label: column.label, type: column.type, options: body.options },
    });
  });

  fastify.put('/:id/columns/:columnId', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, columnId } = request.params as { id: string; columnId: string };
    const body = updateColumnSchema.parse(request.body ?? {});

    const column = await prisma.dataTableColumn.findFirst({
      where: { id: columnId, tableId: id, table: { workspaceId } },
    });
    if (!column) return reply.code(404).send({ error: 'Column not found' });

    const updated = await prisma.dataTableColumn.update({
      where: { id: columnId },
      data: {
        label: body.label ?? undefined,
        options:
          column.type === 'select' && body.options !== undefined
            ? (body.options as unknown as Prisma.InputJsonValue)
            : undefined,
      },
    });
    return {
      item: {
        id: updated.id,
        key: updated.key,
        label: updated.label,
        type: updated.type,
        options: updated.options ?? undefined,
      },
    };
  });

  fastify.delete('/:id/columns/:columnId', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, columnId } = request.params as { id: string; columnId: string };
    const column = await prisma.dataTableColumn.findFirst({
      where: { id: columnId, tableId: id, table: { workspaceId } },
    });
    if (!column) return reply.code(404).send({ error: 'Column not found' });
    await prisma.dataTableColumn.delete({ where: { id: columnId } });
    return { ok: true };
  });

  // --- Rows ---

  fastify.get('/:id/rows', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const query = z
      .object({ limit: z.coerce.number().min(1).max(500).optional(), cursor: z.string().optional() })
      .parse(request.query ?? {});

    const table = await prisma.dataTable.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!table) return reply.code(404).send({ error: 'Table not found' });

    const rows = await prisma.dataTableRow.findMany({
      where: { tableId: id },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 200,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    });
    return {
      items: rows.map(serializeRow),
      nextCursor: rows.length === (query.limit ?? 200) ? rows[rows.length - 1]?.id : null,
    };
  });

  fastify.post('/:id/rows', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = z.object({ data: rowDataSchema }).parse(request.body ?? {});

    const table = await prisma.dataTable.findFirst({
      where: { id, workspaceId },
      include: { columns: true },
    });
    if (!table) return reply.code(404).send({ error: 'Table not found' });

    const row = await prisma.dataTableRow.create({
      data: {
        tableId: id,
        data: sanitizeRowData(body.data, table.columns),
        source: 'manual',
      },
    });
    return reply.code(201).send({ item: serializeRow(row) });
  });

  fastify.put('/:id/rows/:rowId', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, rowId } = request.params as { id: string; rowId: string };
    const body = z.object({ data: rowDataSchema }).parse(request.body ?? {});

    const table = await prisma.dataTable.findFirst({
      where: { id, workspaceId },
      include: { columns: true },
    });
    if (!table) return reply.code(404).send({ error: 'Table not found' });

    const existing = await prisma.dataTableRow.findFirst({ where: { id: rowId, tableId: id } });
    if (!existing) return reply.code(404).send({ error: 'Row not found' });

    const merged = { ...(existing.data as Record<string, unknown>), ...body.data };
    const row = await prisma.dataTableRow.update({
      where: { id: rowId },
      data: { data: sanitizeRowData(merged, table.columns) },
    });
    return { item: serializeRow(row) };
  });

  fastify.delete('/:id/rows/:rowId', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, rowId } = request.params as { id: string; rowId: string };
    const existing = await prisma.dataTableRow.findFirst({ where: { id: rowId, tableId: id, table: { workspaceId } } });
    if (!existing) return reply.code(404).send({ error: 'Row not found' });
    await prisma.dataTableRow.delete({ where: { id: rowId } });
    return { ok: true };
  });

  // --- Flow connection (called from the WhatsApp Flow editor) ---

  fastify.put('/:id/connect-flow', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const body = z
      .object({
        flowId: z.string().min(1),
        fieldMap: z.record(z.string(), z.string()).default({}),
      })
      .parse(request.body ?? {});

    const table = await prisma.dataTable.findFirst({ where: { id, workspaceId } });
    if (!table) return reply.code(404).send({ error: 'Table not found' });

    const flow = await prisma.whatsAppFlow.findFirst({ where: { id: body.flowId, workspaceId } });
    if (!flow) return reply.code(404).send({ error: 'Flow not found' });

    await prisma.whatsAppFlow.update({
      where: { id: flow.id },
      data: {
        dataTableId: id,
        dataTableFieldMap: body.fieldMap as unknown as Prisma.InputJsonValue,
      },
    });
    return { ok: true };
  });

  fastify.delete('/:id/connect-flow/:flowId', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id, flowId } = request.params as { id: string; flowId: string };
    const flow = await prisma.whatsAppFlow.findFirst({
      where: { id: flowId, workspaceId, dataTableId: id },
    });
    if (!flow) return reply.code(404).send({ error: 'Connected flow not found' });
    await prisma.whatsAppFlow.update({
      where: { id: flowId },
      data: { dataTableId: null, dataTableFieldMap: Prisma.JsonNull },
    });
    return { ok: true };
  });

  // Flows connected to this table + candidates to connect, for the table's "Connect a Flow" panel.
  fastify.get('/:id/flows', companyAuth, async (request, reply) => {
    const { workspaceId } = getJwtUser(request);
    const { id } = request.params as { id: string };
    const table = await prisma.dataTable.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!table) return reply.code(404).send({ error: 'Table not found' });

    const allFlows = await prisma.whatsAppFlow.findMany({
      where: { workspaceId },
      select: { id: true, name: true, status: true, dataTableId: true, dataTableFieldMap: true },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      connected: allFlows
        .filter((f) => f.dataTableId === id)
        .map((f) => ({ id: f.id, name: f.name, fieldMap: f.dataTableFieldMap ?? {} })),
      available: allFlows
        .filter((f) => f.status === 'published' && f.dataTableId !== id)
        .map((f) => ({ id: f.id, name: f.name, connectedElsewhere: Boolean(f.dataTableId) })),
    };
  });
}
