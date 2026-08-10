/**
 * Maps authenticated mutating API routes → activity feed rows.
 * Keys: `METHOD /api/.../:param` (Fastify-style patterns).
 * Value `null` = explicitly skip (noise, duplicate rich emit, or non-user).
 */
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TYPES,
  type NotificationCategory,
} from './types.js';

export type RouteActivitySpec = {
  type: string;
  category: NotificationCategory | string;
  title: string;
  message: string;
  entityType?: string;
  /** Param name from request.params for entityId (e.g. 'id'). */
  entityIdParam?: string;
  forBell?: boolean;
};

type RouteEntry = RouteActivitySpec | null;

const T = NOTIFICATION_TYPES;
const C = NOTIFICATION_CATEGORIES;

/** Full inventory of user-performed mutating actions → activity. */
export const ROUTE_ACTIVITY: Record<string, RouteEntry> = {
  // ── Inbox ──────────────────────────────────────────────
  'POST /api/conversations/open': {
    type: T.INBOX_CONVERSATION_UPDATED,
    category: C.INBOX,
    title: 'Conversation opened',
    message: 'Opened or created a conversation',
    entityType: 'conversation',
  },
  'POST /api/conversations/:id/takeover': {
    type: T.INBOX_TAKEOVER,
    category: C.INBOX,
    title: 'Conversation takeover',
    message: 'Took over a conversation from AI',
    entityType: 'conversation',
    entityIdParam: 'id',
  },
  'POST /api/conversations/:id/release-to-ai': {
    type: T.INBOX_RELEASE_AI,
    category: C.INBOX,
    title: 'Released to AI',
    message: 'Released a conversation to the AI agent',
    entityType: 'conversation',
    entityIdParam: 'id',
  },
  'POST /api/conversations/:id/messages': {
    type: T.INBOX_MESSAGE_SENT,
    category: C.INBOX,
    title: 'Message sent',
    message: 'Sent a message in inbox',
    entityType: 'conversation',
    entityIdParam: 'id',
  },
  'POST /api/conversations/:id/messages/template': {
    type: T.INBOX_MESSAGE_SENT,
    category: C.INBOX,
    title: 'Template message sent',
    message: 'Sent a template message in inbox',
    entityType: 'conversation',
    entityIdParam: 'id',
  },
  'POST /api/conversations/:id/messages/media': {
    type: T.INBOX_MESSAGE_SENT,
    category: C.INBOX,
    title: 'Media message sent',
    message: 'Sent a media message in inbox',
    entityType: 'conversation',
    entityIdParam: 'id',
  },
  'POST /api/conversations/messages/:messageId/resend': {
    type: T.INBOX_MESSAGE_SENT,
    category: C.INBOX,
    title: 'Message resent',
    message: 'Resent an inbox message',
    entityType: 'message',
    entityIdParam: 'messageId',
  },
  'PUT /api/conversations/:id': {
    type: T.INBOX_CONVERSATION_UPDATED,
    category: C.INBOX,
    title: 'Conversation updated',
    message: 'Updated conversation status or assignment',
    entityType: 'conversation',
    entityIdParam: 'id',
  },
  'DELETE /api/conversations/:id': {
    type: T.INBOX_CONVERSATION_UPDATED,
    category: C.INBOX,
    title: 'Conversation deleted',
    message: 'Deleted a conversation',
    entityType: 'conversation',
    entityIdParam: 'id',
  },
  'POST /api/canned-responses': {
    type: T.SETTINGS_UPDATED,
    category: C.INBOX,
    title: 'Canned response created',
    message: 'Created a canned response',
    entityType: 'canned_response',
  },
  'PUT /api/canned-responses/:id': {
    type: T.SETTINGS_UPDATED,
    category: C.INBOX,
    title: 'Canned response updated',
    message: 'Updated a canned response',
    entityType: 'canned_response',
    entityIdParam: 'id',
  },
  'DELETE /api/canned-responses/:id': {
    type: T.SETTINGS_UPDATED,
    category: C.INBOX,
    title: 'Canned response deleted',
    message: 'Deleted a canned response',
    entityType: 'canned_response',
    entityIdParam: 'id',
  },
  'PATCH /api/workspace/inbox-behavior': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Inbox behavior updated',
    message: 'Updated inbox behavior settings',
  },
  'POST /api/workspace/inbox-groups': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Inbox group created',
    message: 'Created an inbox group',
    entityType: 'inbox_group',
  },
  'PATCH /api/workspace/inbox-groups/:groupId': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Inbox group updated',
    message: 'Updated an inbox group',
    entityType: 'inbox_group',
    entityIdParam: 'groupId',
  },
  'DELETE /api/workspace/inbox-groups/:groupId': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Inbox group deleted',
    message: 'Deleted an inbox group',
    entityType: 'inbox_group',
    entityIdParam: 'groupId',
  },
  'POST /api/workspace/inbox-groups/:groupId/members': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Inbox group member added',
    message: 'Added a member to an inbox group',
    entityType: 'inbox_group',
    entityIdParam: 'groupId',
  },
  'DELETE /api/workspace/inbox-groups/:groupId/members/:membershipId': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Inbox group member removed',
    message: 'Removed a member from an inbox group',
    entityType: 'inbox_group',
    entityIdParam: 'groupId',
  },
  'POST /api/workspace/inbox-rules': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Inbox rule created',
    message: 'Created an inbox routing rule',
    entityType: 'inbox_rule',
  },
  'PATCH /api/workspace/inbox-rules/reorder': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Inbox rules reordered',
    message: 'Reordered inbox routing rules',
  },
  'PATCH /api/workspace/inbox-rules/:ruleId': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Inbox rule updated',
    message: 'Updated an inbox routing rule',
    entityType: 'inbox_rule',
    entityIdParam: 'ruleId',
  },
  'DELETE /api/workspace/inbox-rules/:ruleId': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Inbox rule deleted',
    message: 'Deleted an inbox routing rule',
    entityType: 'inbox_rule',
    entityIdParam: 'ruleId',
  },

  // ── Contacts ───────────────────────────────────────────
  'POST /api/contacts': {
    type: T.CONTACT_CREATED,
    category: C.CONTACTS,
    title: 'Contact created',
    message: 'Created a contact',
    entityType: 'contact',
  },
  // Rich emit CONTACT_IMPORT_FINISHED — skip duplicate from hook
  'POST /api/contacts/import': null,
  'PUT /api/contacts/:id': {
    type: T.CONTACT_UPDATED,
    category: C.CONTACTS,
    title: 'Contact updated',
    message: 'Updated a contact',
    entityType: 'contact',
    entityIdParam: 'id',
  },
  'DELETE /api/contacts/:id': {
    type: T.CONTACT_DELETED,
    category: C.CONTACTS,
    title: 'Contact deleted',
    message: 'Deleted a contact',
    entityType: 'contact',
    entityIdParam: 'id',
  },
  'DELETE /api/contacts/by-tag': {
    type: T.CONTACT_DELETED,
    category: C.CONTACTS,
    title: 'Contacts deleted by tag',
    message: 'Deleted contacts by tag',
  },
  'POST /api/contacts/:id/links': {
    type: T.CONTACT_UPDATED,
    category: C.CONTACTS,
    title: 'Contact linked',
    message: 'Linked contacts together',
    entityType: 'contact',
    entityIdParam: 'id',
  },
  'DELETE /api/contacts/:id/links/:otherContactId': {
    type: T.CONTACT_UPDATED,
    category: C.CONTACTS,
    title: 'Contact unlinked',
    message: 'Removed a contact link',
    entityType: 'contact',
    entityIdParam: 'id',
  },
  'POST /api/contacts/:id/insights/compute': {
    type: T.CONTACT_UPDATED,
    category: C.CONTACTS,
    title: 'Contact insight computed',
    message: 'Computed insights for a contact',
    entityType: 'contact',
    entityIdParam: 'id',
  },
  'POST /api/workspace/tags': {
    type: T.CONTACT_TAGGED,
    category: C.CONTACTS,
    title: 'Tag created',
    message: 'Created a workspace tag',
    entityType: 'tag',
  },
  'PATCH /api/workspace/tags/:tagId': {
    type: T.CONTACT_TAGGED,
    category: C.CONTACTS,
    title: 'Tag updated',
    message: 'Updated a workspace tag',
    entityType: 'tag',
    entityIdParam: 'tagId',
  },
  'DELETE /api/workspace/tags/:tagId': {
    type: T.CONTACT_TAGGED,
    category: C.CONTACTS,
    title: 'Tag deleted',
    message: 'Deleted a workspace tag',
    entityType: 'tag',
    entityIdParam: 'tagId',
  },

  // ── Team Chat ──────────────────────────────────────────
  'POST /api/team-chat/messages': {
    type: T.TEAM_CHAT_MESSAGE,
    category: C.TEAM_CHAT,
    title: 'Team chat message',
    message: 'Sent a team chat message',
    entityType: 'team_chat_message',
  },

  // ── Campaigns ──────────────────────────────────────────
  'POST /api/campaigns': {
    type: T.CAMPAIGN_CREATED,
    category: C.CAMPAIGNS,
    title: 'Campaign created',
    message: 'Created a campaign',
    entityType: 'campaign',
  },
  'PATCH /api/campaigns/:id': {
    type: T.CAMPAIGN_UPDATED,
    category: C.CAMPAIGNS,
    title: 'Campaign updated',
    message: 'Updated a campaign',
    entityType: 'campaign',
    entityIdParam: 'id',
  },
  'POST /api/campaigns/:id/send': {
    type: T.CAMPAIGN_SEND,
    category: C.CAMPAIGNS,
    title: 'Campaign send started',
    message: 'Started sending a campaign',
    entityType: 'campaign',
    entityIdParam: 'id',
  },
  'POST /api/campaigns/:id/resend-failed': {
    type: T.CAMPAIGN_RESEND,
    category: C.CAMPAIGNS,
    title: 'Campaign resend',
    message: 'Resent failed campaign recipients',
    entityType: 'campaign',
    entityIdParam: 'id',
  },
  'POST /api/campaigns/:id/recipients/:messageId/resend': {
    type: T.CAMPAIGN_RESEND,
    category: C.CAMPAIGNS,
    title: 'Campaign recipient resent',
    message: 'Resent a campaign message to one recipient',
    entityType: 'campaign',
    entityIdParam: 'id',
  },

  // ── Templates ──────────────────────────────────────────
  'POST /api/templates': {
    type: T.TEMPLATE_CREATED,
    category: C.TEMPLATES,
    title: 'Template created',
    message: 'Created a WhatsApp template',
    entityType: 'template',
  },
  'PUT /api/templates/:id': {
    type: T.TEMPLATE_UPDATED,
    category: C.TEMPLATES,
    title: 'Template updated',
    message: 'Updated a WhatsApp template',
    entityType: 'template',
    entityIdParam: 'id',
  },
  'DELETE /api/templates/:id': {
    type: T.TEMPLATE_DELETED,
    category: C.TEMPLATES,
    title: 'Template deleted',
    message: 'Deleted a WhatsApp template',
    entityType: 'template',
    entityIdParam: 'id',
  },
  'POST /api/templates/sync': {
    type: T.TEMPLATE_SYNCED,
    category: C.TEMPLATES,
    title: 'Templates synced',
    message: 'Synced templates from Meta',
  },
  'POST /api/templates/header-media': {
    type: T.TEMPLATE_UPDATED,
    category: C.TEMPLATES,
    title: 'Template media uploaded',
    message: 'Uploaded template header media',
  },
  'POST /api/templates/:id/refresh-status': {
    type: T.TEMPLATE_UPDATED,
    category: C.TEMPLATES,
    title: 'Template status refreshed',
    message: 'Refreshed template approval status',
    entityType: 'template',
    entityIdParam: 'id',
  },
  'POST /api/templates/:id/submit': {
    type: T.TEMPLATE_SUBMITTED,
    category: C.TEMPLATES,
    title: 'Template submitted',
    message: 'Submitted a template to Meta for approval',
    entityType: 'template',
    entityIdParam: 'id',
  },

  // ── Automations (WA + IG journeys) ─────────────────────
  'POST /api/journeys': {
    type: T.JOURNEY_CREATED,
    category: C.AUTOMATIONS,
    title: 'Automation created',
    message: 'Created a WhatsApp automation',
    entityType: 'journey',
  },
  'PUT /api/journeys/:id': {
    type: T.JOURNEY_UPDATED,
    category: C.AUTOMATIONS,
    title: 'Automation updated',
    message: 'Updated a WhatsApp automation',
    entityType: 'journey',
    entityIdParam: 'id',
  },
  'PUT /api/journeys/:id/graph': {
    type: T.JOURNEY_UPDATED,
    category: C.AUTOMATIONS,
    title: 'Automation flow saved',
    message: 'Saved an automation flow graph',
    entityType: 'journey',
    entityIdParam: 'id',
  },
  'POST /api/journeys/:id/publish': {
    type: T.JOURNEY_PUBLISHED,
    category: C.AUTOMATIONS,
    title: 'Automation published',
    message: 'Published a WhatsApp automation',
    entityType: 'journey',
    entityIdParam: 'id',
  },
  'DELETE /api/journeys/:id': {
    type: T.JOURNEY_DELETED,
    category: C.AUTOMATIONS,
    title: 'Automation deleted',
    message: 'Deleted a WhatsApp automation',
    entityType: 'journey',
    entityIdParam: 'id',
  },
  'POST /api/journeys/trigger': {
    type: T.JOURNEY_UPDATED,
    category: C.AUTOMATIONS,
    title: 'Automation triggered',
    message: 'Manually triggered an automation',
    entityType: 'journey',
  },
  'POST /api/journeys/executions/:id/resume': {
    type: T.JOURNEY_UPDATED,
    category: C.AUTOMATIONS,
    title: 'Automation resumed',
    message: 'Resumed an automation execution',
    entityType: 'journey_execution',
    entityIdParam: 'id',
  },
  'POST /api/instagram-journeys': {
    type: T.JOURNEY_CREATED,
    category: C.AUTOMATIONS,
    title: 'IG automation created',
    message: 'Created an Instagram automation',
    entityType: 'instagram_journey',
  },
  'PUT /api/instagram-journeys/:id': {
    type: T.JOURNEY_UPDATED,
    category: C.AUTOMATIONS,
    title: 'IG automation updated',
    message: 'Updated an Instagram automation',
    entityType: 'instagram_journey',
    entityIdParam: 'id',
  },
  'PUT /api/instagram-journeys/:id/graph': {
    type: T.JOURNEY_UPDATED,
    category: C.AUTOMATIONS,
    title: 'IG automation flow saved',
    message: 'Saved an Instagram automation flow',
    entityType: 'instagram_journey',
    entityIdParam: 'id',
  },
  'POST /api/instagram-journeys/:id/publish': {
    type: T.JOURNEY_PUBLISHED,
    category: C.AUTOMATIONS,
    title: 'IG automation published',
    message: 'Published an Instagram automation',
    entityType: 'instagram_journey',
    entityIdParam: 'id',
  },
  'DELETE /api/instagram-journeys/:id': {
    type: T.JOURNEY_DELETED,
    category: C.AUTOMATIONS,
    title: 'IG automation deleted',
    message: 'Deleted an Instagram automation',
    entityType: 'instagram_journey',
    entityIdParam: 'id',
  },
  'PATCH /api/workspace/automation': {
    type: T.SETTINGS_UPDATED,
    category: C.AUTOMATIONS,
    title: 'Automation settings updated',
    message: 'Updated workspace automation controls',
  },

  // ── AI Agent ───────────────────────────────────────────
  'POST /api/agents': {
    type: T.AGENT_CREATED,
    category: C.AI_AGENT,
    title: 'AI agent created',
    message: 'Created an AI agent',
    entityType: 'agent',
  },
  'PUT /api/agents/:id': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'AI agent updated',
    message: 'Updated an AI agent',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'POST /api/agents/:id/toggle': {
    type: T.AGENT_TOGGLED,
    category: C.AI_AGENT,
    title: 'AI agent toggled',
    message: 'Enabled or disabled an AI agent',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'POST /api/agents/:id/duplicate': {
    type: T.AGENT_CREATED,
    category: C.AI_AGENT,
    title: 'AI agent duplicated',
    message: 'Duplicated an AI agent',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'DELETE /api/agents/:id': {
    type: T.AGENT_DELETED,
    category: C.AI_AGENT,
    title: 'AI agent deleted',
    message: 'Deleted an AI agent',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  // High-frequency test/preview — skip
  'POST /api/agents/:id/chat': null,
  'POST /api/agents/:id/test': null,
  'POST /api/agents/:id/voice-preview/stt': null,
  'POST /api/agents/:id/voice-preview/tts': null,
  'POST /api/agents/:id/skills': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'Agent skill added',
    message: 'Added a skill to an AI agent',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'PUT /api/agents/:id/skills/:skillId': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'Agent skill updated',
    message: 'Updated an AI agent skill',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'PATCH /api/agents/:id/skills/:skillId/publish': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'Agent skill published',
    message: 'Published an AI agent skill',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'DELETE /api/agents/:id/skills/:skillId': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'Agent skill deleted',
    message: 'Deleted an AI agent skill',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'POST /api/agents/:id/knowledge': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'Agent knowledge added',
    message: 'Added knowledge to an AI agent',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'POST /api/agents/:id/knowledge/fetch-url': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'Agent knowledge URL fetched',
    message: 'Fetched a URL into agent knowledge',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'PUT /api/agents/:id/knowledge/:kId': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'Agent knowledge updated',
    message: 'Updated agent knowledge',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'DELETE /api/agents/:id/knowledge/:kId': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'Agent knowledge deleted',
    message: 'Deleted agent knowledge',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'POST /api/agents/:id/knowledge/reindex': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'Agent knowledge reindexed',
    message: 'Reindexed AI agent knowledge',
    entityType: 'agent',
    entityIdParam: 'id',
  },
  'PUT /api/workspace/ai-provider': {
    type: T.SETTINGS_UPDATED,
    category: C.AI_AGENT,
    title: 'AI provider updated',
    message: 'Updated workspace AI provider settings',
  },
  'POST /api/workspace/ai-provider/test': null,
  'PUT /api/ai-knowledge/config': {
    type: T.SETTINGS_UPDATED,
    category: C.AI_AGENT,
    title: 'AI knowledge config updated',
    message: 'Updated AI knowledge configuration',
  },
  'POST /api/ai-knowledge/collections': null, // list disguised as POST
  'POST /api/ai-knowledge/sync': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'AI knowledge synced',
    message: 'Synced AI knowledge collections',
  },
  'POST /api/ai-knowledge/sync/collection': {
    type: T.AGENT_UPDATED,
    category: C.AI_AGENT,
    title: 'AI knowledge collection synced',
    message: 'Synced one AI knowledge collection',
  },
  'POST /api/ai-knowledge/context': null, // query
  'POST /api/ai-chat/message': null, // high-frequency copilot

  // ── Social Listening ───────────────────────────────────
  'PATCH /api/social-listening/settings': {
    type: T.SOCIAL_LISTENING_ACTION,
    category: C.SOCIAL_LISTENING,
    title: 'Social listening settings',
    message: 'Updated social listening settings',
  },
  'PATCH /api/social-listening/posts/:postId/settings': {
    type: T.SOCIAL_LISTENING_ACTION,
    category: C.SOCIAL_LISTENING,
    title: 'Post listening settings',
    message: 'Updated per-post social listening settings',
    entityType: 'social_post',
    entityIdParam: 'postId',
  },
  'POST /api/social-listening/comments/:id/classify': {
    type: T.SOCIAL_LISTENING_ACTION,
    category: C.SOCIAL_LISTENING,
    title: 'Comment classified',
    message: 'Classified a social comment',
    entityType: 'social_comment',
    entityIdParam: 'id',
  },
  'POST /api/social-listening/comments/:id/action': {
    type: T.SOCIAL_LISTENING_ACTION,
    category: C.SOCIAL_LISTENING,
    title: 'Comment action',
    message: 'Took action on a social comment',
    entityType: 'social_comment',
    entityIdParam: 'id',
  },
  'POST /api/social-listening/comments/:id/retry-dm': {
    type: T.SOCIAL_LISTENING_ACTION,
    category: C.SOCIAL_LISTENING,
    title: 'Comment DM retried',
    message: 'Retried a social comment DM',
    entityType: 'social_comment',
    entityIdParam: 'id',
  },
  'POST /api/instagram/listening/comments/:commentId/reply': {
    type: T.SOCIAL_LISTENING_ACTION,
    category: C.SOCIAL_LISTENING,
    title: 'IG comment reply',
    message: 'Replied to an Instagram comment',
    entityType: 'instagram_comment',
    entityIdParam: 'commentId',
  },

  // ── Leads ──────────────────────────────────────────────
  'POST /api/leads': {
    type: T.LEAD_CREATED,
    category: C.LEADS,
    title: 'Lead created',
    message: 'Created a lead',
    entityType: 'lead',
  },
  'PATCH /api/leads/:id': {
    type: T.LEAD_UPDATED,
    category: C.LEADS,
    title: 'Lead updated',
    message: 'Updated a lead',
    entityType: 'lead',
    entityIdParam: 'id',
  },
  'POST /api/leads/:id/convert-to-contact': {
    type: T.LEAD_CONVERTED,
    category: C.LEADS,
    title: 'Lead converted',
    message: 'Converted a lead to a contact',
    entityType: 'lead',
    entityIdParam: 'id',
  },
  'POST /api/lead-funnels': {
    type: T.LEAD_UPDATED,
    category: C.LEADS,
    title: 'Lead funnel created',
    message: 'Created a lead funnel',
    entityType: 'lead_funnel',
  },
  'PATCH /api/lead-funnels/:id': {
    type: T.LEAD_UPDATED,
    category: C.LEADS,
    title: 'Lead funnel updated',
    message: 'Updated a lead funnel',
    entityType: 'lead_funnel',
    entityIdParam: 'id',
  },
  'DELETE /api/lead-funnels/:id': {
    type: T.LEAD_UPDATED,
    category: C.LEADS,
    title: 'Lead funnel deleted',
    message: 'Deleted a lead funnel',
    entityType: 'lead_funnel',
    entityIdParam: 'id',
  },
  'POST /api/lead-funnels/:id/stages': {
    type: T.LEAD_UPDATED,
    category: C.LEADS,
    title: 'Funnel stage created',
    message: 'Created a lead funnel stage',
    entityType: 'lead_funnel',
    entityIdParam: 'id',
  },
  'PATCH /api/lead-funnels/:id/stages/:stageId': {
    type: T.LEAD_UPDATED,
    category: C.LEADS,
    title: 'Funnel stage updated',
    message: 'Updated a lead funnel stage',
    entityType: 'lead_funnel',
    entityIdParam: 'id',
  },
  'DELETE /api/lead-funnels/:id/stages/:stageId': {
    type: T.LEAD_UPDATED,
    category: C.LEADS,
    title: 'Funnel stage deleted',
    message: 'Deleted a lead funnel stage',
    entityType: 'lead_funnel',
    entityIdParam: 'id',
  },

  // ── Media Gallery ──────────────────────────────────────
  'POST /api/media-gallery': {
    type: T.MEDIA_UPLOADED,
    category: C.MEDIA,
    title: 'Media uploaded',
    message: 'Uploaded media to the gallery',
    entityType: 'media',
  },
  'PATCH /api/media-gallery/:mediaId': {
    type: T.MEDIA_UPLOADED,
    category: C.MEDIA,
    title: 'Media updated',
    message: 'Updated a media gallery item',
    entityType: 'media',
    entityIdParam: 'mediaId',
  },
  'DELETE /api/media-gallery/:mediaId': {
    type: T.MEDIA_DELETED,
    category: C.MEDIA,
    title: 'Media deleted',
    message: 'Deleted media from the gallery',
    entityType: 'media',
    entityIdParam: 'mediaId',
  },

  // ── Integrations ───────────────────────────────────────
  'POST /api/whatsapp/connect': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'WhatsApp connected',
    message: 'Connected a WhatsApp account',
  },
  'POST /api/whatsapp/connect-oauth': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'WhatsApp OAuth connected',
    message: 'Connected WhatsApp via OAuth',
  },
  'POST /api/whatsapp/webhooks/subscribe': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'WhatsApp webhooks subscribed',
    message: 'Subscribed WhatsApp webhooks',
  },
  'POST /api/whatsapp/accounts/:phoneNumberId/business-profile': {
    type: T.SETTINGS_UPDATED,
    category: C.INTEGRATIONS,
    title: 'WhatsApp profile updated',
    message: 'Updated WhatsApp business profile',
    entityType: 'whatsapp_account',
    entityIdParam: 'phoneNumberId',
  },
  'POST /api/whatsapp/payment-mode': {
    type: T.SETTINGS_UPDATED,
    category: C.INTEGRATIONS,
    title: 'WhatsApp payment mode',
    message: 'Updated WhatsApp payment mode',
  },
  'POST /api/whatsapp/payment-mode/refresh': null,
  'POST /api/whatsapp/payment-mode/acknowledge': null,
  'DELETE /api/whatsapp/disconnect': {
    type: T.INTEGRATION_DISCONNECTED,
    category: C.INTEGRATIONS,
    title: 'WhatsApp disconnected',
    message: 'Disconnected WhatsApp',
  },
  'POST /api/instagram/connect/preview': null,
  'POST /api/instagram/connect': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Instagram connected',
    message: 'Connected an Instagram account',
  },
  'POST /api/instagram/sync': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Instagram synced',
    message: 'Synced Instagram data',
  },
  'DELETE /api/instagram/disconnect': {
    type: T.INTEGRATION_DISCONNECTED,
    category: C.INTEGRATIONS,
    title: 'Instagram disconnected',
    message: 'Disconnected Instagram',
  },
  'POST /api/messenger/connect': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Messenger connected',
    message: 'Connected Messenger',
  },
  'POST /api/messenger/sync': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Messenger synced',
    message: 'Synced Messenger data',
  },
  'DELETE /api/messenger/disconnect': {
    type: T.INTEGRATION_DISCONNECTED,
    category: C.INTEGRATIONS,
    title: 'Messenger disconnected',
    message: 'Disconnected Messenger',
  },
  'POST /api/facebook/connect': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Facebook connected',
    message: 'Connected a Facebook page',
  },
  'DELETE /api/facebook/disconnect': {
    type: T.INTEGRATION_DISCONNECTED,
    category: C.INTEGRATIONS,
    title: 'Facebook disconnected',
    message: 'Disconnected Facebook',
  },
  'POST /api/facebook/comments/:commentId/reply': {
    type: T.SOCIAL_LISTENING_ACTION,
    category: C.SOCIAL_LISTENING,
    title: 'Facebook comment reply',
    message: 'Replied to a Facebook comment',
    entityType: 'facebook_comment',
    entityIdParam: 'commentId',
  },
  'POST /api/facebook/comments/:commentId/hide': {
    type: T.SOCIAL_LISTENING_ACTION,
    category: C.SOCIAL_LISTENING,
    title: 'Facebook comment hidden',
    message: 'Hid a Facebook comment',
    entityType: 'facebook_comment',
    entityIdParam: 'commentId',
  },
  'DELETE /api/facebook/comments/:commentId': {
    type: T.SOCIAL_LISTENING_ACTION,
    category: C.SOCIAL_LISTENING,
    title: 'Facebook comment deleted',
    message: 'Deleted a Facebook comment',
    entityType: 'facebook_comment',
    entityIdParam: 'commentId',
  },
  'POST /api/facebook/posts': {
    type: T.SOCIAL_LISTENING_ACTION,
    category: C.SOCIAL_LISTENING,
    title: 'Facebook post created',
    message: 'Created a Facebook post',
  },
  'POST /api/meta-ads/connect': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Meta Ads connected',
    message: 'Connected Meta Ads',
  },
  'POST /api/meta-ads/account/select': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Meta Ads account selected',
    message: 'Selected a Meta Ads account',
  },
  'DELETE /api/meta-ads/disconnect': {
    type: T.INTEGRATION_DISCONNECTED,
    category: C.INTEGRATIONS,
    title: 'Meta Ads disconnected',
    message: 'Disconnected Meta Ads',
  },
  'POST /api/meta-ads/campaigns/:id/pause': {
    type: T.CAMPAIGN_UPDATED,
    category: C.CAMPAIGNS,
    title: 'Meta ad campaign paused',
    message: 'Paused a Meta Ads campaign',
    entityType: 'meta_campaign',
    entityIdParam: 'id',
  },
  'POST /api/meta-ads/campaigns/:id/resume': {
    type: T.CAMPAIGN_UPDATED,
    category: C.CAMPAIGNS,
    title: 'Meta ad campaign resumed',
    message: 'Resumed a Meta Ads campaign',
    entityType: 'meta_campaign',
    entityIdParam: 'id',
  },
  'DELETE /api/meta-ads/campaigns/:id': {
    type: T.CAMPAIGN_UPDATED,
    category: C.CAMPAIGNS,
    title: 'Meta ad campaign deleted',
    message: 'Deleted a Meta Ads campaign',
    entityType: 'meta_campaign',
    entityIdParam: 'id',
  },
  'POST /api/meta-ads/ctwa/create': {
    type: T.CAMPAIGN_CREATED,
    category: C.CAMPAIGNS,
    title: 'CTWA campaign created',
    message: 'Created a Click-to-WhatsApp ad campaign',
  },
  'POST /api/whatsapp-pay/requests': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Payment request created',
    message: 'Created a WhatsApp Pay request',
    entityType: 'whatsapp_pay_request',
  },
  'POST /api/whatsapp-pay/requests/:id/send': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Payment request sent',
    message: 'Sent a WhatsApp Pay request',
    entityType: 'whatsapp_pay_request',
    entityIdParam: 'id',
  },
  'POST /api/whatsapp-pay/requests/:id/cancel': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Payment request cancelled',
    message: 'Cancelled a WhatsApp Pay request',
    entityType: 'whatsapp_pay_request',
    entityIdParam: 'id',
  },
  'POST /api/whatsapp-pay/requests/:id/refresh': null,
  'POST /api/email/integration/enable': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Email integration enabled',
    message: 'Enabled email integration',
  },
  'DELETE /api/email/integration': {
    type: T.INTEGRATION_DISCONNECTED,
    category: C.INTEGRATIONS,
    title: 'Email integration disabled',
    message: 'Disabled email integration',
  },
  'POST /api/email/domains': {
    type: T.SETTINGS_UPDATED,
    category: C.INTEGRATIONS,
    title: 'Email domain added',
    message: 'Added an email sending domain',
  },
  'POST /api/email/domains/verify': {
    type: T.SETTINGS_UPDATED,
    category: C.INTEGRATIONS,
    title: 'Email domain verified',
    message: 'Verified an email domain',
  },
  'POST /api/email/domains/:id/refresh': null,
  'POST /api/email/senders': {
    type: T.SETTINGS_UPDATED,
    category: C.INTEGRATIONS,
    title: 'Email sender created',
    message: 'Created an email sender',
  },
  'POST /api/email/senders/default': {
    type: T.SETTINGS_UPDATED,
    category: C.INTEGRATIONS,
    title: 'Default email sender set',
    message: 'Set the default email sender',
  },
  'POST /api/email/send': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Email sent',
    message: 'Sent an email',
  },
  'POST /api/email/providers': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Email provider added',
    message: 'Added an email provider',
  },
  'PATCH /api/email/providers/:id': {
    type: T.SETTINGS_UPDATED,
    category: C.INTEGRATIONS,
    title: 'Email provider updated',
    message: 'Updated an email provider',
    entityType: 'email_provider',
    entityIdParam: 'id',
  },
  'DELETE /api/email/providers/:id': {
    type: T.INTEGRATION_DISCONNECTED,
    category: C.INTEGRATIONS,
    title: 'Email provider removed',
    message: 'Removed an email provider',
    entityType: 'email_provider',
    entityIdParam: 'id',
  },
  'POST /api/email/providers/ses/refresh-identities': null,
  'POST /api/email/providers/ses/test-send': null,
  'POST /api/email/providers/:id/default': {
    type: T.SETTINGS_UPDATED,
    category: C.INTEGRATIONS,
    title: 'Default email provider set',
    message: 'Set the default email provider',
    entityType: 'email_provider',
    entityIdParam: 'id',
  },
  'POST /api/email/providers/:id/test': null,
  'POST /api/email/providers/:id/refresh-identities': null,
  'POST /api/email/providers/:id/test-send': null,
  'POST /api/email/templates': {
    type: T.TEMPLATE_CREATED,
    category: C.TEMPLATES,
    title: 'Email template created',
    message: 'Created an email template',
    entityType: 'email_template',
  },
  'PATCH /api/email/templates/:id': {
    type: T.TEMPLATE_UPDATED,
    category: C.TEMPLATES,
    title: 'Email template updated',
    message: 'Updated an email template',
    entityType: 'email_template',
    entityIdParam: 'id',
  },
  'DELETE /api/email/templates/:id': {
    type: T.TEMPLATE_DELETED,
    category: C.TEMPLATES,
    title: 'Email template deleted',
    message: 'Deleted an email template',
    entityType: 'email_template',
    entityIdParam: 'id',
  },
  'POST /api/email/templates/ai-generate': {
    type: T.TEMPLATE_CREATED,
    category: C.TEMPLATES,
    title: 'Email template AI-generated',
    message: 'Generated an email template with AI',
  },
  'PUT /api/workspace/email-config': {
    type: T.SETTINGS_UPDATED,
    category: C.INTEGRATIONS,
    title: 'Workspace email config saved',
    message: 'Saved workspace email (SES) configuration',
  },
  'DELETE /api/workspace/email-config': {
    type: T.INTEGRATION_DISCONNECTED,
    category: C.INTEGRATIONS,
    title: 'Workspace email config disabled',
    message: 'Disabled workspace email configuration',
  },
  'POST /api/workspace/email-config/refresh-identities': null,
  'POST /api/workspace/email-config/test': null,
  'POST /api/google/connect': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Google connected',
    message: 'Connected a Google account',
  },
  'DELETE /api/google/connections/:id': {
    type: T.INTEGRATION_DISCONNECTED,
    category: C.INTEGRATIONS,
    title: 'Google disconnected',
    message: 'Disconnected a Google account',
    entityType: 'google_connection',
    entityIdParam: 'id',
  },
  'POST /api/google/connections/:id/refresh': null,
  'POST /api/google/products/:product/connect': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Google product connected',
    message: 'Connected a Google product',
  },
  'POST /api/google/products/:product/disconnect': {
    type: T.INTEGRATION_DISCONNECTED,
    category: C.INTEGRATIONS,
    title: 'Google product disconnected',
    message: 'Disconnected a Google product',
  },
  'POST /api/google/products/:product/sync': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Google product synced',
    message: 'Synced a Google product',
  },
  // Google tool POSTs that are really reads — skip
  'POST /api/google/calendar/events/list': null,
  'POST /api/google/calendar/calendars': null,
  'POST /api/google/calendar/availability': null,
  'POST /api/google/sheets/spreadsheets/list': null,
  'POST /api/google/sheets/spreadsheets/get': null,
  'POST /api/google/sheets/read': null,
  'POST /api/google/drive/browse': null,
  'POST /api/google/drive/files/get': null,
  'POST /api/google/drive/files/preview': null,
  'POST /api/google/gmail/messages': null,
  'POST /api/google/gmail/messages/get': null,
  'POST /api/google/meet/meetings/list': null,
  'POST /api/google/business-profile/locations': null,
  'POST /api/google/calendar/events': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Calendar event created',
    message: 'Created a Google Calendar event',
  },
  'PATCH /api/google/calendar/events': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Calendar event updated',
    message: 'Updated a Google Calendar event',
  },
  'DELETE /api/google/calendar/events': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Calendar event deleted',
    message: 'Deleted a Google Calendar event',
  },
  'POST /api/google/sheets/write': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Sheet written',
    message: 'Wrote data to Google Sheets',
  },
  'POST /api/google/sheets/append': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Sheet appended',
    message: 'Appended data to Google Sheets',
  },
  'POST /api/google/gmail/send': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Gmail sent',
    message: 'Sent an email via Gmail',
  },
  'POST /api/google/meet/create': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Meet created',
    message: 'Created a Google Meet',
  },
  'POST /api/google/meet/meetings/cancel': {
    type: T.USER_ACTION,
    category: C.INTEGRATIONS,
    title: 'Meet cancelled',
    message: 'Cancelled a Google Meet',
  },
  'POST /api/google/business-profile/sync': {
    type: T.INTEGRATION_CONNECTED,
    category: C.INTEGRATIONS,
    title: 'Business Profile synced',
    message: 'Synced Google Business Profile',
  },
  'PUT /api/developers/webhooks/incoming': {
    type: T.SETTINGS_UPDATED,
    category: C.DEVELOPERS,
    title: 'Incoming webhook updated',
    message: 'Updated developer incoming webhook',
  },
  'POST /api/developers/webhooks/outgoing': {
    type: T.SETTINGS_UPDATED,
    category: C.DEVELOPERS,
    title: 'Outgoing webhook created',
    message: 'Created a developer outgoing webhook',
  },
  'PUT /api/developers/webhooks/outgoing/:id': {
    type: T.SETTINGS_UPDATED,
    category: C.DEVELOPERS,
    title: 'Outgoing webhook updated',
    message: 'Updated a developer outgoing webhook',
    entityType: 'outgoing_webhook',
    entityIdParam: 'id',
  },
  'DELETE /api/developers/webhooks/outgoing/:id': {
    type: T.SETTINGS_UPDATED,
    category: C.DEVELOPERS,
    title: 'Outgoing webhook deleted',
    message: 'Deleted a developer outgoing webhook',
    entityType: 'outgoing_webhook',
    entityIdParam: 'id',
  },
  'PUT /api/developers/actions': {
    type: T.SETTINGS_UPDATED,
    category: C.DEVELOPERS,
    title: 'Developer action upserted',
    message: 'Updated a developer action',
  },
  'POST /api/developers/ai-sync/rebuild': {
    type: T.AGENT_UPDATED,
    category: C.DEVELOPERS,
    title: 'Developer AI sync rebuilt',
    message: 'Rebuilt developer AI knowledge sync',
  },
  // Inbound developer webhook from external systems — not a ConvoSync user
  'POST /api/developers/incoming/:slug': null,

  // ── Wallet / Billing ───────────────────────────────────
  'PATCH /api/billing/wallet': {
    type: T.SETTINGS_UPDATED,
    category: C.WALLET,
    title: 'Wallet settings updated',
    message: 'Updated wallet settings',
  },
  'POST /api/billing/order/create': {
    type: T.WALLET_TOPUP,
    category: C.WALLET,
    title: 'Wallet top-up started',
    message: 'Started a wallet top-up order',
  },
  'POST /api/billing/order/verify': {
    type: T.WALLET_TOPUP,
    category: C.WALLET,
    title: 'Wallet top-up verified',
    message: 'Verified a wallet top-up payment',
    forBell: true,
  },
  'POST /api/billing/subscription/create': {
    type: T.SETTINGS_UPDATED,
    category: C.WALLET,
    title: 'Subscription checkout started',
    message: 'Started a subscription checkout',
  },
  'POST /api/billing/subscription/verify': {
    type: T.SETTINGS_UPDATED,
    category: C.WALLET,
    title: 'Subscription verified',
    message: 'Verified a subscription payment',
    forBell: true,
  },
  'POST /api/billing/subscription/cancel': {
    type: T.SETTINGS_UPDATED,
    category: C.WALLET,
    title: 'Subscription cancelled',
    message: 'Cancelled the workspace subscription',
    forBell: true,
  },
  'POST /api/billing/subscription/pause': {
    type: T.SETTINGS_UPDATED,
    category: C.WALLET,
    title: 'Subscription paused',
    message: 'Paused the workspace subscription',
  },
  'POST /api/billing/subscription/resume': {
    type: T.SETTINGS_UPDATED,
    category: C.WALLET,
    title: 'Subscription resumed',
    message: 'Resumed the workspace subscription',
  },
  'POST /api/billing/coupon/validate': null,
  'POST /api/billing/refund': {
    type: T.SETTINGS_UPDATED,
    category: C.WALLET,
    title: 'Refund requested',
    message: 'Requested a billing refund',
    forBell: true,
  },
  'POST /api/workspace/subscription/quote': null,

  // ── Settings / Team / Auth profile ─────────────────────
  'PATCH /api/workspace/company': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Company info updated',
    message: 'Updated company information',
  },
  'POST /api/workspace/verification/send': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Verification code sent',
    message: 'Sent a workspace verification code',
  },
  'POST /api/workspace/verification/verify': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Workspace verified',
    message: 'Verified workspace contact details',
  },
  'PATCH /api/workspace/notifications': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Alert preferences updated',
    message: 'Updated notification alert preferences',
  },
  // Rich emit TEAM_MEMBER_ADDED
  'POST /api/workspace/members': null,
  'PATCH /api/workspace/members/:membershipId': {
    type: T.TEAM_MEMBER_UPDATED,
    category: C.SETTINGS,
    title: 'Team member updated',
    message: 'Updated a team member',
    entityType: 'workspace_membership',
    entityIdParam: 'membershipId',
  },
  'DELETE /api/workspace/members/:membershipId': {
    type: T.TEAM_MEMBER_REMOVED,
    category: C.SETTINGS,
    title: 'Team member removed',
    message: 'Removed a team member',
    entityType: 'workspace_membership',
    entityIdParam: 'membershipId',
    forBell: true,
  },
  'PATCH /api/auth/profile': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Profile updated',
    message: 'Updated user profile',
  },
  'PATCH /api/auth/avatar': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Avatar updated',
    message: 'Updated profile avatar',
  },
  'POST /api/auth/change-password': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Password changed',
    message: 'Changed account password',
  },
  'POST /api/auth/switch-workspace': null,
  'POST /api/auth/workspaces': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Workspace created',
    message: 'Created a new workspace',
  },
  'POST /api/auth/login': null,
  'POST /api/auth/register': null,
  'POST /api/auth/logout': null,
  'POST /api/auth/logout-all': null,
  'PATCH /api/onboarding/step': null,
  'POST /api/onboarding/complete': {
    type: T.SETTINGS_UPDATED,
    category: C.SETTINGS,
    title: 'Onboarding completed',
    message: 'Completed workspace onboarding',
  },

  // ── Calling (hidden nav, still user actions) ───────────
  'POST /api/calls': {
    type: T.CALL_ACTION,
    category: C.CALLING,
    title: 'Call started',
    message: 'Started a call',
    entityType: 'call',
  },
  'POST /api/calls/upload-recording': {
    type: T.CALL_ACTION,
    category: C.CALLING,
    title: 'Call recording uploaded',
    message: 'Uploaded a call recording',
  },
  'POST /api/calls/:callId/guest-link': {
    type: T.CALL_ACTION,
    category: C.CALLING,
    title: 'Call guest link created',
    message: 'Created a call guest link',
    entityType: 'call',
    entityIdParam: 'callId',
  },
  'POST /api/calls/:callId/accept': {
    type: T.CALL_ACTION,
    category: C.CALLING,
    title: 'Call accepted',
    message: 'Accepted a call',
    entityType: 'call',
    entityIdParam: 'callId',
  },
  'POST /api/calls/:callId/decline': {
    type: T.CALL_ACTION,
    category: C.CALLING,
    title: 'Call declined',
    message: 'Declined a call',
    entityType: 'call',
    entityIdParam: 'callId',
  },
  'POST /api/calls/:callId/end': {
    type: T.CALL_ACTION,
    category: C.CALLING,
    title: 'Call ended',
    message: 'Ended a call',
    entityType: 'call',
    entityIdParam: 'callId',
  },
  'POST /api/calls/:callId/connected': null,
  'POST /api/calls/:callId/token': null,
  'POST /api/calls/:callId/listen': {
    type: T.CALL_ACTION,
    category: C.CALLING,
    title: 'Call listen',
    message: 'Started listening to a call',
    entityType: 'call',
    entityIdParam: 'callId',
  },
  'POST /api/calls/:callId/take-over': {
    type: T.CALL_ACTION,
    category: C.CALLING,
    title: 'Call takeover',
    message: 'Took over a call',
    entityType: 'call',
    entityIdParam: 'callId',
  },
  'POST /api/calls/:callId/resend-link': {
    type: T.CALL_ACTION,
    category: C.CALLING,
    title: 'Call link resent',
    message: 'Resent a call guest link',
    entityType: 'call',
    entityIdParam: 'callId',
  },
  'POST /api/calls/:callId/analytics': null,
  'DELETE /api/calls/:callId/recording': {
    type: T.CALL_ACTION,
    category: C.CALLING,
    title: 'Call recording deleted',
    message: 'Deleted a call recording',
    entityType: 'call',
    entityIdParam: 'callId',
  },
  'POST /api/calls/:callId/transcribe': {
    type: T.CALL_ACTION,
    category: C.CALLING,
    title: 'Call transcribed',
    message: 'Requested call transcription',
    entityType: 'call',
    entityIdParam: 'callId',
  },
  'POST /api/calls/guest/token': null,
  'POST /api/calls/guest/connected': null,
  'POST /api/calls/guest/end': null,

  // ── Noise / non-tenant ─────────────────────────────────
  'POST /api/in-app-notifications/:id/read': null,
  'POST /api/in-app-notifications/read-all': null,
  'POST /api/demo-requests': null,
  'POST /api/support-requests': null,
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SKIP_PREFIXES = [
  '/api/platform',
  '/api/webhook',
  '/api/internal',
  '/api/public',
  '/api/webhooks',
];

