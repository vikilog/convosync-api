import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';
import type {
  AvailableNumber,
  BoughtNumber,
  CallDetail,
  CallRecord,
  NumberSearchResult,
  OutboundCall,
  OwnedNumber,
  ProviderEndpoint,
  SupportedCountryIso,
  VoiceProvider,
  VoicePricing,
} from './voiceProvider.types.js';

/**
 * Thin wrapper over Telnyx's REST API (Bearer token over HTTPS — no SDK needed),
 * mirroring plivo.service.ts's shape so routes/virtualNumber.ts can dispatch between
 * the two by provider name alone. https://developers.telnyx.com/docs/api/v2/overview
 *
 * IMPORTANT — verification status: written against Telnyx's public API docs without a
 * live account to test against (this workspace has no TELNYX_API_KEY configured yet).
 * `searchAvailableNumbers`, `buyNumber`, `listOwnedNumbers`, and `releaseNumber` follow
 * Telnyx's documented Numbers API closely and should work as-is. `listCalls` /
 * `getCallDetail` (Detail Record Search — a beta API) and `makeCall` / `createEndpoint` /
 * `createApplication` (TeXML Application + Credential Connection field names) are
 * best-effort from docs and MUST be smoke-tested against a real Telnyx sandbox account
 * before the first real Telnyx-routed number goes live — see the plan's verification
 * section. `getVoicePricing` has no confirmed field-accurate response shape at all
 * (Telnyx doesn't publish per-country rates statically) and returns a documented
 * best-guess fallback until verified.
 */

export type TelnyxCountryIso = 'US' | 'GB' | 'SG';

function assertEnabled() {
  if (!config.telnyx.enabled) {
    throw new Error('Telnyx is not configured. Set TELNYX_API_KEY.');
  }
}

function authHeader() {
  return `Bearer ${config.telnyx.apiKey}`;
}

const BASE_URL = 'https://api.telnyx.com/v2';

async function telnyxRequest<T>(path: string, init?: RequestInit): Promise<T> {
  assertEnabled();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      (body as { errors?: { detail?: string; title?: string }[] } | null)?.errors?.[0]?.detail ||
      (body as { errors?: { detail?: string; title?: string }[] } | null)?.errors?.[0]?.title ||
      `Telnyx request failed (${res.status} ${res.statusText})`;
    throw new Error(message);
  }
  return body as T;
}

type TelnyxAvailableNumberObject = {
  phone_number: string;
  region_information?: { region_name?: string; rate_center?: string }[];
  cost_information?: { monthly_cost?: string };
  phone_number_type?: string;
};

export function formatDisplayNumber(raw: string, countryIso: SupportedCountryIso = 'US'): string {
  const digits = raw.replace(/\D/g, '');
  if (countryIso === 'SG' && digits.startsWith('65') && digits.length === 10) {
    return `+65 ${digits.slice(2, 6)} ${digits.slice(6)}`;
  }
  if (countryIso === 'GB' && digits.startsWith('44')) {
    return `+44 ${digits.slice(2)}`;
  }
  if (countryIso === 'US' && digits.startsWith('1') && digits.length === 11) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return `+${digits}`;
}

