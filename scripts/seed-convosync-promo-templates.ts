/**
 * Seed ConvoSync promotional WhatsApp templates as local drafts (no Meta submit).
 *
 * Usage:
 *   cd backend && npx tsx scripts/seed-convosync-promo-templates.ts
 *   WORKSPACE_ID=xxx npx tsx scripts/seed-convosync-promo-templates.ts
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';

type SeedTemplate = {
  name: string;
  category: 'Marketing' | 'Utility' | 'Authentication';
  language: string;
  header?: string;
  bodyPattern: string;
  footer?: string;
  buttonType?: 'URL' | 'QUICK_REPLY' | 'PHONE_NUMBER';
  buttonText?: string;
  buttonUrl?: string;
  variableSamples: string[];
};

const TEMPLATES: SeedTemplate[] = [
  {
    name: 'cs_intro_whatsapp_business',
    category: 'Marketing',
    language: 'en_US',
    header: 'Grow on WhatsApp',
    bodyPattern: `Hi {{1}},

Running customer chats on personal WhatsApp?

ConvoSync gives your team a shared WhatsApp Business inbox — campaigns, templates, and AI replies in one place.

Want a 10-minute walkthrough?`,
    footer: 'ConvoSync · Business messaging',
    buttonType: 'URL',
    buttonText: 'Book a demo',
    buttonUrl: 'https://convosync.in/demo',
    variableSamples: ['Rahul'],
  },
  {
    name: 'cs_demo_invite',
    category: 'Marketing',
    language: 'en_US',
    header: 'Demo invite',
    bodyPattern: `Hi {{1}},

You're invited to a live ConvoSync demo.

We'll show inbox, campaigns, and WhatsApp templates for {{2}}.

When works for you — {{3}} or reply with a slot?`,
    buttonType: 'URL',
    buttonText: 'Pick a time',
    buttonUrl: 'https://convosync.in/demo',
    variableSamples: ['Priya', 'your store', 'Thu 4 PM'],
  },
  {
    name: 'cs_trial_started',
    category: 'Utility',
    language: 'en_US',
    header: 'Your trial is live',
    bodyPattern: `Hi {{1}},

Your ConvoSync workspace is ready.

Next steps:
1. Connect WhatsApp
2. Invite your team
3. Send your first template

Need help? Reply here — we'll set it up with you.`,
    footer: 'ConvoSync onboarding',
    buttonType: 'URL',
    buttonText: 'Open dashboard',
    buttonUrl: 'https://app.convosync.in',
    variableSamples: ['Amit'],
  },
  {
    name: 'cs_whatsapp_connect_nudge',
    category: 'Utility',
    language: 'en_US',
    bodyPattern: `Hi {{1}},

Your ConvoSync account is waiting on WhatsApp connection.

Connect your Business number to start inbox + campaigns (takes ~2 minutes).

Stuck on Meta verification? Reply and we'll help.`,
    buttonType: 'URL',
    buttonText: 'Connect WhatsApp',
    buttonUrl: 'https://app.convosync.in/integrations',
    variableSamples: ['Sana'],
  },
  {
    name: 'cs_feature_highlight',
    category: 'Marketing',
    language: 'en_US',
    header: 'New on ConvoSync',
    bodyPattern: `Hi {{1}},

Did you know you can run WhatsApp campaigns + AI agent from the same inbox?

{{2}}

See it in action — tap below.`,
    footer: 'ConvoSync product update',
    buttonType: 'URL',
    buttonText: 'See how it works',
    buttonUrl: 'https://convosync.in',
    variableSamples: ['Neha', 'Teams close more chats without losing context.'],
  },
  {
    name: 'cs_case_study_share',
    category: 'Marketing',
    language: 'en_US',
    header: 'How brands scale WhatsApp',
    bodyPattern: `Hi {{1}},

{{2}} cut reply time using ConvoSync shared inbox + templates.

If you're still juggling chats on phones, this is worth 2 minutes.`,
    buttonType: 'URL',
    buttonText: 'Read story',
    buttonUrl: 'https://convosync.in',
    variableSamples: ['Kabir', 'A D2C brand'],
  },
  {
    name: 'cs_webinar_invite',
    category: 'Marketing',
    language: 'en_US',
    header: 'Free session',
    bodyPattern: `Hi {{1}},

Join our free session: "{{2}}"

Date: {{3}}
Duration: 30 min

Learn inbox setup, Meta templates, and first campaign — live Q&A included.`,
    buttonType: 'URL',
    buttonText: 'Register free',
    buttonUrl: 'https://convosync.in/webinar',
    variableSamples: ['Meera', 'WhatsApp for growing businesses', 'Fri 25 Jul, 5 PM IST'],
  },
  {
    name: 'cs_offer_growth_plan',
    category: 'Marketing',
    language: 'en_US',
    header: 'Launch offer',
    bodyPattern: `Hi {{1}},

ConvoSync Growth Plan — launch offer for {{2}}.

{{3}}

Code: {{4}}
Valid till {{5}}.

Upgrade when you're ready to scale campaigns + team seats.`,
    footer: 'T&Cs apply',
    buttonType: 'URL',
    buttonText: 'View plans',
    buttonUrl: 'https://convosync.in/pricing',
    variableSamples: ['Arjun', 'early teams', 'Extra messages + priority onboarding', 'LAUNCH20', '31 Jul'],
  },
  {
    name: 'cs_reengage_inactive',
    category: 'Marketing',
    language: 'en_US',
    bodyPattern: `Hi {{1}},

It's been a while since you used ConvoSync.

Your workspace still has {{2}} — want us to reconnect WhatsApp and send a test campaign with you?

Reply YES and we'll hop on a quick call.`,
    buttonType: 'URL',
    buttonText: 'Talk to us',
    buttonUrl: 'https://convosync.in/demo',
    variableSamples: ['Vikram', 'your contacts & templates'],
  },
  {
    name: 'cs_referral_ask',
    category: 'Marketing',
    language: 'en_US',
    header: 'Know a founder?',
    bodyPattern: `Hi {{1}},

Loving ConvoSync so far?

If you know a founder still stuck on personal WhatsApp for business, share this — both of you get {{2}}.

Thanks for spreading the word.`,
    buttonType: 'URL',
    buttonText: 'Get referral link',
    buttonUrl: 'https://convosync.in/referral',
    variableSamples: ['Ananya', 'a free month'],
  },
  {
    name: 'cs_launch_announcement',
    category: 'Marketing',
    language: 'en_US',
    header: 'ConvoSync is live',
    bodyPattern: `Hi {{1}},

The wait is over — ConvoSync is officially live.

AI-powered customer engagement to manage conversations, automate support, and close more customers from one workspace.

What you get:
• Unified inbox for WhatsApp, Instagram & more
• AI agents that reply 24/7
• No-code automation workflows
• Broadcast campaigns
• Team collaboration & shared inbox
• CRM & conversation history

Launch offer for early adopters:
• Early access to new AI features
• Priority support
• Exclusive launch pricing

Start today at convosync.io — or tap below.

We built ConvoSync to simplify customer communication with AI, without the complexity.

Questions? Just reply here — we read every message.

— Vikas Swami, Founder, ConvoSync`,
    footer: 'convosync.io',
    buttonType: 'URL',
    buttonText: 'Get Started',
    buttonUrl: 'https://convosync.io',
    variableSamples: ['Vikas'],
  },
];

function variablesFromSamples(samples: string[]): string[] {
  return samples.map((_, i) => `var_${i + 1}`);
}

async function resolveWorkspaceId(): Promise<{ id: string; name: string }> {
  const fromEnv = process.env.WORKSPACE_ID?.trim();
  if (fromEnv) {
    const ws = await prisma.workspace.findUnique({
      where: { id: fromEnv },
      select: { id: true, name: true },
    });
    if (!ws) throw new Error(`WORKSPACE_ID not found: ${fromEnv}`);
    return ws;
  }

  const bySlug = await prisma.workspace.findFirst({
    where: { slug: 'convosync' },
    select: { id: true, name: true },
  });
  if (bySlug) return bySlug;

  const byName = await prisma.workspace.findFirst({
    where: { name: { equals: 'ConvoSync', mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (byName) return byName;

  const first = await prisma.workspace.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  if (!first) throw new Error('No workspace found in database');
  return first;
}

async function main() {
  const workspace = await resolveWorkspaceId();
  console.log(`Seeding drafts into workspace: ${workspace.name} (${workspace.id})`);

  let created = 0;
  let skipped = 0;

  for (const t of TEMPLATES) {
    const existing = await prisma.template.findUnique({
      where: { workspaceId_name: { workspaceId: workspace.id, name: t.name } },
    });
    if (existing) {
      console.log(`  skip  ${t.name} (already exists, status=${existing.status})`);
      skipped += 1;
      continue;
    }

    await prisma.template.create({
      data: {
        workspaceId: workspace.id,
        name: t.name,
        category: t.category,
        language: t.language,
        status: 'draft',
        bodyPattern: t.bodyPattern,
        header: t.header ?? null,
        headerFormat: t.header ? 'TEXT' : null,
        footer: t.footer ?? null,
        variables: variablesFromSamples(t.variableSamples),
        buttons: t.buttonText ? [t.buttonText] : [],
        buttonType: t.buttonType ?? null,
        buttonText: t.buttonText ?? null,
        buttonUrl: t.buttonUrl ?? null,
        buttonPhoneNumber: null,
        waTemplateId: null,
        rejectionReason: null,
      },
    });
    console.log(`  create ${t.name} (${t.category})`);
    created += 1;
  }

  console.log(`Done. created=${created} skipped=${skipped}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
