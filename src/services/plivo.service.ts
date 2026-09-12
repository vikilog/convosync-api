import { config } from '../config.js';

/**
 * Thin wrapper over Plivo's REST API (Basic Auth over HTTPS — no SDK needed).
 * https://www.plivo.com/docs/numbers/api/number/
 *
 * `searchAvailableNumbers` is read-only and safe to call anytime `config.plivo.enabled`.
 * `buyNumber` spends real money on the connected Plivo account — callers must only
 * invoke it after a verified payment (see virtualNumber.routes.ts).
 */

export type PlivoAvailableNumber = {
  number: string;
  /** E.164-ish display, e.g. "+91 22 6423 1648". */
  displayNumber: string;
  type: string;
  country: string;
  city: string | null;
  region: string | null;
  monthlyRentalPaise: number;
};

export type PlivoBoughtNumber = {
  plivoNumberId: string;
  number: string;
};

export type PlivoNumberSearchResult = {
  numbers: PlivoAvailableNumber[];
  totalCount: number;
  offset: number;
  hasMore: boolean;
};

function assertEnabled() {
  if (!config.plivo.enabled) {
    throw new Error('Plivo is not configured. Set PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN.');
  }
}

function authHeader() {
  const token = Buffer.from(`${config.plivo.authId}:${config.plivo.authToken}`).toString('base64');
  return `Basic ${token}`;
}

function baseUrl() {
  return `https://api.plivo.com/v1/Account/${config.plivo.authId}`;
}

async function plivoRequest<T>(path: string, init?: RequestInit): Promise<T> {
  assertEnabled();
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ||
      `Plivo request failed (${res.status} ${res.statusText})`;
    throw new Error(message);
  }
  return body as T;
}

type PlivoSearchObject = {
  number: string;
  type: string;
  country: string;
  city?: string;
  region?: string;
  monthly_rental_rate: string;
};

/** Country ISO codes we currently offer in the picker. */
export type PlivoCountryIso = 'IN' | 'US' | 'GB';

export async function searchAvailableNumbers(params: {
  countryIso?: PlivoCountryIso;
  /** Area-code / city digit prefix, e.g. "22" for Mumbai, "80" for Bengaluru. */
  pattern?: string;
  limit?: number;
  offset?: number;
}): Promise<PlivoNumberSearchResult> {
  const limit = params.limit ?? 9;
  const offset = params.offset ?? 0;
  const query = new URLSearchParams({
    country_iso: params.countryIso ?? 'IN',
    type: 'fixed',
    limit: String(limit),
    offset: String(offset),
  });
  if (params.pattern) query.set('pattern', params.pattern);

  const data = await plivoRequest<{
    objects: PlivoSearchObject[];
    meta: { total_count: number; offset: number; next: string | null };
  }>(`/PhoneNumber/?${query.toString()}`);

  const numbers = (data.objects ?? []).map((o) => ({
    number: o.number,
    displayNumber: formatDisplayNumber(o.number, params.countryIso ?? 'IN'),
    type: o.type,
    country: o.country,
    city: o.city ?? null,
    region: o.region ?? null,
    // Plivo returns a decimal string like "0.80" (USD) — INR pricing is applied
    // on our side (see priceForType in routes/virtualNumber.ts) since this
    // account bills in INR; monthlyRentalPaise is informational only for now.
    monthlyRentalPaise: Math.round(parseFloat(o.monthly_rental_rate || '0') * 100),
  }));

  return {
    numbers,
    totalCount: data.meta?.total_count ?? numbers.length,
    offset: data.meta?.offset ?? offset,
    hasMore: Boolean(data.meta?.next),
  };
}

export async function buyNumber(number: string, alias?: string): Promise<PlivoBoughtNumber> {
  assertEnabled();
  const data = await plivoRequest<{ numbers: { number: string; status: string }[]; message?: string }>(
    `/PhoneNumber/${encodeURIComponent(number)}/`,
    {
      method: 'POST',
      body: JSON.stringify(alias ? { alias } : {}),
    }
  );
  const bought = data.numbers?.[0];
  if (!bought || bought.status !== 'success') {
    throw new Error(data.message || `Plivo did not confirm purchase of ${number}.`);
  }
  return { plivoNumberId: bought.number, number: bought.number };
}

