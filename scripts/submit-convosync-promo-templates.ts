/**
 * Submit ConvoSync promo WhatsApp template drafts to Meta.
 * Avoids importing src/index.js (which starts the HTTP server).
 *
 * Usage:
 *   cd backend && npx tsx scripts/submit-convosync-promo-templates.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { config } from '../src/config.js';
import { decryptSecret, isSecretStored } from '../src/lib/field-encryption.js';
import { metaStatusToSystem } from '../src/constants/templateLabels.js';
import {
  buildMetaComponents,
  createMetaMessageTemplate,
  metaErrorMessage,
  normalizeMetaLanguageCode,
  type WorkspaceWhatsAppCredentials,
} from '../src/services/metaMessageTemplates.js';

const prisma = new PrismaClient();

const SAMPLES: Record<string, string[]> = {
  cs_intro_whatsapp_business: ['Rahul'],
  cs_demo_invite: ['Priya', 'your store', 'Thu 4 PM'],
  cs_trial_started: ['Amit'],
  cs_whatsapp_connect_nudge: ['Sana'],
  cs_feature_highlight: ['Neha', 'Teams close more chats without losing context.'],
  cs_case_study_share: ['Kabir', 'A D2C brand'],
  cs_webinar_invite: ['Meera', 'WhatsApp for growing businesses', 'Fri 25 Jul, 5 PM IST'],
  cs_offer_growth_plan: [
    'Arjun',
    'early teams',
    'Extra messages + priority onboarding',
    'LAUNCH20',
    '31 Jul',
  ],
  cs_reengage_inactive: ['Vikram', 'your contacts & templates'],
  cs_referral_ask: ['Ananya', 'a free month'],
  cs_launch_announcement: ['Vikas'],
};

async function resolveWorkspace() {
  const fromEnv = process.env.WORKSPACE_ID?.trim();
  if (fromEnv) {
    const ws = await prisma.workspace.findUnique({
      where: { id: fromEnv },
      select: { id: true, name: true, isSuperAdmin: true, waToken: true, wabaId: true, waNumberId: true },
    });
    if (!ws) throw new Error(`WORKSPACE_ID not found: ${fromEnv}`);
    return ws;
  }
  const ws = await prisma.workspace.findFirst({
    where: { slug: 'convosync' },
    select: { id: true, name: true, isSuperAdmin: true, waToken: true, wabaId: true, waNumberId: true },
  });
  if (!ws) throw new Error('ConvoSync workspace not found');
  return ws;
}

async function resolveCreds(workspace: {
  id: string;
  isSuperAdmin: boolean;
  waToken: string | null;
  wabaId: string | null;
  waNumberId: string | null;
}): Promise<WorkspaceWhatsAppCredentials> {
  const fallback = await prisma.whatsAppPhoneAccount.findFirst({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: 'asc' },
  });

  let wabaId = workspace.wabaId || fallback?.wabaId || undefined;
  let accessToken = decryptSecret(workspace.waToken);

  if (workspace.isSuperAdmin) {
    if (config.superAdmin.whatsappAccessToken) {
      accessToken = config.superAdmin.whatsappAccessToken;
    }
    if (config.superAdmin.wabaId) {
      wabaId = wabaId || config.superAdmin.wabaId;
    }
  }

  if (!accessToken || !wabaId) {
    throw new Error('WhatsApp credentials missing for ConvoSync workspace.');
  }
  if (!workspace.isSuperAdmin && !isSecretStored(workspace.waToken)) {
    throw new Error('WhatsApp is not connected for this company.');
  }

  return {
    wabaId,
    accessToken,
    phoneNumberId: workspace.waNumberId || fallback?.phoneNumberId || undefined,
  };
}

async function main() {
  const workspace = await resolveWorkspace();
  console.log(`Submitting drafts for: ${workspace.name} (${workspace.id})`);

  const creds = await resolveCreds(workspace);
  console.log(`WABA: ${creds.wabaId}`);

  const templates = await prisma.template.findMany({
    where: {
      workspaceId: workspace.id,
      name: { startsWith: 'cs_' },
      status: { in: ['draft', 'rejected', 'paused'] },
    },
    orderBy: { name: 'asc' },
  });

  if (templates.length === 0) {
    console.log('No draft/rejected cs_* templates to submit.');
    return;
  }

  let ok = 0;
  let fail = 0;

  for (const t of templates) {
    const samples = SAMPLES[t.name];
    process.stdout.write(`  ${t.name} … `);
    try {
      if (samples?.length) {
        await prisma.template.update({
          where: { id: t.id },
          data: { variables: samples },
        });
      }

      const components = buildMetaComponents({
        bodyPattern: t.bodyPattern,
        header: t.header,
        headerFormat: t.headerFormat,
        headerMediaHandle: t.headerMediaHandle,
        footer: t.footer,
        buttonType: t.buttonType,
        buttonText: t.buttonText,
        buttonUrl: t.buttonUrl,
        buttonPhoneNumber: t.buttonPhoneNumber,
        buttonUrlSample: t.buttonUrl?.includes('{{') ? 'sample_link_id' : undefined,
        variableSamples: samples ?? t.variables,
      });

      const metaRes = await createMetaMessageTemplate(creds, {
        name: t.name,
        category: t.category,
        language: normalizeMetaLanguageCode(t.language),
        components,
      });

      await prisma.template.update({
        where: { id: t.id },
        data: {
          status: metaStatusToSystem(metaRes.status || 'PENDING'),
          waTemplateId: metaRes.id ?? t.waTemplateId,
          rejectionReason: null,
          variables: samples ?? t.variables,
        },
      });
      console.log(`ok (${metaRes.status || 'PENDING'}) id=${metaRes.id ?? '—'}`);
      ok += 1;
    } catch (err) {
      const message = metaErrorMessage(err);
      await prisma.template.update({
        where: { id: t.id },
        data: { status: 'rejected', rejectionReason: message },
      });
      console.log(`FAIL: ${message}`);
      fail += 1;
    }
  }

  console.log(`Done. submitted=${ok} failed=${fail}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
