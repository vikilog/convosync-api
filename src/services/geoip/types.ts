export type GeoIpResult = {
  countryCode: string | null;
  /** Best-effort single IANA zone from the provider response. */
  timeZone: string | null;
};

export type GeoIpProvider = {
  readonly id: string;
  lookup(ip: string, signal?: AbortSignal): Promise<GeoIpResult>;
};