export async function searchAvailableNumbers(params: {
  countryIso?: TelnyxCountryIso;
  pattern?: string;
  limit?: number;
  offset?: number;
}): Promise<NumberSearchResult> {
  const limit = params.limit ?? 9;
  const countryIso = params.countryIso ?? 'US';
  const query = new URLSearchParams({
    'filter[country_code]': countryIso,
    'filter[phone_number_type]': 'local',
    'filter[limit]': String(limit),
  });
  if (params.pattern) query.set('filter[phone_number][starts_with]', `+${params.pattern}`);

  const data = await telnyxRequest<{ data: TelnyxAvailableNumberObject[]; meta?: { total_results?: number } }>(
    `/available_phone_numbers?${query.toString()}`,
  );

  const numbers: AvailableNumber[] = (data.data ?? []).map((o) => ({
    number: o.phone_number.replace(/\D/g, ''),
    displayNumber: formatDisplayNumber(o.phone_number, countryIso),
    type: o.phone_number_type ?? 'local',
    country: countryIso,
    city: o.region_information?.[0]?.rate_center ?? null,
    region: o.region_information?.[0]?.region_name ?? null,
    // Telnyx cost_information is USD, informational only here (see priceForType in
    // routes/virtualNumber.ts — the app charges its own flat INR price regardless).
    monthlyRentalPaise: Math.round(parseFloat(o.cost_information?.monthly_cost || '0') * 100),
  }));

  return {
    numbers,
    totalCount: data.meta?.total_results ?? numbers.length,
    offset: params.offset ?? 0,
    hasMore: numbers.length === limit,
  };
}

export async function buyNumber(number: string, _alias?: string): Promise<BoughtNumber> {
  assertEnabled();
  const e164 = number.startsWith('+') ? number : `+${number.replace(/\D/g, '')}`;
  const data = await telnyxRequest<{
    data: { id: string; phone_numbers: { phone_number: string; status: string }[] };
  }>('/number_orders', {
    method: 'POST',
    body: JSON.stringify({ phone_numbers: [{ phone_number: e164 }] }),
  });
  const bought = data.data?.phone_numbers?.[0];
  if (!bought) throw new Error(`Telnyx did not confirm purchase of ${number}.`);
  return { providerNumberId: data.data.id, number: bought.phone_number.replace(/\D/g, '') };
}

export async function listOwnedNumbers(): Promise<OwnedNumber[]> {
  const data = await telnyxRequest<{
    data: { phone_number: string; connection_name?: string; phone_number_type?: string }[];
  }>('/phone_numbers?page[size]=50');
  return (data.data ?? []).map((o) => ({
    number: o.phone_number.replace(/\D/g, ''),
    alias: o.connection_name ?? null,
    region: null,
    type: o.phone_number_type ?? 'local',
  }));
}

/** Telnyx addresses numbers by their internal id for most write operations —
 * looked up by the E.164 number since that's what the rest of this app stores. */
async function findOwnedNumberId(number: string): Promise<string> {
  const e164 = number.startsWith('+') ? number : `+${number.replace(/\D/g, '')}`;
  const data = await telnyxRequest<{ data: { id: string; phone_number: string }[] }>(
    `/phone_numbers?filter[phone_number]=${encodeURIComponent(e164)}`,
  );
  const found = data.data?.[0];
  if (!found) throw new Error(`Telnyx has no record of number ${number}.`);
  return found.id;
}

