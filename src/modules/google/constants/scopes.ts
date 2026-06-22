import type { GoogleProductKey } from '@prisma/client';

/** Base scopes for account identity on every Google connect. */
export const GOOGLE_BASE_SCOPES = [
  'openid',
  'email',
  'profile',
] as const;

/** Per-product OAuth scopes — extend when enabling a product. */
export const GOOGLE_PRODUCT_SCOPES: Record<GoogleProductKey, readonly string[]> = {
  calendar: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ],
  business_profile: ['https://www.googleapis.com/auth/business.manage'],
  sheets: ['https://www.googleapis.com/auth/spreadsheets'],
  drive: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
  gmail: [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  meet: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ],
};

export function scopesForProducts(products: GoogleProductKey[]): string[] {
  const set = new Set<string>(GOOGLE_BASE_SCOPES);
  for (const product of products) {
    for (const scope of GOOGLE_PRODUCT_SCOPES[product]) {
      set.add(scope);
    }
  }
  return Array.from(set);
}

export function scopesForAllProducts(): string[] {
  return scopesForProducts([
    'calendar',
    'business_profile',
    'sheets',
    'drive',
    'gmail',
    'meet',
  ]);
}

export function missingScopes(granted: string[], required: string[]): string[] {
  const grantedSet = new Set(granted);
  return required.filter((s) => !grantedSet.has(s));
}
