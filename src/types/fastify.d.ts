import 'fastify';
import type Razorpay from 'razorpay';
import { JwtUser } from '../middleware/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    razorpay: Razorpay | null;
  }
  interface FastifyRequest {
    user: JwtUser;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}
