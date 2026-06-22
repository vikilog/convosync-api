import type { FastifyReply, FastifyRequest } from 'fastify';
import { getJwtUser } from '../../../middleware/auth.js';
import type { AiChatContainer } from '../container.js';
import { aiChatMessageSchema } from '../dto/ai-chat.dto.js';
import { AiChatError } from '../services/ai-chat.service.js';

export class AiChatController {
  constructor(private readonly c: AiChatContainer) {}

  chat = async (request: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = getJwtUser(request);
    const body = aiChatMessageSchema.parse(request.body);

    try {
      const result = await this.c.aiChatService.chat(workspaceId, body);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof AiChatError) {
        return reply.code(err.statusCode).send({ error: err.message, code: err.code });
      }
      const message = err instanceof Error ? err.message : 'Chat failed';
      return reply.code(500).send({ error: message, code: 'CHAT_FAILED' });
    }
  };
}
