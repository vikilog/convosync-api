import axios from 'axios';
import { prisma } from '../index.js';
import { config } from '../config.js';
import {
  decryptSecret,
  encryptSecret,
} from '../lib/field-encryption.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

export type MetaAdsConnectInput = {
  workspaceId: string;
  code: string;
  redirectUri?: string;
  adAccountId?: string;
};

export type MetaAdsConnectResult = {
  adAccountId: string;
  adAccountName: string;
  currency: string;
  accountsFound: number;
  pageLinked?: boolean;
  pageName?: string;
};

type RawAdAccount = {
  id: string;
  name?: string;
  currency?: string;
  account_status?: number;
  balance?: string;
  spend_cap?: string;
  timezone_name?: string;
};

export type MetaAdAccountOption = {
  id: string;
  name: string;
  currency: string;
  status: 'ACTIVE' | 'DISABLED';
  source: 'page_business' | 'personal';
  campaignCount: number;
  isSelected: boolean;
};

function dedupeAdAccounts(accounts: RawAdAccount[]): RawAdAccount[] {
  const seen = new Set<string>();
  return accounts.filter((account) => {
    if (seen.has(account.id)) return false;
    seen.add(account.id);
    return true;
  });
}

function normalizeAdAccountId(id: string): string {
  return id.startsWith('act_') ? id : `act_${id}`;
}

function matchesAdAccountId(a: RawAdAccount, targetId?: string): boolean {
  if (!targetId) return false;
  const normalized = normalizeAdAccountId(targetId);
  return a.id === targetId || a.id === normalized || a.id.replace(/^act_/, '') === targetId.replace(/^act_/, '');
}

type RawInsightRow = {
  spend?: string;
  impressions?: string;
  clicks?: string;
  cpm?: string;
  cpc?: string;
  ctr?: string;
  reach?: string;
  frequency?: string;
  date_start?: string;
  date_stop?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
};

type RawCampaign = {
  id: string;
  name?: string;
  status?: string;
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  start_time?: string;
  stop_time?: string;
  insights?: { data?: RawInsightRow[] };
};

function normalizeRedirectUri(uri?: string): string | undefined {
  if (!uri) return undefined;
  try {
    const url = new URL(uri);
    url.hash = '';
    url.search = '';
    const path = url.pathname.replace(/\/+$/, '') || '';
    return `${url.origin}${path}`;
  } catch {
    return uri.replace(/\/+$/, '');
  }
}

export function resolveMetaAdsRedirectUri(preferred?: string): string {
  const fromEnv = process.env.META_ADS_OAUTH_REDIRECT_URI;
  return (
    normalizeRedirectUri(preferred) ||
    normalizeRedirectUri(fromEnv) ||
    `${config.frontendUrl}/meta-ads/callback`
  );
}

async function exchangeCodeForToken(code: string, redirectUri: string): Promise<string> {
  const tokenRes = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      code,
      redirect_uri: redirectUri,
    },
  });
  const accessToken = tokenRes.data.access_token;
  if (!accessToken) throw new Error('Failed to get access token from Meta');
  return accessToken;
}

