import { z } from 'zod';

export const COLUMN_TYPES = ['text', 'number', 'date', 'boolean', 'select', 'phone', 'email'] as const;

export const columnInputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  type: z.enum(COLUMN_TYPES),
  options: z.array(z.string().trim().min(1)).max(50).optional(),
});

export const createTableSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  columns: z.array(columnInputSchema).min(1).max(50),
});

export const updateTableSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

export const addColumnSchema = columnInputSchema;

export const updateColumnSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  options: z.array(z.string().trim().min(1)).max(50).optional(),
});

export const rowDataSchema = z.record(z.string(), z.unknown());

export const rowBodySchema = z.object({ data: rowDataSchema });

export const listRowsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(500).optional(),
  cursor: z.string().optional(),
});

export const connectFlowSchema = z.object({
  flowId: z.string().min(1),
  fieldMap: z.record(z.string(), z.string()).default({}),
});

export type CreateTableBody = z.infer<typeof createTableSchema>;
export type UpdateTableBody = z.infer<typeof updateTableSchema>;
export type AddColumnBody = z.infer<typeof addColumnSchema>;
export type UpdateColumnBody = z.infer<typeof updateColumnSchema>;
export type RowBody = z.infer<typeof rowBodySchema>;
export type ListRowsQuery = z.infer<typeof listRowsQuerySchema>;
export type ConnectFlowBody = z.infer<typeof connectFlowSchema>;