export function formatDisplayNumber(raw: string, countryIso: PlivoCountryIso = 'IN'): string {
  const digits = raw.replace(/\D/g, '');
  if (countryIso === 'IN' && digits.startsWith('91') && digits.length === 12) {
    return `+91 ${digits.slice(2, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
  }
  return `+${digits}`;
}

export type PlivoOwnedNumber = {
  number: string;
  alias: string | null;
  region: string | null;
  type: string;
};

/** Numbers already purchased/owned on this Plivo account (not the search API). */
export async function listOwnedNumbers(): Promise<PlivoOwnedNumber[]> {
  const data = await plivoRequest<{
    objects: { number: string; alias?: string; region?: string; type?: string }[];
  }>('/Number/?limit=50');
  return (data.objects ?? []).map((o) => ({
    number: o.number,
    alias: o.alias ?? null,
    region: o.region ?? null,
    type: o.type ?? 'unknown',
  }));
}

export type PlivoCallRecord = {
  callUuid: string;
  conferenceUuid: string | null;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  callState: string;
  durationSeconds: number;
  startTime: string | null;
  endTime: string | null;
  hangupCause: string | null;
};

/**
 * Real call detail records (CDRs) for this account, optionally filtered to one
 * number. Plivo's browser/softphone test calls create a second "leg" whose
 * from/to is a `sip:...@phone.plivo.com` URI (the console dialer's own leg,
 * sharing the same conference_uuid as the real PSTN leg) — those are dropped
 * here since they aren't a call a customer placed or received.
 *
 * `number` filters client-side (Plivo's Call list API has no such filter), so a page can
 * come back with fewer than `limit` matching records even when `hasMore` is true — the
 * caller just needs to keep paging until `hasMore` is false.
 */
export async function listCalls(params: {
  number?: string;
  limit?: number;
  offset?: number;
}): Promise<{ records: PlivoCallRecord[]; hasMore: boolean }> {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });

  const data = await plivoRequest<{
    objects: {
      call_uuid: string;
      conference_uuid?: string | null;
      from_number: string;
      to_number: string;
      call_direction: string;
      call_state: string;
      call_duration?: number | string;
      initiation_time?: string;
      end_time?: string;
      hangup_cause_name?: string;
    }[];
    meta?: { total_count: number; offset: number; next: string | null };
  }>(`/Call/?${query.toString()}`);

  const all = (data.objects ?? [])
    .filter((c) => !c.from_number?.startsWith('sip:') && !c.to_number?.startsWith('sip:'))
    .map((c) => ({
      callUuid: c.call_uuid,
      conferenceUuid: c.conference_uuid ?? null,
      from: c.from_number,
      to: c.to_number,
      direction: c.call_direction === 'inbound' ? ('inbound' as const) : ('outbound' as const),
      callState: c.call_state,
      durationSeconds: Number(c.call_duration || 0),
      startTime: c.initiation_time ?? null,
      endTime: c.end_time ?? null,
      hangupCause: c.hangup_cause_name ?? null,
    }));

  const hasMore = Boolean(data.meta?.next);
  if (!params.number) return { records: all, hasMore };
  const digits = params.number.replace(/\D/g, '');
  return { records: all.filter((c) => c.from.includes(digits) || c.to.includes(digits)), hasMore };
}

export type PlivoCallDetail = PlivoCallRecord & {
  recordUrl: string | null;
  answerTime: string | null;
  ringDurationSeconds: number | null;
  postDialDelaySeconds: number | null;
  hangupCauseCode: number | null;
  hangupSource: string | null;
  stirVerification: string | null;
  sourceIp: string | null;
  totalAmount: string | null;
  totalRate: string | null;
};

/** Full detail for one call, including its recording URL if one exists. Pulls every
 * field Plivo's own console "Call Insights" panel shows that's actually in the REST CDR
 * (network-lookup labels like "Originator"/"Terminated To" are console-only, not in the API). */
export async function getCallDetail(callUuid: string): Promise<PlivoCallDetail> {
  const c = await plivoRequest<{
    call_uuid: string;
    conference_uuid?: string | null;
    from_number: string;
    to_number: string;
    call_direction: string;
    call_state: string;
    call_duration?: number | string;
    initiation_time?: string;
    end_time?: string;
    answer_time?: string | null;
    hangup_cause_name?: string;
    hangup_cause_code?: number | null;
    hangup_source?: string | null;
    ring_duration?: number | string | null;
    post_dial_delay?: number | string | null;
    stir_verification?: string | null;
    source_ip?: string | null;
    total_amount?: string | null;
    total_rate?: string | null;
  }>(`/Call/${encodeURIComponent(callUuid)}/`);

  let recordUrl: string | null = null;
  try {
    const recordings = await plivoRequest<{ objects: { call_uuid: string; recording_url: string }[] }>(
      `/Recording/?call_uuid=${encodeURIComponent(callUuid)}`
    );
    recordUrl = recordings.objects?.[0]?.recording_url ?? null;
  } catch {
    // No recording for this call — fine, leave null.
  }

  return {
    callUuid: c.call_uuid,
    conferenceUuid: c.conference_uuid ?? null,
    from: c.from_number,
    to: c.to_number,
    direction: c.call_direction === 'inbound' ? 'inbound' : 'outbound',
    callState: c.call_state,
    durationSeconds: Number(c.call_duration || 0),
    startTime: c.initiation_time ?? null,
    endTime: c.end_time ?? null,
    hangupCause: c.hangup_cause_name ?? null,
    recordUrl,
    answerTime: c.answer_time ?? null,
    ringDurationSeconds: c.ring_duration != null ? Number(c.ring_duration) : null,
    postDialDelaySeconds: c.post_dial_delay != null ? Number(c.post_dial_delay) : null,
    hangupCauseCode: c.hangup_cause_code ?? null,
    hangupSource: c.hangup_source ?? null,
    stirVerification: c.stir_verification ?? null,
    sourceIp: c.source_ip ?? null,
    totalAmount: c.total_amount ?? null,
    totalRate: c.total_rate ?? null,
  };
}

export type PlivoOutboundCall = { requestUuid: string; message: string };

/** Places a real outbound call — rings `to` and bills the account per minute. */
export async function makeCall(params: {
  from: string;
  to: string;
  answerUrl: string;
  hangupUrl?: string;
}): Promise<PlivoOutboundCall> {
  assertEnabled();
  const data = await plivoRequest<{ request_uuid: string; message: string; api_id: string }>('/Call/', {
    method: 'POST',
    body: JSON.stringify({
      from: params.from,
      to: params.to,
      answer_url: params.answerUrl,
      answer_method: 'GET',
      ...(params.hangupUrl ? { hangup_url: params.hangupUrl, hangup_method: 'GET' } : {}),
    }),
  });
  return { requestUuid: data.request_uuid, message: data.message };
}

/** call_uuids that have a recording — one API call, used to flag list rows cheaply. */
export async function listRecordedCallUuids(limit = 30): Promise<Set<string>> {
  try {
    const data = await plivoRequest<{ objects: { call_uuid: string }[] }>(`/Recording/?limit=${limit}`);
    return new Set((data.objects ?? []).map((r) => r.call_uuid));
  } catch {
    return new Set();
  }
}

export type PlivoVoicePricing = {
  countryIso: string;
  countryName: string;
  outboundRatePerMinUsd: number;
  inboundRatePerMinUsd: number;
};

type PlivoPricingRateEntry = {
  origination_prefix: string[];
  prefix: string[];
  rate: string;
  voice_network_group: string;
  voice_unit: number;
};

/**
 * Real per-minute voice rate for this account (Plivo bills in USD, per `voice_unit`-second
 * increments — usually 30s domestically). Prefers the generic domestic network-group entry
 * from `voice.outbound.rates[]` over the flat `voice.outbound.local.rate`, since the latter
 * reflects a special discounted number series (e.g. Plivo's 140-series), not standard numbers.
 */
export async function getVoicePricing(countryIso: PlivoCountryIso = 'IN'): Promise<PlivoVoicePricing> {
  const data = await plivoRequest<{
    country: string;
    country_iso: string;
    voice: {
      outbound: { local: { rate: string }; tollfree: { rate: string }; rates?: PlivoPricingRateEntry[] };
      inbound: { local: { rate: string }; tollfree: { rate: string } };
    };
  }>(`/Pricing/?country_iso=${countryIso}`);

  const rates = data.voice?.outbound?.rates ?? [];
  const domesticEntry = rates.find(
    (r) => r.origination_prefix?.includes(countryIso === 'IN' ? '91' : '') && r.prefix?.length === 1,
  );

  let outboundRatePerMin: number;
  if (domesticEntry) {
    outboundRatePerMin = (parseFloat(domesticEntry.rate) * 60) / domesticEntry.voice_unit;
  } else {
    outboundRatePerMin = parseFloat(data.voice?.outbound?.local?.rate || '0') * 2;
  }

  return {
    countryIso: data.country_iso,
    countryName: data.country,
    outboundRatePerMinUsd: outboundRatePerMin,
    inboundRatePerMinUsd: parseFloat(data.voice?.inbound?.local?.rate || '0') * 2,
  };
}

/** Permanently releases a number back to Plivo — irreversible, stops the monthly rental. */
export async function releaseNumber(number: string): Promise<void> {
  assertEnabled();
  await plivoRequest<unknown>(`/Number/${encodeURIComponent(number)}/`, { method: 'DELETE' });
}

export type PlivoEndpoint = {
  endpointId: string;
  /** Plivo appends a random suffix to guarantee global uniqueness — always use this, not the one submitted. */
  username: string;
  password: string;
};

/** Creates a SIP/WebRTC identity (an "Endpoint") that a browser (Plivo Browser SDK) logs
 * into so an agent can place/receive calls with real two-way audio. One per workspace.
 * `appId` is the Application whose answer_url runs when the browser places an outbound call. */
export async function createEndpoint(alias: string, appId?: string): Promise<PlivoEndpoint> {
  assertEnabled();
  const username = `cs${Math.random().toString(36).slice(2, 12)}`;
  const password = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
  const data = await plivoRequest<{ endpoint_id: string; username: string }>('/Endpoint/', {
    method: 'POST',
    body: JSON.stringify({ username, password, alias, ...(appId ? { app_id: appId } : {}) }),
  });
  // Plivo's GET /Endpoint/ response includes a `password` field, but it is NOT the
  // real SIP auth secret (verified live: a digest computed against it was rejected
  // with a fresh 401) — it appears to be a hash or otherwise-opaque display value.
  // The password we submit at creation is the one actually used for SIP auth, even
  // though it isn't echoed back in the create response — keep using it as-is.
  return { endpointId: data.endpoint_id, username: data.username, password };
}

export async function deleteEndpoint(endpointId: string): Promise<void> {
  assertEnabled();
  await plivoRequest<unknown>(`/Endpoint/${encodeURIComponent(endpointId)}/`, { method: 'DELETE' });
}

/** Creates a Plivo Application holding the answer/hangup webhook URLs used to route
 * inbound calls (to a browser Endpoint) for a number. Plivo validates these URLs are
 * live and reachable at creation time, so the routes must already be deployed. */
export async function createApplication(params: {
  alias: string;
  answerUrl: string;
  hangupUrl: string;
}): Promise<{ appId: string }> {
  assertEnabled();
  const data = await plivoRequest<{ app_id: string }>('/Application/', {
    method: 'POST',
    body: JSON.stringify({
      app_name: params.alias,
      answer_url: params.answerUrl,
      answer_method: 'POST',
      hangup_url: params.hangupUrl,
      hangup_method: 'POST',
    }),
  });
  return { appId: data.app_id };
}

export async function deleteApplication(appId: string): Promise<void> {
  assertEnabled();
  await plivoRequest<unknown>(`/Application/${encodeURIComponent(appId)}/`, { method: 'DELETE' });
}

/** Repoints an existing Application's webhook URLs — needed whenever BACKEND_PUBLIC_URL
 * changes (e.g. a new ngrok tunnel), since the URLs are otherwise fixed at creation time. */
export async function updateApplication(
  appId: string,
  params: { answerUrl: string; hangupUrl: string }
): Promise<void> {
  assertEnabled();
  await plivoRequest<unknown>(`/Application/${encodeURIComponent(appId)}/`, {
    method: 'POST',
    body: JSON.stringify({
      answer_url: params.answerUrl,
      answer_method: 'POST',
      hangup_url: params.hangupUrl,
      hangup_method: 'POST',
    }),
  });
}

/** Links a number to an Application so inbound calls to it use that Application's answer_url. */
export async function setNumberApplication(number: string, appId: string): Promise<void> {
  assertEnabled();
  await plivoRequest<unknown>(`/Number/${encodeURIComponent(number)}/`, {
    method: 'POST',
    body: JSON.stringify({ app_id: appId }),
  });
}

/** Links an Endpoint to an Application so Browser SDK outbound calls fetch that
 * Application's answer_url (required — without it Plivo has no XML and the SDK reports Busy). */
export async function setEndpointApplication(endpointId: string, appId: string): Promise<void> {
  assertEnabled();
  await plivoRequest<unknown>(`/Endpoint/${encodeURIComponent(endpointId)}/`, {
    method: 'POST',
    body: JSON.stringify({ app_id: appId }),
  });
}
