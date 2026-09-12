import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const PGVECTOR_IMAGE = 'pgvector/pgvector:pg16';
const APP_DB_PORT = 5433;

let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;

async function dockerSkipReason(): Promise<string | null> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 8000 });
    return null;
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr).trim().split('\n').at(-1)
        : undefined;
    const fallback = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return `Docker is not available; skipping Postgres+pgvector Testcontainers test (${stderr || fallback})`;
  }
}

describe('postgres + pgvector (testcontainers)', () => {
  afterAll(async () => {
    if (container) await container.stop();
  });

  it(
    'starts pgvector and cosine-ranks a neighbor',
    async ({ skip }) => {
      const reason = await dockerSkipReason();
      if (reason) {
        skip(true, reason);
        return;
      }

      container = await new PostgreSqlContainer(PGVECTOR_IMAGE)
        .withDatabase('convosync_test')
        .withUsername('convosync')
        .withPassword('convosync_test')
        .start();

      expect(container.getMappedPort(5432)).not.toBe(APP_DB_PORT);

      const result = await container.exec([
        'psql',
        '-U',
        'convosync',
        '-d',
        'convosync_test',
        '-v',
        'ON_ERROR_STOP=1',
        '-t',
        '-A',
        '-c',
        `CREATE EXTENSION IF NOT EXISTS vector;
         CREATE TABLE kb_smoke (id int, embedding vector(3));
         INSERT INTO kb_smoke VALUES (1, '[1,0,0]'), (2, '[0,1,0]');
         SELECT id FROM kb_smoke ORDER BY embedding <=> '[0.9,0.1,0]'::vector LIMIT 1;`,
      ]);

      expect(result.exitCode, result.output).toBe(0);
      expect(result.output.trim()).toBe('1');
    },
    120_000,
  );
});
