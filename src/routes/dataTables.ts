import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { companyAuth } from '../middleware/workspaceScope.js';
import {
  addColumn,
  connectFlow,
  createRow,
  createTable,
  deleteColumn,
  deleteRow,
  deleteTable,
  disconnectFlow,
  getTable,
  listRows,
  listTableFlows,
  listTables,
  updateColumn,
  updateRow,
  updateTable,
} from '../modules/dataTables/dataTables.controller.js';
import {
  addColumnSchema,
  connectFlowSchema,
  createTableSchema,
  listRowsQuerySchema,
  rowBodySchema,
  updateColumnSchema,
  updateTableSchema,
} from './dataTables.schemas.js';

/**
 * User-designed "Data" tables: the user defines columns with types, then rows
 * come in either by manual entry (this API) or by connecting a WhatsAppFlow so
 * every submission of that flow appends a row (see conversation-inbound-router
 * / webhooks.ts flow-response handling).
 */
export default async function dataTableRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = companyAuth;

  fastify.get('/', auth, listTables);
  fastify.get('/:id', auth, getTable);
  app.post('/', { ...auth, schema: { body: createTableSchema } }, createTable);
  app.put('/:id', { ...auth, schema: { body: updateTableSchema } }, updateTable);
  fastify.delete('/:id', auth, deleteTable);

  app.post('/:id/columns', { ...auth, schema: { body: addColumnSchema } }, addColumn);
  app.put('/:id/columns/:columnId', { ...auth, schema: { body: updateColumnSchema } }, updateColumn);
  fastify.delete('/:id/columns/:columnId', auth, deleteColumn);

  app.get('/:id/rows', { ...auth, schema: { querystring: listRowsQuerySchema } }, listRows);
  app.post('/:id/rows', { ...auth, schema: { body: rowBodySchema } }, createRow);
  app.put('/:id/rows/:rowId', { ...auth, schema: { body: rowBodySchema } }, updateRow);
  fastify.delete('/:id/rows/:rowId', auth, deleteRow);

  app.put('/:id/connect-flow', { ...auth, schema: { body: connectFlowSchema } }, connectFlow);
  fastify.delete('/:id/connect-flow/:flowId', auth, disconnectFlow);
  fastify.get('/:id/flows', auth, listTableFlows);
}
