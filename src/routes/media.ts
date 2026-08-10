import { FastifyInstance } from 'fastify';
import { readStagedMedia } from '../services/mediaStaging.js';
import { contentDisposition } from '../utils/contentDisposition.js';

export default async function mediaRoutes(fastify: FastifyInstance) {
  /** Public, signed URL for Meta to fetch outbound Instagram attachments. */
  fastify.get('/meta-fetch/:stagingId', async (request, reply) => {
    const { stagingId } = request.params as { stagingId: string };
    const query = request.query as { exp?: string; sig?: string };

    const expiresAt = Number(query.exp);
    const sig = query.sig || '';
    if (!stagingId || !query.exp || !sig) {
      return reply.code(400).send({ error: 'Invalid media link' });
    }

    try {
      const { buffer, mimeType, fileName } = await readStagedMedia(stagingId, expiresAt, sig);
      const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      return reply
        .header('Content-Type', mimeType)
        .header('Content-Disposition', contentDisposition('inline', fileName || `media-${stagingId}`))
        .header('Cache-Control', 'private, max-age=300')
        .send(body);
    } catch {
      return reply.code(404).send({ error: 'Media not found or expired' });
    }
  });
}
