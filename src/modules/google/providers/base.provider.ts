import { google } from 'googleapis';
import type { GoogleProductKey } from '@prisma/client';
import type { GoogleService } from '../services/google.service.js';
import { GOOGLE_PRODUCT_SCOPES, missingScopes } from '../constants/scopes.js';

export type GoogleAuthClient = InstanceType<typeof google.auth.OAuth2>;

export type GoogleProviderContext = {
  workspaceId: string;
  connectionId: string;
  auth: GoogleAuthClient;
};

export abstract class BaseGoogleProvider {
  abstract readonly product: GoogleProductKey;

  constructor(protected readonly googleService: GoogleService) {}

  get requiredScopes(): string[] {
    return [...GOOGLE_PRODUCT_SCOPES[this.product]];
  }

  async validatePermissions(connectionId: string, workspaceId: string): Promise<string[]> {
    const details = await this.googleService.getAccountDetails(connectionId, workspaceId);
    return missingScopes(details.scopes, this.requiredScopes);
  }

  async context(connectionId: string, workspaceId: string): Promise<GoogleProviderContext> {
    const auth = await this.googleService.getAuthenticatedClient(connectionId, workspaceId);
    return { workspaceId, connectionId, auth };
  }

  /** Enable product integration for a connection. */
  abstract connect(ctx: GoogleProviderContext): Promise<Record<string, unknown>>;

  /** Disable product — default no-op beyond status change in service layer. */
  async disconnect(_ctx: GoogleProviderContext): Promise<void> {}

  /** Optional sync hook for product data. */
  async sync(ctx: GoogleProviderContext): Promise<Record<string, unknown>> {
    return this.connect(ctx);
  }
}
