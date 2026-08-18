import type { FastifyInstance } from 'fastify';
import { markContactUnsubscribed } from '../services/contactOptOut.service.js';
import { verifyUnsubscribeToken } from '../services/unsubscribeToken.service.js';

function unsubscribePage(opts: { title: string; message: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${opts.title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #0f172a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; max-width: 420px; text-align: center; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 14px; color: #64748b; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>${opts.title}</h1>
    <p>${opts.message}</p>
  </div>
</body>
</html>`;
}

/**
 * Public, unauthenticated — reached by an email recipient clicking the
 * unsubscribe link in an email, not a logged-in app user. A GET is used
 * (not a POST) because that's what a plain hyperlink click sends; this is
 * the standard, accepted exception to "GET must not mutate" for one-click
 * unsubscribe (RFC 8058).
 */
export default async function emailUnsubscribeRoutes(fastify: FastifyInstance) {
  fastify.get('/unsubscribe', async (request, reply) => {
    const { t } = request.query as { t?: string };
    if (!t) {
      return reply
        .code(400)
        .type('text/html')
        .send(unsubscribePage({ title: 'Invalid link', message: 'This unsubscribe link is missing its token.' }));
    }

    try {
      const claims = verifyUnsubscribeToken(t);
      await markContactUnsubscribed(claims.contactId, claims.workspaceId);
      return reply
        .type('text/html')
        .send(
          unsubscribePage({
            title: "You're unsubscribed",
            message: "You won't receive further campaign emails from this business.",
          })
        );
    } catch {
      return reply
        .code(400)
        .type('text/html')
        .send(
          unsubscribePage({
            title: 'Invalid or expired link',
            message: 'This unsubscribe link could not be verified.',
          })
        );
    }
  });
}
