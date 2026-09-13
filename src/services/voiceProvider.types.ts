/**
 * Provider-agnostic shapes shared by plivo.service.ts and telnyx.service.ts.
 * Both files export an object matching `VoiceProvider` (`plivoProvider` /
 * `telnyxProvider`) so routes/virtualNumber.ts can dispatch on
 * `row.provider` without caring which carrier is underneath.
 */

export type AvailableNumber = {
  number: string;
  /** E.164-ish display, e.g. "+91 22 6423 1648". */
  displayNumber: string;
  type: string;
  country: string;
  city: string | null;
  region: string | null;
  monthlyRentalPaise: number;
};

export type BoughtNumber = {
  providerNumberId: string;
  number: string;
};

export type NumberSearchResult = {
  numbers: AvailableNumber[];
  totalCount: number;
  offset: number;
  hasMore: boolean;
};

export type OwnedNumber = {
  number: string;
  alias: string | null;
  region: string | null;
  type: string;
};

export type CallRecord = {
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

export type CallDetail = CallRecord & {
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

export type OutboundCall = { requestUuid: string; message: string };

export type VoicePricing = {
  countryIso: string;
  countryName: string;
  outboundRatePerMinUsd: number;
  inboundRatePerMinUsd: number;
};

export type ProviderEndpoint = {
  endpointId: string;
  username: string;
  password: string;
};

/** Country ISO codes offered in the number picker across both providers. */
export type SupportedCountryIso = 'IN' | 'US' | 'GB' | 'SG';

export interface VoiceProvider {
  searchAvailableNumbers(params: {
    countryIso?: SupportedCountryIso;
    pattern?: string;
    limit?: number;
    offset?: number;
  }): Promise<NumberSearchResult>;

  buyNumber(number: string, alias?: string): Promise<BoughtNumber>;

  formatDisplayNumber(raw: string, countryIso?: SupportedCountryIso): string;

  listOwnedNumbers(): Promise<OwnedNumber[]>;

  listCalls(params: { number?: string; limit?: number; offset?: number }): Promise<{
    records: CallRecord[];
    hasMore: boolean;
  }>;

  getCallDetail(callUuid: string): Promise<CallDetail>;

  makeCall(params: {
    from: string;
    to: string;
    answerUrl: string;
    hangupUrl?: string;
  }): Promise<OutboundCall>;

  listRecordedCallUuids(limit?: number): Promise<Set<string>>;

  getVoicePricing(countryIso?: SupportedCountryIso): Promise<VoicePricing>;

  releaseNumber(number: string): Promise<void>;

  createEndpoint(alias: string, appId?: string): Promise<ProviderEndpoint>;

  deleteEndpoint(endpointId: string): Promise<void>;

  createApplication(params: { alias: string; answerUrl: string; hangupUrl: string }): Promise<{
    appId: string;
  }>;

  deleteApplication(appId: string): Promise<void>;

  updateApplication(appId: string, params: { answerUrl: string; hangupUrl: string }): Promise<void>;

  setNumberApplication(number: string, appId: string): Promise<void>;

  setEndpointApplication(endpointId: string, appId: string): Promise<void>;
}
