import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { config } from './src/config.js';
import { signSessionToken } from './src/services/userSecurity.js';

const fastify = Fastify();
await fastify.register(jwt, { secret: config.jwtSecret });

const token = await signSessionToken(fastify, {
  userId: 'cms4djype0007i6gscv6wdu0s',
  workspaceId: 'cmrxuhnwg0000p974mztbf08j',
  expiresIn: '1h',
});

console.log(token);
process.exit(0);