function normalizePath(path: string): string {
  const bare = path.split('?')[0] || path;
  if (bare.length > 1 && bare.endsWith('/')) return bare.slice(0, -1);
  return bare || '/';
}

/** Convert `/api/campaigns/:id/send` → regex matching concrete URLs. */
export function patternToRegex(pattern: string): RegExp {
  const parts = normalizePath(pattern).split('/').map((seg) => {
    if (seg.startsWith(':')) return '[^/]+';
    if (seg === '*') return '.*';
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}$`);
}

export type ResolveActivityInput = {
  method: string;
  /** Concrete path, e.g. `/api/campaigns/abc/send` */
  urlPath: string;
  /** Fastify route pattern when available, e.g. `/:id/send` or `/api/campaigns/:id/send` */
  routePattern?: string;
  params?: Record<string, string | undefined>;
};

export type ResolvedActivity = RouteActivitySpec & {
  entityId?: string | null;
  routeKey: string;
};

/**
 * Resolve a successful mutating request to an activity spec, or null to skip.
 * Unmapped authenticated mutations fall back to a generic user_action (still logged).
 */
export function resolveRouteActivity(input: ResolveActivityInput): ResolvedActivity | null {
  const method = input.method.toUpperCase();
  if (!MUTATING.has(method)) return null;

  const urlPath = normalizePath(input.urlPath);
  if (urlPath === '/health') return null;
  for (const p of SKIP_PREFIXES) {
    if (urlPath === p || urlPath.startsWith(`${p}/`)) return null;
  }

  const matched = matchRouteEntry(method, urlPath, input.routePattern);
  if (matched === undefined) {
    // Unmapped mutating tenant route → still record (ponytail: catch-all; refine map later)
    return {
      type: T.USER_ACTION,
      category: C.SYSTEM,
      title: 'Action',
      message: `Performed ${method} ${urlPath}`,
      forBell: false,
      routeKey: `${method} ${urlPath}`,
      entityId: null,
    };
  }
  if (matched.entry === null) return null;

  const params = input.params ?? {};
  const entityId = matched.entry.entityIdParam
    ? (params[matched.entry.entityIdParam] ?? null)
    : null;

  return {
    ...matched.entry,
    forBell: matched.entry.forBell ?? false,
    entityId,
    routeKey: matched.key,
  };
}

function matchRouteEntry(
  method: string,
  urlPath: string,
  routePattern?: string
): { key: string; entry: RouteEntry } | undefined {
  // 1) Exact key if Fastify gave a full /api/... pattern
  if (routePattern) {
    const rp = normalizePath(routePattern);
    const fullKey = `${method} ${rp}`;
    if (fullKey in ROUTE_ACTIVITY) {
      return { key: fullKey, entry: ROUTE_ACTIVITY[fullKey]! };
    }
    // Relative pattern: find unique key ending with it
    const suffix = rp.startsWith('/') ? rp : `/${rp}`;
    const suffixHits = Object.keys(ROUTE_ACTIVITY).filter(
      (k) => k.startsWith(`${method} `) && (k.endsWith(` ${suffix}`) || k.endsWith(suffix))
    );
    if (suffixHits.length === 1) {
      const key = suffixHits[0]!;
      return { key, entry: ROUTE_ACTIVITY[key]! };
    }
  }

  // 2) Pattern-match concrete URL against map keys
  let best: { key: string; entry: RouteEntry; len: number } | undefined;
  for (const [key, entry] of Object.entries(ROUTE_ACTIVITY)) {
    const sp = key.indexOf(' ');
    if (sp < 0) continue;
    const m = key.slice(0, sp);
    const pattern = key.slice(sp + 1);
    if (m !== method) continue;
    if (!patternToRegex(pattern).test(urlPath)) continue;
    if (!best || pattern.length > best.len) {
      best = { key, entry, len: pattern.length };
    }
  }
  return best ? { key: best.key, entry: best.entry } : undefined;
}

/** Export mapped route keys for self-check / inventory. */
export function listMappedRouteKeys(): string[] {
  return Object.keys(ROUTE_ACTIVITY).sort();
}
