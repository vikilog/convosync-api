/**
 * Self-check: pgvector migration must fix bare `vector` before HNSW.
 * Run: npx tsx scripts/pgvector-migration.check.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sql = readFileSync(
  join(
    root,
    'src/prisma/migrations/20260724130000_pgvector_knowledge_chunks/migration.sql'
  ),
  'utf8'
);
const schema = readFileSync(join(root, 'src/prisma/schema.prisma'), 'utf8');

assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector/);
assert.match(sql, /vector\(1536\)/);
assert.match(sql, /atttypmod\s*<>\s*1536/);
assert.match(sql, /ALTER COLUMN "embedding" TYPE vector\(1536\)/);
assert.match(sql, /atttypmod\s*=\s*1536/);
assert.match(sql, /USING hnsw/);
assert.match(schema, /Unsupported\("vector\(1536\)"\)/);
console.log('pgvector-migration.check: ok');