export async function releaseNumber(number: string): Promise<void> {
  const id = await findOwnedNumberId(number);
  await telnyxRequest<unknown>(`/phone_numbers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Telnyx's Detail Record Search API has been observed live to 500 persistently for this
 * account, on every record_type tried, independent of this app's code — so the call log
 * is instead built from real-time Call Control webhooks into TelnyxCallLog (see
 * virtualNumberWebhooks.telnyx.ts's `/telnyx/call-events` handler) rather than querying
 * that API. Every call site in this app always passes `number` (the workspace's own
 * selected number), so filtering by it is enough to scope results without also needing
 * a workspaceId param on this shared VoiceProvider interface method. */
export async function listCalls(params: {
  number?: string;
  limit?: number;
  offset?: number;
}): Promise<{ records: CallRecord[]; hasMore: boolean }> {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const digits = params.number?.replace(/\D/g, '') ?? '';
  const where = digits ? { OR: [{ fromNumber: { contains: digits } }, { toNumber: { contains: digits } }] } : {};

  const [rows, total] = await Promise.all([
    prisma.telnyxCallLog.findMany({ where, orderBy: { startTime: 'desc' }, skip: offset, take: limit }),
    prisma.telnyxCallLog.count({ where }),
  ]);

  return { records: rows.map(toCallRecordFromLog), hasMore: offset + rows.length < total };
}

function toCallRecordFromLog(row: {
  callUuid: string;
  fromNumber: string;
  toNumber: string;
  direction: string;
  callState: string;
  durationSeconds: number;
  startTime: Date | null;
  endTime: Date | null;
  hangupCause: string | null;
}): CallRecord {
  return {
    callUuid: row.callUuid,
    conferenceUuid: null,
    from: row.fromNumber,
    to: row.toNumber,
    direction: row.direction === 'inbound' ? 'inbound' : 'outbound',
    callState: row.callState,
    durationSeconds: row.durationSeconds,
    startTime: row.startTime?.toISOString() ?? null,
    endTime: row.endTime?.toISOString() ?? null,
    hangupCause: row.hangupCause,
  };
}

/** Looked up live rather than trusting TelnyxCallLog.recordUrl (fed by the
 * call.recording.saved webhook) — confirmed live that the recording exists and this
 * endpoint returns it correctly well before that webhook field ever got populated, so
 * this is the more reliable of the two paths today. */
async function findRecordingUrl(callUuid: string): Promise<string | null> {
  try {
    const data = await telnyxRequest<{ data: { call_leg_id: string; download_urls?: Record<string, string> }[] }>(
      `/recordings?filter[call_leg_id]=${encodeURIComponent(callUuid)}`,
    );
    const urls = data.data?.[0]?.download_urls;
    return urls?.mp3 ?? urls?.wav ?? Object.values(urls ?? {})[0] ?? null;
  } catch {
    return null;
  }
}

export async function getCallDetail(callUuid: string): Promise<CallDetail> {
  const row = await prisma.telnyxCallLog.findUnique({ where: { callUuid } });
  if (!row) throw new Error('Call not found.');
  const recordUrl = row.recordUrl ?? (await findRecordingUrl(callUuid));
  return {
    ...toCallRecordFromLog(row),
    recordUrl,
    answerTime: null,
    ringDurationSeconds: null,
    postDialDelaySeconds: null,
    hangupCauseCode: null,
    hangupSource: null,
    stirVerification: null,
    sourceIp: null,
    totalAmount: null,
    totalRate: null,
  };
}

/** TeXML Applications place outbound calls through a distinct, Twilio-compatible,
 * form-encoded endpoint — not the JSON Call Control `/calls` API (that one requires a
 * Call Control App connection_id, and rejects a TeXML Application id with "invalid
 * connection_id", confirmed live against this account). Response is Twilio-shaped
 * (`sid`/`status`), not the `{data: {...}}` JSON:API envelope the rest of this file uses. */
export async function makeCall(params: {
  from: string;
  to: string;
  answerUrl: string;
  hangupUrl?: string;
}): Promise<OutboundCall> {
  assertEnabled();
  if (!config.telnyx.connectionId) {
    throw new Error('Telnyx is not fully configured. Set TELNYX_CONNECTION_ID (the TeXML Application id).');
  }
  const form = new URLSearchParams({
    To: params.to.startsWith('+') ? params.to : `+${params.to}`,
    From: params.from.startsWith('+') ? params.from : `+${params.from}`,
    Url: params.answerUrl,
    ...(params.hangupUrl ? { StatusCallback: params.hangupUrl } : {}),
  });
  const data = await telnyxRequest<{ sid?: string; call_sid?: string; status?: string }>(
    `/texml/calls/${encodeURIComponent(config.telnyx.connectionId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    },
  );
  return { requestUuid: data.sid ?? data.call_sid ?? '', message: data.status ?? 'queued' };
}

export async function listRecordedCallUuids(limit = 30): Promise<Set<string>> {
  try {
    const data = await telnyxRequest<{ data: { call_leg_id: string }[] }>(`/recordings?page[size]=${limit}`);
    return new Set((data.data ?? []).map((r) => r.call_leg_id));
  } catch {
    return new Set();
  }
}

/** No confirmed static Telnyx per-country rate is publicly documented (account/volume
 * gated) — returns a conservative placeholder until verified against a live account's
 * /pricing response. Mirrors plivoVoicePricing.ts's fallback shape so the /:id/pricing
 * route doesn't need a provider-specific branch for the "no live rate" case. */
export async function getVoicePricing(countryIso: TelnyxCountryIso = 'US'): Promise<VoicePricing> {
  try {
    const data = await telnyxRequest<{
      data: { country_code: string; voice?: { outbound?: { rate?: string }; inbound?: { rate?: string } } };
    }>(`/pricing?filter[country_code]=${countryIso}`);
    const countryNames: Record<TelnyxCountryIso, string> = { US: 'United States', GB: 'United Kingdom', SG: 'Singapore' };
    return {
      countryIso: data.data.country_code ?? countryIso,
      countryName: countryNames[countryIso],
      outboundRatePerMinUsd: parseFloat(data.data.voice?.outbound?.rate || '0') || 0.007,
      inboundRatePerMinUsd: parseFloat(data.data.voice?.inbound?.rate || '0') || 0.0035,
    };
  } catch {
    const countryNames: Record<TelnyxCountryIso, string> = { US: 'United States', GB: 'United Kingdom', SG: 'Singapore' };
    // US outbound ($0.007/min) reconfirmed live against telnyx.com/pricing/voice-api
    // on 2026-09-16 — matches this fallback exactly. Inbound, and both GB/SG rates,
    // are NOT published on that page (Telnyx gates non-US SIP trunking rates behind a
    // downloadable price sheet) — those three numbers are still an unverified estimate.
    return { countryIso, countryName: countryNames[countryIso], outboundRatePerMinUsd: 0.007, inboundRatePerMinUsd: 0.0035 };
  }
}

export async function createEndpoint(alias: string, _appId?: string): Promise<ProviderEndpoint> {
  assertEnabled();
  const username = `cs${Math.random().toString(36).slice(2, 12)}`;
  const password = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase();
  const data = await telnyxRequest<{ data: { id: string } }>('/credential_connections', {
    method: 'POST',
    body: JSON.stringify({
      connection_name: alias,
      user_name: username,
      password,
      webrtc: { enabled: true },
    }),
  });
  return { endpointId: data.data.id, username, password };
}

export async function deleteEndpoint(endpointId: string): Promise<void> {
  assertEnabled();
  await telnyxRequest<unknown>(`/credential_connections/${encodeURIComponent(endpointId)}`, { method: 'DELETE' });
}

/** Creates a TeXML Application holding the answer/hangup webhook URLs — Telnyx's
 * equivalent of a Plivo Application. Field names confirmed live against a real account.
 * Without an outbound_voice_profile_id, Telnyx rejects every outbound call this
 * Application tries to place ("Connection has no Outbound Profile assigned") — confirmed
 * live — so TELNYX_OUTBOUND_VOICE_PROFILE_ID must be set for calling to actually work. */
export async function createApplication(params: {
  alias: string;
  answerUrl: string;
  hangupUrl: string;
}): Promise<{ appId: string }> {
  assertEnabled();
  const data = await telnyxRequest<{ data: { id: string } }>('/texml_applications', {
    method: 'POST',
    body: JSON.stringify({
      friendly_name: params.alias,
      voice_url: params.answerUrl,
      voice_method: 'POST',
      status_callback: params.hangupUrl,
      status_callback_method: 'POST',
      active: true,
      ...(config.telnyx.outboundVoiceProfileId
        ? { outbound: { outbound_voice_profile_id: config.telnyx.outboundVoiceProfileId } }
        : {}),
    }),
  });
  return { appId: data.data.id };
}

export async function deleteApplication(appId: string): Promise<void> {
  assertEnabled();
  await telnyxRequest<unknown>(`/texml_applications/${encodeURIComponent(appId)}`, { method: 'DELETE' });
}

export async function updateApplication(
  appId: string,
  params: { answerUrl: string; hangupUrl: string },
): Promise<void> {
  assertEnabled();
  await telnyxRequest<unknown>(`/texml_applications/${encodeURIComponent(appId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      voice_url: params.answerUrl,
      voice_method: 'POST',
      status_callback: params.hangupUrl,
      status_callback_method: 'POST',
    }),
  });
}

export async function setNumberApplication(number: string, appId: string): Promise<void> {
  const id = await findOwnedNumberId(number);
  await telnyxRequest<unknown>(`/phone_numbers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ connection_id: appId }),
  });
}

