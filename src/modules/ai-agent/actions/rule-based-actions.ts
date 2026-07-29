import type { AgentAction } from './action-executor.js';

export function getRuleBasedActions(params: {
  intent: string;
  retrievalPath: string;
  message: string;
}): AgentAction[] {
  const actions: AgentAction[] = [];

  if (params.intent === 'human_request' || params.retrievalPath === 'escalate') {
    actions.push({ type: 'escalate_to_human' });
    return actions;
  }

  if (looksLikeClosingMessage(params.message)) {
    actions.push({ type: 'close_conversations' });
  }

  return actions;
}

function looksLikeClosingMessage(message: string): boolean {
  const closingPatterns = /^(thanks|thank you|ok(ay)?|bye|dhanyavaad|shukriya|theek hai)\.?!?$/i;
  return closingPatterns.test(message.trim());
}
