import type { AiAgent, AgentFlowSession, Contact, Conversation } from '@prisma/client';
import { prisma } from '../index.js';
import { getIo } from '../socket.js';
import { sendWhatsAppMessage, formatMetaSendError } from './whatsapp.js';
import { getWorkspaceWhatsAppCredentials } from './whatsappCredentials.js';

export type AgentFlowNodeType =
  | 'ask_question'
  | 'send_messages'
  | 'call_api'
  | 'agent_takeover'
  | 'unsubscribe'
  | 'add_tags'
  | 'send_shop_product'
  | 'branch';

export type KeywordMatchRule = 'containing' | 'exact_match';
export type FlowTriggerType = 'keyword' | 'click_button';

export interface AgentFlowNode {
  id: string;
  type: AgentFlowNodeType;
  title: string;
  x: number;
  y: number;
  config?: {
    messageText?: string;
    questionText?: string;
    tags?: string[];
  };
}

export interface AgentFlowDefinition {
  name: string;
  status: 'active' | 'inactive';
  triggerType: FlowTriggerType | null;
  keywordMatchRule?: KeywordMatchRule;
  keywordList?: string[];
  nodes: AgentFlowNode[];
}

export type InboundWhatsAppContext = {
  workspaceId: string;
  conversationId: string;
  contactId: string;
  contactPhone: string;
  text: string;
  buttonPayload?: string;
  phoneNumberId?: string;
  /** When set, run this rule-based agent (inbox assignment) without keyword matching. */
  forcedAgentId?: string;
};

