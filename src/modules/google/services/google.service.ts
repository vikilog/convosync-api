import type { GoogleProductKey } from '@prisma/client';
import type { GoogleAuthClient } from '../providers/base.provider.js';
import {
  createOAuth2Client,
  refreshGoogleTokens,
} from '../lib/google-oauth.client.js';
import { googleConnectionRepository } from '../repositories/google-connection.repository.js';
import { googleProductRepository } from '../repositories/google-product.repository.js';
import { googleSyncLogRepository } from '../repositories/google-sync-log.repository.js';
import { GOOGLE_PRODUCT_BY_KEY } from '../constants/products.js';
import { missingScopes, GOOGLE_PRODUCT_SCOPES } from '../constants/scopes.js';
import type { GoogleAccountDetails, GoogleProductSummary } from '../types/google.types.js';
import type { BaseGoogleProvider } from '../providers/base.provider.js';
import { GoogleProviderRegistry } from '../providers/google-provider.registry.js';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Generic Google integration service — single entry point for all Google products.
 * Handles OAuth tokens, permissions, and provider dispatch.
 */
export class GoogleService {
  private readonly registry = new GoogleProviderRegistry(this);

  getProvider(product: GoogleProductKey): BaseGoogleProvider {
    return this.registry.get(product);
  }

  async getAuthenticatedClient(connectionId: string, workspaceId: string): Promise<GoogleAuthClient> {
    const row = await googleConnectionRepository.findById(workspaceId, connectionId);
    if (!row) throw new Error('Google connection not found');
    if (row.status === 'revoked') throw new Error('Google connection was disconnected');

    let tokens = googleConnectionRepository.getTokens(row);
    const needsRefresh =
      !row.expiresAt || row.expiresAt.getTime() - Date.now() < TOKEN_REFRESH_BUFFER_MS;

    if (needsRefresh) {
      tokens = await this.refreshTokens(connectionId, workspaceId);
    }

    return createOAuth2Client(tokens);
  }

  async refreshTokens(
    connectionId: string,
    workspaceId: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const row = await googleConnectionRepository.findById(workspaceId, connectionId);
    if (!row) throw new Error('Google connection not found');

    const current = googleConnectionRepository.getTokens(row);
    try {
      const refreshed = await refreshGoogleTokens(current.refreshToken);
      await googleConnectionRepository.updateTokens(
        row.id,
        {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
        },
        refreshed.expiresAt,
        refreshed.scopes
      );
      return {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
      };
    } catch (err) {
      await googleConnectionRepository.updateStatus(row.id, 'expired');
      throw err instanceof Error ? err : new Error('Token refresh failed');
    }
  }

  async disconnectAccount(connectionId: string, workspaceId: string): Promise<void> {
    const row = await googleConnectionRepository.findById(workspaceId, connectionId);
    if (!row) throw new Error('Google connection not found');

    await googleProductRepository.deleteByConnection(connectionId);
    await googleConnectionRepository.updateStatus(connectionId, 'revoked');
    await googleConnectionRepository.deleteConnection(workspaceId, connectionId);
  }

  async validatePermissions(
    connectionId: string,
    workspaceId: string,
    product: GoogleProductKey
  ): Promise<{ ok: boolean; missing: string[] }> {
    const details = await this.getAccountDetails(connectionId, workspaceId);
    const required = GOOGLE_PRODUCT_SCOPES[product];
    const missing = missingScopes(details.scopes, [...required]);
    return { ok: missing.length === 0, missing };
  }