/** `appId` (kept for VoiceProvider interface parity with Plivo, where it really is an
 * Application id) is unused here — a Credential Connection's outbound calls need an
 * Outbound Voice Profile assigned the same way a TeXML Application does (see
 * createApplication above), not a link to the Application itself.
 *
 * `countryIso` sets the connection's outbound `localization` — without it Telnyx falls
 * back to US dialing-plan rules for any number dialed without a leading "+" (confirmed
 * live: an SG workspace's agent dialing a bare local number got it silently reinterpreted
 * as NANP and prefixed with "1", producing a dead +1 destination and a failed call). */
export async function setEndpointApplication(
  endpointId: string,
  _appId: string,
  countryIso?: TelnyxCountryIso,
): Promise<void> {
  assertEnabled();
  await telnyxRequest<unknown>(`/credential_connections/${encodeURIComponent(endpointId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      webrtc: { enabled: true },
      // Real-time call lifecycle events (call.initiated/hangup/recording.saved) feed
      // TelnyxCallLog — see /telnyx/call-events — since Telnyx's Detail Record Search
      // API can't be relied on to list these calls (confirmed live, persistent 500s).
      webhook_event_url: `${config.backendPublicUrl}/api/virtual-number/telnyx/call-events`,
      ...(config.telnyx.outboundVoiceProfileId || countryIso
        ? {
            outbound: {
              ...(config.telnyx.outboundVoiceProfileId
                ? { outbound_voice_profile_id: config.telnyx.outboundVoiceProfileId }
                : {}),
              ...(countryIso ? { localization: countryIso } : {}),
            },
          }
        : {}),
    }),
  });
}

/** Without this, a browser (Credential Connection) call's caller ID is left unset — confirmed
 * live to get the call rejected outright by the destination carrier before it even rings.
 * Fetches the connection's current `outbound` block first and merges rather than blindly
 * PATCHing just ani_override, since a bare `{outbound: {...}}` PATCH looked like it could
 * clobber sibling outbound fields (e.g. outbound_voice_profile_id) set by setEndpointApplication. */
export async function setEndpointCallerId(endpointId: string, callerId: string): Promise<void> {
  assertEnabled();
  const e164 = callerId.startsWith('+') ? callerId : `+${callerId.replace(/\D/g, '')}`;
  const current = await telnyxRequest<{ data: { outbound?: Record<string, unknown> } }>(
    `/credential_connections/${encodeURIComponent(endpointId)}`,
  );
  await telnyxRequest<unknown>(`/credential_connections/${encodeURIComponent(endpointId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      outbound: { ...current.data.outbound, ani_override: e164, ani_override_type: 'always' },
    }),
  });
}

/** Adapter onto the shared VoiceProvider shape (see voiceProvider.types.ts). */
export const telnyxProvider: VoiceProvider = {
  searchAvailableNumbers: (params) =>
    searchAvailableNumbers({ ...params, countryIso: params.countryIso as TelnyxCountryIso | undefined }),
  buyNumber,
  formatDisplayNumber,
  listOwnedNumbers,
  listCalls,
  getCallDetail,
  makeCall,
  listRecordedCallUuids,
  getVoicePricing: (countryIso) => getVoicePricing(countryIso as TelnyxCountryIso | undefined),
  releaseNumber,
  createEndpoint,
  deleteEndpoint,
  createApplication,
  deleteApplication,
  updateApplication,
  setNumberApplication,
  setEndpointApplication,
};
