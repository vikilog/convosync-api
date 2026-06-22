import fp from 'fastify-plugin';
import Razorpay from 'razorpay';
import { config } from '../config.js';
import { logRazorpayPlanSync, syncRazorpayPlanIds } from '../services/razorpayPlanSync.js';

export type RazorpayClient = Razorpay | null;

async function razorpayPlugin(fastify: import('fastify').FastifyInstance) {
  let client: RazorpayClient = null;

  if (config.razorpay.enabled) {
    client = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
    fastify.log.info('Razorpay client initialized');

    fastify.addHook('onReady', async () => {
      try {
        const result = await syncRazorpayPlanIds(client);
        logRazorpayPlanSync(result, (msg) => fastify.log.info(msg));
      } catch (err) {
        fastify.log.warn({ err }, 'Razorpay plan sync failed on startup');
      }
    });
  } else {
    fastify.log.warn('Razorpay keys not configured — billing API will return errors on use');
  }

  fastify.decorate('razorpay', client);
}

export default fp(razorpayPlugin, { name: 'razorpay' });
