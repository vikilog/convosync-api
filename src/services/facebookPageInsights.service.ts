import {
  fetchFacebookPageInsights,
  getConnectedFacebookPage,
  inspectPageAccessToken,
} from './facebookConnect.js';
import { getWorkspaceFacebookPageCredentials } from './facebookCredentials.js';

type InsightMetric = {
  name: string;
  values?: Array<{ value: number | Record<string, number>; end_time?: string }>;
};

function numericValue(val: number | Record<string, number> | undefined): number {
  if (typeof val === 'number') return val;
  if (val && typeof val === 'object') {
    return Object.values(val).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  }
  return 0;
}

function metricDailyValues(metric?: InsightMetric): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of metric?.values || []) {
    if (!entry.end_time) continue;
    const dateKey = new Date(entry.end_time).toISOString().slice(0, 10);
    map.set(dateKey, numericValue(entry.value));
  }
  return map;
}

function formatDayLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function pickDailyMetric(byName: Map<string, InsightMetric>, ...names: string[]): Map<string, number> {
  for (const name of names) {
    const values = metricDailyValues(byName.get(name));
    if (values.size > 0) return values;
  }
  return new Map();
}

/** Day-by-day series for the Insights charts (reach/engaged/engagements/views/followers). */
export function buildDailySeries(data: { data?: InsightMetric[] }) {
  const metrics = data.data || [];
  const byName = new Map(metrics.map((m) => [m.name, m]));

  const reachMap = pickDailyMetric(byName, 'page_media_view', 'page_impressions');
  const engagedMap = pickDailyMetric(byName, 'page_total_media_view_unique', 'page_engaged_users');
  const engagementMap = pickDailyMetric(byName, 'page_post_engagements');
  const viewsMap = pickDailyMetric(byName, 'page_views_total');
  const followersMap = pickDailyMetric(byName, 'page_daily_follows');

  const dateSet = new Set<string>();
  for (const map of [reachMap, engagedMap, engagementMap, viewsMap, followersMap]) {
    for (const key of map.keys()) dateSet.add(key);
  }

  return [...dateSet]
    .sort()
    .map((date) => ({
      date,
      label: formatDayLabel(date),
      reach: reachMap.get(date) ?? 0,
      engagedUsers: engagedMap.get(date) ?? 0,
      postEngagements: engagementMap.get(date) ?? 0,
      pageViews: viewsMap.get(date) ?? 0,
      newFollowers: followersMap.get(date) ?? 0,
    }));
}

function sumMetricValues(metric?: InsightMetric): number {
  if (!metric?.values?.length) return 0;
  return metric.values.reduce((sum, entry) => {
    const val = entry.value;
    if (typeof val === 'number') return sum + val;
    if (val && typeof val === 'object') {
      return sum + Object.values(val).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    }
    return sum;
  }, 0);
}

function latestMetricValue(metric?: InsightMetric): number {
  const values = metric?.values;
  if (!values?.length) return 0;
  const last = values[values.length - 1]?.value;
  if (typeof last === 'number') return last;
  if (last && typeof last === 'object') {
    return Object.values(last).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  }
  return 0;
}

function fansDelta(metric?: InsightMetric): number {
  const values = metric?.values;
  if (!values || values.length < 2) return 0;
  const prev = values[values.length - 2]?.value;
  const curr = values[values.length - 1]?.value;
  if (typeof prev === 'number' && typeof curr === 'number') return Math.max(0, curr - prev);
  return 0;
}

/** Summed/latest totals for the Insights stat strip. */
export function normalizeInsights(data: { data?: InsightMetric[] }) {
  const metrics = data.data || [];
  const byName = new Map(metrics.map((m) => [m.name, m]));

  const pageFans =
    latestMetricValue(byName.get('page_follows')) || latestMetricValue(byName.get('page_fans'));
  const pageImpressions =
    sumMetricValues(byName.get('page_media_view')) || sumMetricValues(byName.get('page_impressions'));
  const pageEngagedUsers =
    sumMetricValues(byName.get('page_total_media_view_unique')) ||
    sumMetricValues(byName.get('page_engaged_users'));
  const pagePostEngagements = sumMetricValues(byName.get('page_post_engagements'));
  const pageViews = sumMetricValues(byName.get('page_views_total'));

  const dailyFollows = sumMetricValues(byName.get('page_daily_follows'));
  const pageFansDelta =
    dailyFollows || fansDelta(byName.get('page_follows')) || fansDelta(byName.get('page_fans'));

  return {
    pageFans,
    pageFansDelta,
    pageImpressions,
    pageEngagedUsers,
    pagePostEngagements,
    pageViews,
  };
}

export type FacebookPageInsightsResult = {
  connected: boolean;
  insights?: ReturnType<typeof normalizeInsights>;
  daily?: ReturnType<typeof buildDailySeries>;
  grantedScopes?: string[];
  missingScopes?: string[];
  error?: string;
};

/** Full Page-level Insights fetch for a workspace — used by both the legacy Facebook route and Social Listening's Dashboard. */
export async function getFacebookPageInsightsForWorkspace(
  workspaceId: string
): Promise<FacebookPageInsightsResult> {
  const creds = await getWorkspaceFacebookPageCredentials(workspaceId);
  if (!creds) return { connected: false, error: 'Page not connected' };

  const tokenInfo = await inspectPageAccessToken(creds.pageAccessToken);
  if (tokenInfo.missingScopes.includes('read_insights')) {
    return {
      connected: true,
      error: 'Missing read_insights permission',
      grantedScopes: tokenInfo.scopes,
      missingScopes: tokenInfo.missingScopes,
    };
  }

  const pageMeta = await getConnectedFacebookPage(workspaceId);
  const followersFallback =
    pageMeta.connected && 'followersCount' in pageMeta ? pageMeta.followersCount : 0;

  const raw = await fetchFacebookPageInsights(creds.pageId, creds.pageAccessToken);
  const insights = normalizeInsights(raw);
  if (insights.pageFans === 0 && followersFallback > 0) {
    insights.pageFans = followersFallback;
  }
  const daily = buildDailySeries(raw);

  return {
    connected: true,
    insights,
    daily,
    grantedScopes: tokenInfo.scopes,
    missingScopes: tokenInfo.missingScopes,
  };
}