  async getAccountDetails(
    connectionId: string,
    workspaceId: string
  ): Promise<GoogleAccountDetails> {
    const row = await googleConnectionRepository.findById(workspaceId, connectionId);
    if (!row) throw new Error('Google connection not found');
    return {
      id: row.id,
      email: row.email,
      googleAccountId: row.googleAccountId,
      displayName: row.displayName,
      pictureUrl: row.pictureUrl,
      scopes: row.scopes,
      status: row.status,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listConnections(workspaceId: string): Promise<GoogleAccountDetails[]> {
    const rows = await googleConnectionRepository.listByWorkspace(workspaceId);
    return rows
      .filter((r) => r.status !== 'revoked')
      .map((row) => ({
        id: row.id,
        email: row.email,
        googleAccountId: row.googleAccountId,
        displayName: row.displayName,
        pictureUrl: row.pictureUrl,
        scopes: row.scopes,
        status: row.status,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }));
  }

  async listProductSummaries(workspaceId: string): Promise<GoogleProductSummary[]> {
    const [integrations, connections] = await Promise.all([
      googleProductRepository.listByWorkspace(workspaceId),
      googleConnectionRepository.listByWorkspace(workspaceId),
    ]);
    const byProduct = new Map(integrations.map((i) => [i.product, i]));
    const connectionEmails = new Map(connections.map((c) => [c.id, c.email]));

    return (Object.keys(GOOGLE_PRODUCT_BY_KEY) as GoogleProductKey[]).map((product) => {
      const def = GOOGLE_PRODUCT_BY_KEY[product];
      const row = byProduct.get(product);
      return {
        product,
        label: def.label,
        description: def.description,
        status: row?.status ?? 'disconnected',
        connectionId: row?.connectionId ?? null,
        connectionEmail: row?.connectionId ? connectionEmails.get(row.connectionId) ?? null : null,
        lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
        lastError: row?.lastError ?? null,
        syncCount: row?.syncCount ?? 0,
        config: (row?.config as Record<string, unknown> | null) ?? null,
      };
    });
  }

  async connectProduct(
    workspaceId: string,
    connectionId: string,
    product: GoogleProductKey
  ): Promise<GoogleProductSummary> {
    const row = await googleConnectionRepository.findById(workspaceId, connectionId);
    if (!row) throw new Error('Google connection not found');

    const permission = await this.validatePermissions(connectionId, workspaceId, product);
    if (!permission.ok) {
      throw new Error(
        `Missing Google permissions for ${product}: ${permission.missing.join(', ')}. Reconnect with required scopes.`
      );
    }

    const provider = this.getProvider(product);
    const ctx = await provider.context(connectionId, workspaceId);

    try {
      const config = await provider.connect(ctx);
      const integration = await googleProductRepository.upsertProduct({
        workspaceId,
        connectionId,
        product,
        status: 'connected',
        config,
      });
      await googleProductRepository.markSynced(integration.id);
      await googleSyncLogRepository.create({
        workspaceId,
        connectionId,
        product,
        action: 'connect',
        status: 'success',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connect failed';
      await googleSyncLogRepository.create({
        workspaceId,
        connectionId,
        product,
        action: 'connect',
        status: 'error',
        message,
      });
      throw err;
    }

    const summaries = await this.listProductSummaries(workspaceId);
    const summary = summaries.find((s) => s.product === product);
    if (!summary) throw new Error('Product summary not found');
    return summary;
  }

  async disconnectProduct(
    workspaceId: string,
    connectionId: string,
    product: GoogleProductKey
  ): Promise<void> {
    const provider = this.getProvider(product);
    const ctx = await provider.context(connectionId, workspaceId);
    await provider.disconnect(ctx);
    await googleProductRepository.disconnectProduct(connectionId, product);
    await googleSyncLogRepository.create({
      workspaceId,
      connectionId,
      product,
      action: 'disconnect',
      status: 'success',
    });
  }

  async syncProduct(
    workspaceId: string,
    connectionId: string,
    product: GoogleProductKey
  ): Promise<GoogleProductSummary> {
    const integration = await googleProductRepository.findByConnectionAndProduct(
      connectionId,
      product
    );
    if (!integration || integration.status !== 'connected') {
      throw new Error('Product is not connected');
    }

    const provider = this.getProvider(product);
    const ctx = await provider.context(connectionId, workspaceId);

    try {
      const config = await provider.sync(ctx);
      if (Object.keys(config).length > 0) {
        await googleProductRepository.updateConfig(integration.id, {
          ...(integration.config as Record<string, unknown>),
          ...config,
        });
      }
      await googleProductRepository.markSynced(integration.id);
      await googleSyncLogRepository.create({
        workspaceId,
        connectionId,
        product,
        action: 'sync',
        status: 'success',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      await googleProductRepository.markError(integration.id, message);
      await googleSyncLogRepository.create({
        workspaceId,
        connectionId,
        product,
        action: 'sync',
        status: 'error',
        message,
      });
      throw err;
    }

    const summaries = await this.listProductSummaries(workspaceId);
    const summary = summaries.find((s) => s.product === product);
    if (!summary) throw new Error('Product summary not found');
    return summary;
  }
}

export const googleService = new GoogleService();
