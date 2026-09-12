import assert from 'node:assert/strict';
import {
  connectFlowSchema,
  createTableSchema,
  listRowsQuerySchema,
  rowBodySchema,
  updateTableSchema,
} from './dataTables.schemas.js';

assert.equal(
  createTableSchema.safeParse({
    name: 'Leads',
    columns: [{ label: 'Name', type: 'text' }],
  }).success,
  true
);
assert.equal(createTableSchema.safeParse({ name: 'Leads', columns: [] }).success, false);
assert.equal(updateTableSchema.safeParse({}).success, true);
assert.equal(rowBodySchema.safeParse({ data: { name: 'A' } }).success, true);
assert.equal(listRowsQuerySchema.safeParse({ limit: '10' }).success, true);
assert.equal(connectFlowSchema.safeParse({ flowId: 'f1' }).success, true);
assert.equal(connectFlowSchema.safeParse({}).success, false);

console.log('dataTables.schemas.check.ts: ok');
