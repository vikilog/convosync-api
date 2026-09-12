/**
 * Rewrite-plan [01] §2: tenant POST/PUT/PATCH registrations should declare `schema:`.
 *
 * ponytail: source-scan of `routes/*.ts`, not a runtime Fastify inventory.
 * Ceiling: misses `register()`, dynamic paths, hook-only `app.post(path, auth, h)`
 * action POSTs, and `platform/*`. Upgrade: walk the route table after listen.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['webhooks.ts', 'virtualNumber.ts', 'conversations.ts', 'calling.ts']);

/** Obvious write: options object that spreads hooks — must include `schema:`. */
const OBVIOUS =
  /\b(?:app|fastify)\.(?:post|put|patch)\s*\(\s*(?:'[^']+'|"[^"]+")\s*,\s*\{\s*\.\.\.\w+([^}]*)\}/g;

function missingObviousSchemas(src: string): string[] {
  return [...src.matchAll(OBVIOUS)].flatMap((m) => (/schema\s*:/.test(m[1] ?? '') ? [] : [m[0]]));
}

assert.ok(SKIP.has('webhooks.ts') && SKIP.has('conversations.ts') && SKIP.has('virtualNumber.ts'));
assert.equal(missingObviousSchemas("app.post('/x', { ...auth }, h)").length, 1);
assert.equal(missingObviousSchemas("app.post('/x', { ...auth, schema: { body: z } }, h)").length, 0);

const routesDir = join(dirname(fileURLToPath(import.meta.url)), '../routes');
const leads = readFileSync(join(routesDir, 'leads.ts'), 'utf8');
assert.match(leads, /withTypeProvider/);
assert.equal(missingObviousSchemas(leads).length, 0);
assert.match(leads, /\.post\([\s\S]{0,240}schema\s*:/);

const missing: string[] = [];
for (const name of readdirSync(routesDir)) {
  if (!name.endsWith('.ts') || name.includes('.check.') || name.includes('.schemas.')) continue;
  if (SKIP.has(name)) continue;
  const src = readFileSync(join(routesDir, name), 'utf8');
  if (!src.includes('withTypeProvider')) continue;
  for (const hit of missingObviousSchemas(src)) missing.push(`${name}: ${hit}`);
}

assert.equal(missing.join('\n'), '');

console.log('routeSchemaCheck.check.ts: ok');
