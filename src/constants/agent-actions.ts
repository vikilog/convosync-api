export const DEFAULT_AGENT_ACTIONS = [
  {
    type: 'close_conversations',
    enabled: true,
    instruction: `Close the conversation when:
- User says thank you and seems satisfied
- Issue has been resolved and confirmed by user
- User explicitly asks to end the chat
- No response after 2 follow-up messages`,
  },
  {
    type: 'escalate_to_human',
    enabled: true,
    instruction: `Escalate to a human agent when:
- User is frustrated or angry
- Technical issue cannot be resolved by AI
- User explicitly requests a human agent
- Billing or refund related queries
- Issue requires account-level access`,
  },
  {
    type: 'add_contact_tags',
    enabled: true,
    instruction: `Add contact tags when:
- User asks about pricing → tag: 'interested'
- User requests demo → tag: 'demo_requested'
- User reports bug → tag: 'bug_report'
- User wants to cancel → tag: 'churn_risk'
- Purchase completed → tag: 'customer'`,
  },
  {
    type: 'update_contact_attributes',
    enabled: true,
    instruction: `Update contact attributes when:
- User provides their name → update: contact.name
- User shares email → update: contact.email
- User mentions company → update: contact.company
- User confirms interest in plan → update: contact.plan_interest
- User sets language preference → update: contact.language`,
  },
] as const;
