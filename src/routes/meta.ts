import { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { config } from '../config.js';
import { purgeMetaUserChannelData } from '../services/metaDeauth.service.js';
import { parseMetaSignedRequest } from '../utils/metaSignedRequest.js';
import { metaDataDeletionStatusQuerySchema } from './meta.schemas.js';

type MetaCallbackBody = {
  signed_request?: string;
};

export default async function metaRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /** Meta App Dashboard → Deauthorize callback URL */
  fastify.post('/deauthorize', async (request, reply) => {
    const body = (request.body || {}) as MetaCallbackBody;
    const signedRequest =
      body.signed_request ||
      (request.query as MetaCallbackBody).signed_request ||
      undefined;

    if (!signedRequest) {
      return reply.code(400).send({ error: 'Missing signed_request' });
    }

    const payload = parseMetaSignedRequest(signedRequest, config.meta.appSecret);
    if (!payload?.user_id) {
      request.log.warn('Meta deauthorize callback: invalid signed_request');
      return reply.code(400).send({ error: 'Invalid signed_request' });
    }

    const result = await purgeMetaUserChannelData(payload.user_id);
    request.log.info(
      {
        metaUserId: payload.user_id,
        instagramAccounts: result.instagramAccounts,
        messengerAccounts: result.messengerAccounts,
        whatsappAccounts: result.whatsappAccounts,
        cleanup: result.cleanup,
      },
      'Meta deauthorize cleanup completed'
    );

    return reply.send({ success: true });
  });

  /** Meta App Dashboard → Data deletion request URL */
  fastify.post('/data-deletion', async (request, reply) => {
    const body = (request.body || {}) as MetaCallbackBody;
    const signedRequest = body.signed_request;

    if (!signedRequest) {
      return reply.code(400).send({ error: 'Missing signed_request' });
    }

    const payload = parseMetaSignedRequest(signedRequest, config.meta.appSecret);
    if (!payload?.user_id) {
      return reply.code(400).send({ error: 'Invalid signed_request' });
    }

    const confirmationCode = `meta-${payload.user_id}-${Date.now()}`;
    await purgeMetaUserChannelData(payload.user_id);

    const statusUrl = `${config.frontendUrl}/meta/data-deletion?code=${encodeURIComponent(
      confirmationCode
    )}`;

    request.log.info(
      { metaUserId: payload.user_id, confirmationCode },
      'Meta data deletion request processed'
    );

    return reply.send({
      url: statusUrl,
      confirmation_code: confirmationCode,
    });
  });

  app.get(
    '/data-deletion/status',
    { schema: { querystring: metaDataDeletionStatusQuerySchema } },
    async (request) => {
    const code = request.query.code;
    return {
      status: 'completed',
      confirmation_code: code ?? null,
      message: 'Channel data linked to this Meta authorization has been removed from ConvoSync.',
    };
  });
}
