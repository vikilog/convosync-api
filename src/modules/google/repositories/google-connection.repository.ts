import type { GoogleConnection, GoogleConnectionStatus, Prisma } from '@prisma/client';
import { prisma } from '../../../index.js';
import { decryptJson, encryptJson } from '../../../lib/field-encryption.js';
import type { GoogleTokenPayload } from '../types/google.types.js';

export type GoogleConnectionRow = GoogleConnection;

function tokensFromRow(row: GoogleConnection): GoogleTokenPayload {
  const payload = decryptJson<GoogleTokenPayload>(row.encryptedTokens);
  if (!payload.accessToken || !payload.refreshToken) {
    throw new Error('Google connection tokens are missing or corrupt');
  }
  return payload;
}

export const googleConnectionRepository = {
  async listByWorkspace(workspaceId: string): Promise<GoogleConnectionRow[]> {
    return prisma.googleConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  },

  async findById(workspaceId: string, id: string): Promise<GoogleConnectionRow | null> {
    return prisma.googleConnection.findFirst({ where: { id, workspaceId } });
  },

  async findByGoogleAccountId(
    workspaceId: string,
    googleAccountId: string
  ): Promise<GoogleConnectionRow | null> {
    return prisma.googleConnection.findFirst({ where: { workspaceId, googleAccountId } });
  },

  getTokens(row: GoogleConnectionRow): GoogleTokenPayload {
    return tokensFromRow(row);
  },

  async upsertConnection(params: {
    workspaceId: string;
    googleAccountId: string;
    email: string;
    tokens: GoogleTokenPayload;
    scopes: string[];
    expiresAt: Date | null;
    displayName?: string | null;
    pictureUrl?: string | null;
  }): Promise<GoogleConnectionRow> {
    const encryptedTokens = encryptJson({
      accessToken: params.tokens.accessToken,
      refreshToken: params.tokens.refreshToken,
    });

    return prisma.googleConnection.upsert({
      where: {
        workspaceId_googleAccountId: {
          workspaceId: params.workspaceId,
          googleAccountId: params.googleAccountId,
        },
      },
      create: {
        workspaceId: params.workspaceId,
        googleAccountId: params.googleAccountId,
        email: params.email,
        encryptedTokens,
        scopes: params.scopes,
        expiresAt: params.expiresAt,
        displayName: params.displayName,
        pictureUrl: params.pictureUrl,
        status: 'active',
      },
      update: {
        email: params.email,
        encryptedTokens,
        scopes: params.scopes,
        expiresAt: params.expiresAt,
        displayName: params.displayName,
        pictureUrl: params.pictureUrl,
        status: 'active',
      },
    });
  },

  async updateTokens(
    id: string,
    tokens: GoogleTokenPayload,
    expiresAt: Date | null,
    scopes?: string[]
  ): Promise<GoogleConnectionRow> {
    const encryptedTokens = encryptJson({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
    const data: Prisma.GoogleConnectionUpdateInput = {
      encryptedTokens,
      expiresAt,
      status: 'active',
    };
    if (scopes?.length) data.scopes = scopes;
    return prisma.googleConnection.update({ where: { id }, data });
  },

  async updateStatus(id: string, status: GoogleConnectionStatus): Promise<void> {
    await prisma.googleConnection.update({ where: { id }, data: { status } });
  },

  async deleteConnection(workspaceId: string, id: string): Promise<boolean> {
    const result = await prisma.googleConnection.deleteMany({ where: { id, workspaceId } });
    return result.count > 0;
  },
};
