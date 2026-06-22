import type { GoogleConnectionStatus, GoogleProductKey, GoogleProductStatus } from '@prisma/client';

export type GoogleTokenPayload = {
  accessToken: string;
  refreshToken: string;
};

export type GoogleAccountDetails = {
  id: string;
  email: string;
  googleAccountId: string;
  displayName?: string | null;
  pictureUrl?: string | null;
  scopes: string[];
  status: GoogleConnectionStatus;
  expiresAt: string | null;
  createdAt: string;
};

export type GoogleProductSummary = {
  product: GoogleProductKey;
  label: string;
  description: string;
  status: GoogleProductStatus;
  connectionId: string | null;
  connectionEmail: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  syncCount: number;
  config: Record<string, unknown> | null;
};

export type GoogleOAuthStatePayload = {
  userId: string;
  workspaceId: string;
  purpose: 'google_oauth';
  scopes: string[];
};

export type GoogleSyncLogEntry = {
  id: string;
  product: GoogleProductKey;
  action: string;
  status: string;
  message: string | null;
  createdAt: string;
};