function logFlow(label: string, payload?: unknown) {
  const prefix = '[RuleBasedFlow]';
  if (payload === undefined) {
    console.log(`${prefix} ${label}`);
    return;
  }
  console.log(`${prefix} ${label}`, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function parseFlowDefinition(raw: unknown): AgentFlowDefinition | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const nodesRaw = Array.isArray(obj.nodes) ? obj.nodes : [];
  const nodes: AgentFlowNode[] = nodesRaw
    .filter((n) => n && typeof n === 'object')
    .map((n) => {
      const node = n as Record<string, unknown>;
      const configRaw = node.config;
      let config: AgentFlowNode['config'];
      if (configRaw && typeof configRaw === 'object') {
        const c = configRaw as Record<string, unknown>;
        config = {
          messageText: typeof c.messageText === 'string' ? c.messageText : undefined,
          questionText: typeof c.questionText === 'string' ? c.questionText : undefined,
          tags: Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === 'string') : undefined,
        };
      }
      return {
        id: String(node.id ?? ''),
        type: String(node.type ?? 'send_messages') as AgentFlowNodeType,
        title: String(node.title ?? ''),
        x: Number(node.x ?? 0),
        y: Number(node.y ?? 0),
        config,
      };
    })
    .filter((n) => n.id);

  const status = obj.status === 'active' ? 'active' : 'inactive';
  const triggerType =
    obj.triggerType === 'keyword' || obj.triggerType === 'click_button'
      ? obj.triggerType
      : null;

  return {
    name: String(obj.name ?? 'FLOW'),
    status,
    triggerType,
    keywordMatchRule: obj.keywordMatchRule === 'exact_match' ? 'exact_match' : 'containing',
    keywordList: Array.isArray(obj.keywordList)
      ? obj.keywordList.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      : [],
    nodes,
  };
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

export function matchesKeywordTrigger(
  inboundText: string,
  keywords: string[],
  rule: KeywordMatchRule
): boolean {
  if (!keywords.length) return false;
  const text = inboundText.trim();
  if (!text || text === '[media]') return false;

  if (rule === 'exact_match') {
    const normalized = normalizeText(text);
    return keywords.some((kw) => normalizeText(kw) === normalized);
  }

  const haystack = normalizeText(text);
  return keywords.some((kw) => {
    const needle = normalizeText(kw);
    return needle.length > 0 && haystack.includes(needle);
  });
}

function matchesClickButtonTrigger(buttonPayload: string | undefined, keywords: string[]): boolean {
  if (!buttonPayload?.trim()) return false;
  const payload = normalizeText(buttonPayload);
  return keywords.some((kw) => {
    const needle = normalizeText(kw);
    return payload === needle || payload.includes(needle);
  });
}

function getNodeOutboundText(
  node: AgentFlowNode,
  agent: AiAgent,
  isFirstSendMessage: boolean
): string | null {
  if (node.type === 'send_messages') {
    if (node.config?.messageText?.trim()) return node.config.messageText.trim();
    if (isFirstSendMessage && agent.welcomeMessageEnabled && agent.welcomeMessageText?.trim()) {
      return agent.welcomeMessageText.trim();
    }
    return 'Thanks for reaching out! How can we help you today?';
  }

  if (node.type === 'ask_question') {
    if (node.config?.questionText?.trim()) return node.config.questionText.trim();
    return 'What product or service are you interested in? Please reply with your answer.';
  }

  if (node.type === 'send_shop_product') {
    return 'Browse our catalog here — reply with the product name for details.';
  }

  return null;
}

function slugifyTag(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

async function persistOutboundMessage(
  workspaceId: string,
  conversationId: string,
  agentName: string,
  content: string,
  waMessageId?: string
) {
  const message = await prisma.message.create({
    data: {
      conversationId,
      waMessageId,
      sender: 'agent',
      senderName: agentName,
      content,
      status: 'sent',
      metadata: { source: 'rule_based_flow' },
    },
  });

  await prisma.conversation.updateMany({
    where: { id: conversationId, workspaceId },
    data: { lastMessage: content, lastMessageAt: new Date() },
  });

  getIo().to(workspaceId).emit('new_message', { conversationId, message });
  getIo().to(workspaceId).emit('conversation_updated', { conversationId });

  return message;
}

async function sendFlowText(
  workspaceId: string,
  conversationId: string,
  contactPhone: string,
  agentName: string,
  text: string,
  phoneNumberId?: string
): Promise<boolean> {
  try {
    const credentials = await getWorkspaceWhatsAppCredentials(workspaceId);
    const resolvedPhoneNumberId = phoneNumberId || credentials.phoneNumberId;
    if (!resolvedPhoneNumberId) {
      logFlow('send skipped — no phoneNumberId', { workspaceId });
      return false;
    }

    const sent = await sendWhatsAppMessage(
      credentials.accessToken,
      resolvedPhoneNumberId,
      contactPhone,
      text
    );

    await persistOutboundMessage(
      workspaceId,
      conversationId,
      agentName,
      text,
      sent.waMessageId
    );
    return true;
  } catch (err) {
    logFlow('send failed', formatMetaSendError(err));
    return false;
  }
}

function getLastAnswerFromSession(session: AgentFlowSession): string | undefined {
  const ctx = session.context;
  if (!ctx || typeof ctx !== 'object') return undefined;
  const answer = (ctx as Record<string, unknown>).lastAnswer;
  return typeof answer === 'string' && answer.trim() ? answer.trim() : undefined;
}

async function applyAddTags(
  workspaceId: string,
  contact: Contact,
  node: AgentFlowNode,
  agent: AiAgent,
  lastAnswer?: string
): Promise<string[]> {
  const fromConfig = node.config?.tags?.filter((t) => t.trim()) ?? [];
  const tagsToAdd =
    fromConfig.length > 0
      ? fromConfig
      : lastAnswer
        ? [slugifyTag(lastAnswer)]
        : [slugifyTag(node.title) || `flow-${slugifyTag(agent.name) || 'agent'}`];

  const merged = Array.from(new Set([...contact.tags, ...tagsToAdd]));
  const updated = await prisma.contact.update({
    where: { id: contact.id },
    data: { tags: merged },
  });

  getIo().to(workspaceId).emit('contact_updated', {
    contactId: contact.id,
    tags: updated.tags,
  });

  logFlow('tags applied', { contactId: contact.id, tags: tagsToAdd });
  return tagsToAdd;
}

type FlowRunResult = {
  session: AgentFlowSession;
  completed: boolean;
  handedOff: boolean;
};

async function runFlowFromIndex(
  session: AgentFlowSession,
  agent: AiAgent,
  flow: AgentFlowDefinition,
  contact: Contact,
  conversation: Conversation,
  phoneNumberId?: string
): Promise<FlowRunResult> {
  let nodeIndex = session.currentNodeIndex;
  let waitingForReply = false;
  let status = session.status;
  let sendMessageCount = 0;
  const lastAnswer = getLastAnswerFromSession(session);

  while (nodeIndex < flow.nodes.length && status === 'active') {
    const node = flow.nodes[nodeIndex];
    logFlow('execute node', { nodeId: node.id, type: node.type, index: nodeIndex });

    if (node.type === 'send_messages' || node.type === 'send_shop_product') {
      const isFirstSend = sendMessageCount === 0;
      const text = getNodeOutboundText(node, agent, isFirstSend);
      if (text) {
        await sendFlowText(
          session.workspaceId,
          session.conversationId,
          contact.phone,
          agent.name,
          text,
          phoneNumberId
        );
        sendMessageCount += 1;
      }
      nodeIndex += 1;
      continue;
    }

    if (node.type === 'ask_question') {
      const text = getNodeOutboundText(node, agent, false);
      if (text) {
        await sendFlowText(
          session.workspaceId,
          session.conversationId,
          contact.phone,
          agent.name,
          text,
          phoneNumberId
        );
      }
      waitingForReply = true;
      nodeIndex += 1;
      break;
    }

    if (node.type === 'add_tags') {
      const tagsAdded = await applyAddTags(
        session.workspaceId,
        contact,
        node,
        agent,
        lastAnswer
      );
      const refreshed = await prisma.contact.findUnique({ where: { id: contact.id } });
      if (refreshed) contact = refreshed;

      const thankYou = lastAnswer
        ? `Thanks! We've noted your interest in "${lastAnswer}". Our team will follow up with you shortly.`
        : `Thanks! Your request has been tagged (${tagsAdded.join(', ')}). Our team will follow up shortly.`;
      await sendFlowText(
        session.workspaceId,
        session.conversationId,
        contact.phone,
        agent.name,
        thankYou,
        phoneNumberId
      );

      nodeIndex += 1;
      continue;
    }

    if (node.type === 'agent_takeover') {
      status = 'handed_off';
      await prisma.conversation.updateMany({
        where: { id: conversation.id, workspaceId: session.workspaceId },
        data: {
          labels: Array.from(new Set([...conversation.labels, 'agent-takeover'])),
        },
      });
      await sendFlowText(
        session.workspaceId,
        session.conversationId,
        contact.phone,
        agent.name,
        'Connecting you with a team member. Please hold on.',
        phoneNumberId
      );
      nodeIndex += 1;
      break;
    }

    if (node.type === 'branch') {
      nodeIndex += 1;
      continue;
    }

    // call_api, unsubscribe — no-op for MVP
    nodeIndex += 1;
  }

  const completed = status === 'active' && nodeIndex >= flow.nodes.length && !waitingForReply;
  if (completed) status = 'completed';

  const updated = await prisma.agentFlowSession.update({
    where: { id: session.id },
    data: {
      currentNodeIndex: nodeIndex,
      waitingForReply,
      status,
      context: {
        lastRunAt: new Date().toISOString(),
        completed,
      },
    },
  });

  return { session: updated, completed, handedOff: status === 'handed_off' };
}

async function findMatchingAgent(
  workspaceId: string,
  text: string,
  buttonPayload?: string
): Promise<{ agent: AiAgent; flow: AgentFlowDefinition } | null> {
  const agents = await prisma.aiAgent.findMany({
    where: { workspaceId, category: 'rule_based', isEnabled: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const agent of agents) {
    const flow = parseFlowDefinition(agent.flowDefinition);
    if (!flow || flow.status !== 'active' || !flow.triggerType) continue;

    const keywords = flow.keywordList ?? [];
    if (flow.triggerType === 'keyword') {
      if (matchesKeywordTrigger(text, keywords, flow.keywordMatchRule ?? 'containing')) {
        return { agent, flow };
      }
    } else if (flow.triggerType === 'click_button') {
      if (matchesClickButtonTrigger(buttonPayload, keywords)) {
        return { agent, flow };
      }
    }
  }

  return null;
}

async function loadForcedAgent(
  workspaceId: string,
  forcedAgentId: string
): Promise<{ agent: AiAgent; flow: AgentFlowDefinition } | null> {
  const agent = await prisma.aiAgent.findFirst({
    where: { id: forcedAgentId, workspaceId, category: 'rule_based', isEnabled: true },
  });
  if (!agent) return null;
  const flow = parseFlowDefinition(agent.flowDefinition);
  if (!flow || flow.status !== 'active') return null;
  return { agent, flow };
}

export async function processRuleBasedFlowInbound(ctx: InboundWhatsAppContext): Promise<void> {
  const {
    workspaceId,
    conversationId,
    contactId,
    contactPhone,
    text,
    buttonPayload,
    phoneNumberId,
    forcedAgentId,
  } = ctx;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: { contact: true },
  });
  if (!conversation?.contact) return;

  let contact = conversation.contact;

  const existingSession = await prisma.agentFlowSession.findUnique({
    where: { conversationId },
    include: { agent: true },
  });

  if (existingSession) {
    if (existingSession.status === 'handed_off') {
      logFlow('skip — human handoff active', { sessionId: existingSession.id });
      return;
    }

    if (existingSession.status === 'completed') {
      const restartMatch = forcedAgentId
        ? await loadForcedAgent(workspaceId, forcedAgentId)
        : await findMatchingAgent(workspaceId, text, buttonPayload);
      if (!restartMatch) {
        logFlow('flow idle (completed) — no keyword match', { text, buttonPayload });
        return;
      }

      const { agent: restartAgent, flow: restartFlow } = restartMatch;
      logFlow('flow restarted after completion', {
        sessionId: existingSession.id,
        agentId: restartAgent.id,
        text,
      });

      const restartedSession = await prisma.agentFlowSession.update({
        where: { id: existingSession.id },
        data: {
          agentId: restartAgent.id,
          currentNodeIndex: 0,
          waitingForReply: false,
          status: 'active',
          context: { restartedAt: new Date().toISOString() },
        },
      });

      await runFlowFromIndex(
        restartedSession,
        restartAgent,
        restartFlow,
        contact,
        conversation,
        phoneNumberId
      );
      return;
    }

    const flow = parseFlowDefinition(existingSession.agent.flowDefinition);
    if (!flow) {
      logFlow('skip — invalid flow on session', { sessionId: existingSession.id });
      return;
    }

    if (existingSession.waitingForReply) {
      logFlow('advance after reply', { sessionId: existingSession.id, text });
      const advanced = await prisma.agentFlowSession.update({
        where: { id: existingSession.id },
        data: {
          waitingForReply: false,
          context: {
            ...(typeof existingSession.context === 'object' && existingSession.context
              ? (existingSession.context as object)
              : {}),
            lastAnswer: text,
          },
        },
      });
      await runFlowFromIndex(advanced, existingSession.agent, flow, contact, conversation, phoneNumberId);
      return;
    }

    logFlow('skip — active session not waiting', { sessionId: existingSession.id });
    return;
  }

  const match = forcedAgentId
    ? await loadForcedAgent(workspaceId, forcedAgentId)
    : await findMatchingAgent(workspaceId, text, buttonPayload);
  if (!match) {
    logFlow('no trigger match', { text, buttonPayload, forcedAgentId });
    return;
  }

  const { agent, flow } = match;
  logFlow('trigger matched', { agentId: agent.id, flowName: flow.name, text });

  const session = await prisma.agentFlowSession.create({
    data: {
      agentId: agent.id,
      conversationId,
      contactId,
      workspaceId,
      currentNodeIndex: 0,
      waitingForReply: false,
      status: 'active',
    },
  });

  await prisma.aiAgent.updateMany({
    where: { id: agent.id, workspaceId },
    data: { conversationsCount: { increment: 1 } },
  });

  await runFlowFromIndex(session, agent, flow, contact, conversation, phoneNumberId);
}