async function exchangeForLongLivedUserToken(shortLivedToken: string): Promise<string> {
  try {
    const res = await axios.get(`${GRAPH}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: config.meta.appId,
        client_secret: config.meta.appSecret,
        fb_exchange_token: shortLivedToken,
      },
    });
    return res.data.access_token || shortLivedToken;
  } catch {
    return shortLivedToken;
  }
}

async function fetchUserAdAccounts(userToken: string): Promise<RawAdAccount[]> {
  const res = await axios.get(`${GRAPH}/me/adaccounts`, {
    params: {
      fields: 'id,name,currency,account_status,balance,spend_cap,timezone_name',
      access_token: userToken,
      limit: '100',
    },
  });
  return (res.data.data as RawAdAccount[] | undefined) || [];
}

async function fetchPageBusinessId(pageId: string, userToken: string): Promise<string | null> {
  try {
    const res = await axios.get(`${GRAPH}/${pageId}`, {
      params: { fields: 'business', access_token: userToken },
    });
    const business = res.data.business as { id?: string } | undefined;
    return business?.id || null;
  } catch {
    return null;
  }
}

async function fetchBusinessAdAccounts(businessId: string, userToken: string): Promise<RawAdAccount[]> {
  const accounts: RawAdAccount[] = [];
  for (const edge of ['owned_ad_accounts', 'client_ad_accounts']) {
    try {
      const res = await axios.get(`${GRAPH}/${businessId}/${edge}`, {
        params: {
          fields: 'id,name,currency,account_status,balance,spend_cap,timezone_name',
          access_token: userToken,
          limit: '100',
        },
      });
      accounts.push(...((res.data.data as RawAdAccount[] | undefined) || []));
    } catch {
      // Business edge may be unavailable for some roles — skip silently.
    }
  }
  return accounts;
}

async function fetchCampaignCount(adAccountId: string, userToken: string): Promise<number> {
  try {
    const res = await axios.get(`${GRAPH}/${adAccountId}/campaigns`, {
      params: {
        access_token: userToken,
        limit: '1',
        summary: 'total_count',
        filtering: JSON.stringify([
          { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'IN_PROCESS'] },
        ]),
      },
    });
    const summary = res.data.summary as { total_count?: number } | undefined;
    if (typeof summary?.total_count === 'number') return summary.total_count;
    return ((res.data.data as unknown[] | undefined) || []).length;
  } catch {
    return 0;
  }
}

async function resolveAllAdAccounts(
  userToken: string,
  fbPageId?: string | null
): Promise<{ pageBusiness: RawAdAccount[]; personal: RawAdAccount[]; all: RawAdAccount[] }> {
  const personal = await fetchUserAdAccounts(userToken);
  let pageBusiness: RawAdAccount[] = [];

  if (fbPageId) {
    const businessId = await fetchPageBusinessId(fbPageId, userToken);
    if (businessId) {
      pageBusiness = await fetchBusinessAdAccounts(businessId, userToken);
    }
  }

  const all = dedupeAdAccounts([...pageBusiness, ...personal]);
  return { pageBusiness, personal, all };
}

function pickDefaultAdAccount(
  accounts: RawAdAccount[],
  pageBusiness: RawAdAccount[],
  preferredId?: string
): RawAdAccount {
  if (preferredId) {
    const match = accounts.find((account) => matchesAdAccountId(account, preferredId));
    if (match) return match;
  }
  if (pageBusiness.length > 0) return pageBusiness[0];
  return accounts[0];
}

function parseNum(value?: string | number): number {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function extractWaConversations(actions?: Array<{ action_type?: string; value?: string }>): number {
  if (!actions?.length) return 0;
  const types = [
    'onsite_conversion.messaging_conversation_started_7d',
    'onsite_conversion.messaging_first_reply',
    'onsite_conversion.messaging_conversation_started',
  ];
  return actions.reduce((sum, action) => {
    if (action.action_type && types.some((t) => action.action_type?.includes(t))) {
      return sum + parseNum(action.value);
    }
    return sum;
  }, 0);
}

function mapObjective(objective?: string): string {
  const raw = (objective || 'TRAFFIC').toUpperCase();
  if (raw.includes('MESSAGE')) return 'MESSAGES';
  if (raw.includes('LEAD')) return 'LEAD_GENERATION';
  if (raw.includes('CONVERSION')) return 'CONVERSIONS';
  if (raw.includes('AWARENESS')) return 'BRAND_AWARENESS';
  if (raw.includes('REACH')) return 'REACH';
  return 'TRAFFIC';
}

function mapPlatform(objective?: string): string {
  const raw = (objective || '').toUpperCase();
  if (raw.includes('MESSAGES')) return 'WhatsApp Ads';
  return 'Facebook Feed';
}

export function normalizeGraphCampaign(raw: RawCampaign) {
  const insight = raw.insights?.data?.[0];
  const clicks = parseNum(insight?.clicks);
  const impressions = parseNum(insight?.impressions);
  const spend = parseNum(insight?.spend);
  const reach = parseNum(insight?.reach);
  const waConversations = extractWaConversations(insight?.actions);
  const objective = mapObjective(raw.objective);
  const isCTWA = objective === 'MESSAGES';
  const conversations = waConversations || (isCTWA ? clicks : 0);
  const conversionMultiplier =
    clicks > 0 ? parseFloat(((conversations / clicks) * 100).toFixed(1)) : 0;

  const dailyBudget = raw.daily_budget
    ? parseNum(raw.daily_budget) / 100
    : raw.lifetime_budget
      ? parseNum(raw.lifetime_budget) / 100
      : 0;

  return {
    id: raw.id,
    name: raw.name || raw.id,
    status: (raw.status || 'PAUSED').toUpperCase(),
    objective,
    platform: mapPlatform(raw.objective),
    dailyBudget,
    lifetimeBudget: raw.lifetime_budget ? parseNum(raw.lifetime_budget) / 100 : undefined,
    startTime: raw.start_time?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    endTime: raw.stop_time?.slice(0, 10),
    clicks,
    conversations,
    conversionMultiplier,
    isCTWA,
    waConversationsStarted: isCTWA ? conversations : undefined,
    previewUrl: '',
    insights: {
      spend,
      impressions,
      clicks,
      cpm: parseNum(insight?.cpm),
      cpc: parseNum(insight?.cpc),
      ctr: parseNum(insight?.ctr),
      reach,
      frequency: parseNum(insight?.frequency),
      conversions: conversations || undefined,
      roas: spend > 0 && conversations > 0 ? parseFloat(((conversations * 50) / spend).toFixed(1)) : undefined,
      dateStart: insight?.date_start || raw.start_time?.slice(0, 10) || '',
      dateStop: insight?.date_stop || raw.stop_time?.slice(0, 10) || '',
    },
  };
}

export async function connectWorkspaceMetaAds(
  input: MetaAdsConnectInput
): Promise<MetaAdsConnectResult> {
  const redirectUri = resolveMetaAdsRedirectUri(input.redirectUri);
  const shortToken = await exchangeCodeForToken(input.code, redirectUri);
  const userToken = await exchangeForLongLivedUserToken(shortToken);

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { fbPageId: true, fbPageName: true },
  });

  const { pageBusiness, all: accounts } = await resolveAllAdAccounts(
    userToken,
    workspace?.fbPageId
  );

  if (accounts.length === 0) {
    throw new Error(
      'No Meta Ad Accounts found. Ensure your Meta login has access to a Business Ad Account linked to your Page.'
    );
  }

  const selected = pickDefaultAdAccount(accounts, pageBusiness, input.adAccountId);

  await prisma.workspace.update({
    where: { id: input.workspaceId },
    data: {
      metaUserToken: encryptSecret(userToken),
      metaAdAccountId: selected.id,
    },
  });

  return {
    adAccountId: selected.id,
    adAccountName: selected.name || selected.id,
    currency: selected.currency || 'INR',
    accountsFound: accounts.length,
    pageLinked: pageBusiness.length > 0,
    pageName: workspace?.fbPageName || undefined,
  };
}

export async function listWorkspaceMetaAdAccounts(workspaceId: string): Promise<MetaAdAccountOption[]> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { metaUserToken: true, metaAdAccountId: true, fbPageId: true },
  });

  const metaUserToken = decryptSecret(workspace?.metaUserToken);
  if (!metaUserToken) {
    throw new Error('Meta Ads not connected');
  }

  const { pageBusiness, personal, all } = await resolveAllAdAccounts(
    metaUserToken,
    workspace!.fbPageId
  );
  const pageBusinessIds = new Set(pageBusiness.map((account) => account.id));

  const withCounts = await Promise.all(
    all.map(async (account) => ({
      account,
      campaignCount: await fetchCampaignCount(account.id, metaUserToken),
    }))
  );

  return withCounts
    .sort((a, b) => {
      if (b.campaignCount !== a.campaignCount) return b.campaignCount - a.campaignCount;
      const aPage = pageBusinessIds.has(a.account.id) ? 1 : 0;
      const bPage = pageBusinessIds.has(b.account.id) ? 1 : 0;
      return bPage - aPage;
    })
    .map(({ account, campaignCount }) => ({
      id: account.id,
      name: account.name || account.id,
      currency: account.currency || 'INR',
      status: account.account_status === 1 ? ('ACTIVE' as const) : ('DISABLED' as const),
      source: pageBusinessIds.has(account.id) ? ('page_business' as const) : ('personal' as const),
      campaignCount,
      isSelected: account.id === workspace!.metaAdAccountId,
    }));
}

export async function selectWorkspaceMetaAdAccount(workspaceId: string, adAccountId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { metaUserToken: true, fbPageId: true },
  });
  const metaUserToken = decryptSecret(workspace?.metaUserToken);
  if (!metaUserToken) throw new Error('Meta Ads not connected');

  const { all } = await resolveAllAdAccounts(metaUserToken, workspace!.fbPageId);
  const selected = all.find((account) => matchesAdAccountId(account, adAccountId));
  if (!selected) {
    throw new Error('Ad account not found or you do not have access to it.');
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { metaAdAccountId: selected.id },
  });

  return {
    adAccountId: selected.id,
    adAccountName: selected.name || selected.id,
    currency: selected.currency || 'INR',
  };
}

export async function getConnectedMetaAdsAccount(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { metaAdAccountId: true, metaUserToken: true },
  });

  const metaUserToken = decryptSecret(workspace?.metaUserToken);
  if (!workspace?.metaAdAccountId || !metaUserToken) {
    return { connected: false as const };
  }

  try {
    const res = await axios.get(`${GRAPH}/${workspace.metaAdAccountId}`, {
      params: {
        fields: 'id,name,currency,account_status,balance,spend_cap,timezone_name',
        access_token: metaUserToken,
      },
    });
    const data = res.data as RawAdAccount;
    return {
      connected: true as const,
      account: {
        id: data.id,
        name: data.name || data.id,
        currency: data.currency || 'INR',
        status: data.account_status === 1 ? ('ACTIVE' as const) : ('DISABLED' as const),
        balance: parseNum(data.balance) / 100,
        spendCap: data.spend_cap ? parseNum(data.spend_cap) / 100 : undefined,
        timezone: data.timezone_name || 'Asia/Kolkata',
      },
    };
  } catch {
    return {
      connected: true as const,
      account: {
        id: workspace.metaAdAccountId,
        name: workspace.metaAdAccountId,
        currency: 'INR',
        status: 'ACTIVE' as const,
        balance: 0,
        timezone: 'Asia/Kolkata',
      },
    };
  }
}

export async function fetchMetaAdCampaigns(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { metaAdAccountId: true, metaUserToken: true },
  });
  const metaUserToken = decryptSecret(workspace?.metaUserToken);
  if (!workspace?.metaAdAccountId || !metaUserToken) {
    throw new Error('Meta Ads account not connected');
  }

  const res = await axios.get(`${GRAPH}/${workspace.metaAdAccountId}/campaigns`, {
    params: {
      fields:
        'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,insights.date_preset(last_30d){spend,impressions,clicks,cpm,cpc,ctr,reach,frequency,actions,date_start,date_stop}',
      access_token: metaUserToken,
      limit: '100',
      filtering: JSON.stringify([
        { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES'] },
      ]),
    },
  });

  const rows = (res.data.data as RawCampaign[] | undefined) || [];
  return rows.map(normalizeGraphCampaign);
}

export async function setCampaignStatus(
  workspaceId: string,
  campaignId: string,
  status: 'ACTIVE' | 'PAUSED' | 'DELETED'
) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { metaUserToken: true },
  });
  const metaUserToken = decryptSecret(workspace?.metaUserToken);
  if (!metaUserToken) throw new Error('Meta Ads not connected');

  await axios.post(
    `${GRAPH}/${campaignId}`,
    { status },
    { params: { access_token: metaUserToken } }
  );
}

export type CreateCTWAInput = {
  campaignName: string;
  dailyBudget: number;
  startDate: string;
  endDate?: string;
  headline: string;
  description: string;
  targeting: {
    ageMin: number;
    ageMax: number;
    locations: string[];
  };
};

export async function createCTWACampaign(workspaceId: string, body: CreateCTWAInput) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { metaAdAccountId: true, metaUserToken: true, waNumberId: true },
  });
  const token = decryptSecret(workspace?.metaUserToken);
  if (!workspace?.metaAdAccountId || !token) {
    throw new Error('Meta Ads account not connected');
  }
  if (!workspace.waNumberId) {
    throw new Error('WhatsApp phone number not connected. Connect WhatsApp first for CTWA ads.');
  }
  const actId = workspace.metaAdAccountId;

  const campaignRes = await axios.post(
    `${GRAPH}/${actId}/campaigns`,
    {
      name: body.campaignName,
      objective: 'OUTCOME_ENGAGEMENT',
      status: 'PAUSED',
      special_ad_categories: [],
    },
    { params: { access_token: token } }
  );
  const campaignId = campaignRes.data.id as string;

  const adSetRes = await axios.post(
    `${GRAPH}/${actId}/adsets`,
    {
      name: `${body.campaignName} — Ad Set`,
      campaign_id: campaignId,
      daily_budget: Math.round(body.dailyBudget * 100),
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'CONVERSATIONS',
      destination_type: 'WHATSAPP',
      start_time: body.startDate,
      ...(body.endDate ? { end_time: body.endDate } : {}),
      targeting: {
        age_min: body.targeting.ageMin,
        age_max: body.targeting.ageMax,
        geo_locations: { countries: body.targeting.locations.length ? ['IN'] : ['IN'] },
      },
      status: 'PAUSED',
    },
    { params: { access_token: token } }
  );
  const adSetId = adSetRes.data.id as string;

  const adRes = await axios.post(
    `${GRAPH}/${actId}/ads`,
    {
      name: body.campaignName,
      adset_id: adSetId,
      status: 'PAUSED',
      creative: {
        object_story_spec: {
          link_data: {
            message: body.description,
            name: body.headline,
            call_to_action: {
              type: 'WHATSAPP_MESSAGE',
              value: { link: `https://wa.me/${workspace.waNumberId}` },
            },
          },
        },
      },
    },
    { params: { access_token: token } }
  );

  return {
    campaignId,
    adSetId,
    adId: adRes.data.id as string,
  };
}
