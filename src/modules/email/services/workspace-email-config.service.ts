import type { PrismaClient, WorkspaceEmailConfig } from '@prisma/client';
import {
  decryptJson,
  decryptSecret,
  encryptSecret,
  hasEncryptedPayload,
  isSecretStored,
} from '../../../lib/field-encryption.js';
import { SesProvider } from '../providers/ses.provider.js';
import type { EmailProvider } from '../providers/email-provider.interface.js';
import type { SesProviderConfig } from '../types/provider-config.types.js';
import { formatSesSendError } from '../utils/ses-errors.js';
import {
  isSenderAllowedByIdentities,
  parseCachedVerifiedIdentities,
  sesVerifiedIdentitiesConsoleUrl,
  type SesVerifiedIdentity,
} from '../utils/ses-verified-identities.js';

export type WorkspaceEmailProvider = 'ses' | 'platform';

export type WorkspaceEmailConfigPublic = {
  provider: WorkspaceEmailProvider;
  isActive: boolean;
  region: string | null;
  senderEmail: string | null;
  accessKeyIdMasked: string | null;
  hasSecretAccessKey: boolean;
  verifiedIdentities: SesVerifiedIdentity[];
  identitiesFetchedAt: string | null;
  sesConsoleUrl: string | null;
};

export type ResolvedWorkspaceSes = {
  provider: EmailProvider;
  transport: 'ses';
  from: string;
  fromName?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  senderEmail: string;
};

type CredentialDraft = {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  senderEmail?: string;
};

function maskAccessKeyId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function normalizeProvider(value: string | null | undefined): WorkspaceEmailProvider {
  return value === 'ses' ? 'ses' : 'platform';
}

export function toPublicEmailConfig(row: WorkspaceEmailConfig | null): WorkspaceEmailConfigPublic {
  if (!row) {
    return {
      provider: 'platform',
      isActive: false,
      region: null,
      senderEmail: null,
      accessKeyIdMasked: null,
      hasSecretAccessKey: false,
      verifiedIdentities: [],
      identitiesFetchedAt: null,
      sesConsoleUrl: null,
    };
  }
  const accessKeyId = decryptSecret(row.accessKeyIdEncrypted);
  const region = row.region;
  return {
    provider: normalizeProvider(row.provider),
    isActive: row.isActive && normalizeProvider(row.provider) === 'ses',
    region,
    senderEmail: row.senderEmail,
    accessKeyIdMasked: maskAccessKeyId(accessKeyId),
    hasSecretAccessKey: isSecretStored(row.secretAccessKeyEncrypted),
    verifiedIdentities: parseCachedVerifiedIdentities(row.verifiedIdentities),
    identitiesFetchedAt: row.identitiesFetchedAt?.toISOString() ?? null,
    sesConsoleUrl: region ? sesVerifiedIdentitiesConsoleUrl(region) : null,
  };
}

export class WorkspaceEmailConfigService {
  constructor(private readonly prisma: PrismaClient) {}

  async getOrNull(workspaceId: string): Promise<WorkspaceEmailConfig | null> {
    return this.prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } });
  }

  async getPublic(workspaceId: string): Promise<WorkspaceEmailConfigPublic> {
    const row = await this.getOrNull(workspaceId);
    return toPublicEmailConfig(row);
  }

  /**
   * Active BYO SES credentials for a workspace, or null → use platform email.
   */
  async resolveActiveSes(workspaceId: string): Promise<ResolvedWorkspaceSes | null> {
    const row = await this.getOrNull(workspaceId);
    if (!row || !row.isActive || normalizeProvider(row.provider) !== 'ses') return null;

    const accessKeyId = decryptSecret(row.accessKeyIdEncrypted)?.trim();
    const secretAccessKey = decryptSecret(row.secretAccessKeyEncrypted)?.trim();
    const region = row.region?.trim();
    const senderEmail = row.senderEmail?.trim();
    if (!accessKeyId || !secretAccessKey || !region || !senderEmail) return null;

    // Attach configuration set when EmailProviderConfig tracking setup succeeded.
    let configurationSetName: string | undefined;
    let trackingStatus: SesProviderConfig['trackingStatus'];
    const providerRow = await this.prisma.emailProviderConfig.findFirst({
      where: { workspaceId, provider: 'AWS_SES' },
    });
    if (providerRow && hasEncryptedPayload(providerRow.encryptedConfig)) {
      try {
        const ses = decryptJson<SesProviderConfig>(providerRow.encryptedConfig);
        configurationSetName = ses.configurationSetName;
        trackingStatus = ses.trackingStatus;
      } catch {
        // ignore decrypt failures — send without tracking
      }
    }

    return {
      provider: new SesProvider({
        accessKeyId,
        secretAccessKey,
        region,
        configurationSetName,
        trackingStatus,
      }),
      transport: 'ses',
      from: senderEmail,
      accessKeyId,
      secretAccessKey,
      region,
      senderEmail,
    };
  }

  private resolveCredentials(
    row: WorkspaceEmailConfig | null,
    draft: CredentialDraft = {}
  ):
    | { ok: true; accessKeyId: string; secretAccessKey: string; region: string }
    | { ok: false; message: string } {
    const accessKeyId =
      draft.accessKeyId?.trim() || decryptSecret(row?.accessKeyIdEncrypted)?.trim() || '';
    const secretAccessKey =
      draft.secretAccessKey?.trim() ||
      decryptSecret(row?.secretAccessKeyEncrypted)?.trim() ||
      '';
    const region = draft.region?.trim() || row?.region?.trim() || '';
    if (!accessKeyId || !secretAccessKey || !region) {
      return {
        ok: false,
        message: 'AWS Access Key ID, Secret Access Key, and Region are required.',
      };
    }
    return { ok: true, accessKeyId, secretAccessKey, region };
  }

  /**
   * GetSendQuota + ListIdentities / verification attrs; cache Success identities on the row.
   */
  async refreshIdentities(params: {
    workspaceId: string;
    draft?: CredentialDraft;
  }): Promise<
    | {
        ok: true;
        message: string;
        config: WorkspaceEmailConfigPublic;
        verifiedIdentities: SesVerifiedIdentity[];
      }
    | { ok: false; message: string; config: WorkspaceEmailConfigPublic }
  > {
    const row = await this.getOrNull(params.workspaceId);
    const creds = this.resolveCredentials(row, params.draft ?? {});
    if (!creds.ok) {
      return { ok: false, message: creds.message, config: toPublicEmailConfig(row) };
    }

    const provider = new SesProvider({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      region: creds.region,
    });

    try {
      const quota = await provider.testConnection();
      if (!quota.ok) {
        return { ok: false, message: quota.message, config: toPublicEmailConfig(row) };
      }

      const verifiedIdentities = await provider.listVerifiedIdentities();
      const fetchedAt = new Date();

      // Persist credentials only when newly provided; always refresh identity cache when we can.
      let accessKeyIdEncrypted = row?.accessKeyIdEncrypted ?? null;
      let secretAccessKeyEncrypted = row?.secretAccessKeyEncrypted ?? null;
      if (params.draft?.accessKeyId?.trim()) {
        accessKeyIdEncrypted = encryptSecret(params.draft.accessKeyId.trim());
      }
      if (params.draft?.secretAccessKey?.trim()) {
        secretAccessKeyEncrypted = encryptSecret(params.draft.secretAccessKey.trim());
      }

      const updated = await this.prisma.workspaceEmailConfig.upsert({
        where: { workspaceId: params.workspaceId },
        create: {
          workspaceId: params.workspaceId,
          provider: row?.provider ?? 'platform',
          isActive: row?.isActive ?? false,
          accessKeyIdEncrypted,
          secretAccessKeyEncrypted,
          region: creds.region,
          senderEmail: row?.senderEmail ?? null,
          verifiedIdentities,
          identitiesFetchedAt: fetchedAt,
        },
        update: {
          ...(params.draft?.accessKeyId?.trim() || params.draft?.secretAccessKey?.trim()
            ? { accessKeyIdEncrypted, secretAccessKeyEncrypted }
            : {}),
          region: creds.region,
          verifiedIdentities,
          identitiesFetchedAt: fetchedAt,
        },
      });

      const config = toPublicEmailConfig(updated);
      const domainCount = verifiedIdentities.filter((i) => i.type === 'domain').length;
      const emailCount = verifiedIdentities.filter((i) => i.type === 'email').length;
      const message =
        verifiedIdentities.length === 0
          ? `No verified domains or emails in region ${creds.region} — verify a sender domain/email in SES (same region), then refresh`
          : `Found ${verifiedIdentities.length} verified sender identit${
              verifiedIdentities.length === 1 ? 'y' : 'ies'
            } (${domainCount} domain${domainCount === 1 ? '' : 's'}, ${emailCount} email${
              emailCount === 1 ? '' : 's'
            })`;

      return { ok: true, message, config, verifiedIdentities };
    } catch (err) {
      return {
        ok: false,
        message: formatSesSendError(err),
        config: toPublicEmailConfig(row),
      };
    }
  }

  async upsert(
    workspaceId: string,
    input: {
      useOwnEmail: boolean;
      accessKeyId?: string;
      secretAccessKey?: string;
      region?: string;
      senderEmail?: string;
    }
  ): Promise<WorkspaceEmailConfigPublic> {
    const existing = await this.getOrNull(workspaceId);

    if (!input.useOwnEmail) {
      const row = await this.prisma.workspaceEmailConfig.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          provider: 'platform',
          isActive: false,
        },
        update: {
          provider: 'platform',
          isActive: false,
        },
      });
      return toPublicEmailConfig(row);
    }

    const region = input.region?.trim() || existing?.region?.trim() || '';
    const senderEmail = input.senderEmail?.trim() || existing?.senderEmail?.trim() || '';
    if (!region) throw new Error('AWS region is required');
    if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
      throw new Error('From email is required');
    }

    const cached = parseCachedVerifiedIdentities(existing?.verifiedIdentities);
    if (cached.length > 0 && !isSenderAllowedByIdentities(senderEmail, cached)) {
      throw new Error(
        'From email must match a verified SES email identity or a verified domain'
      );
    }

    let accessKeyIdEncrypted = existing?.accessKeyIdEncrypted ?? null;
    let secretAccessKeyEncrypted = existing?.secretAccessKeyEncrypted ?? null;

    if (input.accessKeyId?.trim()) {
      accessKeyIdEncrypted = encryptSecret(input.accessKeyId.trim());
    }
    if (input.secretAccessKey?.trim()) {
      secretAccessKeyEncrypted = encryptSecret(input.secretAccessKey.trim());
    }

    if (!isSecretStored(accessKeyIdEncrypted) || !isSecretStored(secretAccessKeyEncrypted)) {
      throw new Error('AWS Access Key ID and Secret Access Key are required');
    }

    const row = await this.prisma.workspaceEmailConfig.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        provider: 'ses',
        isActive: true,
        accessKeyIdEncrypted,
        secretAccessKeyEncrypted,
        region,
        senderEmail,
      },
      update: {
        provider: 'ses',
        isActive: true,
        accessKeyIdEncrypted,
        secretAccessKeyEncrypted,
        region,
        senderEmail,
      },
    });

    return toPublicEmailConfig(row);
  }

  async disable(workspaceId: string): Promise<WorkspaceEmailConfigPublic> {
    return this.upsert(workspaceId, { useOwnEmail: false });
  }

  /**
   * Keep WorkspaceEmailConfig in lockstep with EmailProviderConfig AWS_SES.
   * Providers UI is the only surface; this row still backs transactional/alert sends.
   */
  async syncFromSesProvider(
    workspaceId: string,
    input: {
      active: boolean;
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
      senderEmail?: string | null;
      verifiedIdentities?: SesVerifiedIdentity[];
      identitiesFetchedAt?: Date | null;
    }
  ): Promise<void> {
    const senderEmail = input.senderEmail?.trim() || null;
    const activate = Boolean(input.active && senderEmail);
    const identities =
      input.verifiedIdentities ??
      parseCachedVerifiedIdentities((await this.getOrNull(workspaceId))?.verifiedIdentities);

    if (
      activate &&
      senderEmail &&
      identities.length > 0 &&
      !isSenderAllowedByIdentities(senderEmail, identities)
    ) {
      throw new Error(
        'From email must match a verified SES email identity or a verified domain'
      );
    }

    await this.prisma.workspaceEmailConfig.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        provider: activate ? 'ses' : 'platform',
        isActive: activate,
        accessKeyIdEncrypted: encryptSecret(input.accessKeyId),
        secretAccessKeyEncrypted: encryptSecret(input.secretAccessKey),
        region: input.region,
        senderEmail,
        verifiedIdentities: input.verifiedIdentities ?? [],
        identitiesFetchedAt: input.identitiesFetchedAt ?? null,
      },
      update: {
        provider: activate ? 'ses' : 'platform',
        isActive: activate,
        accessKeyIdEncrypted: encryptSecret(input.accessKeyId),
        secretAccessKeyEncrypted: encryptSecret(input.secretAccessKey),
        region: input.region,
        senderEmail,
        ...(input.verifiedIdentities
          ? { verifiedIdentities: input.verifiedIdentities }
          : {}),
        ...(input.identitiesFetchedAt !== undefined
          ? { identitiesFetchedAt: input.identitiesFetchedAt }
          : {}),
      },
    });
  }

  async sendTestEmail(params: {
    workspaceId: string;
    to: string;
    draft?: CredentialDraft;
  }): Promise<
    | {
        ok: true;
        message: string;
        messageId: string;
        config: WorkspaceEmailConfigPublic;
      }
    | { ok: false; message: string; config?: WorkspaceEmailConfigPublic }
  > {
    const row = await this.getOrNull(params.workspaceId);
    const draft = params.draft ?? {};

    const creds = this.resolveCredentials(row, draft);
    if (!creds.ok) {
      return { ok: false, message: creds.message, config: toPublicEmailConfig(row) };
    }

    const senderEmail = draft.senderEmail?.trim() || row?.senderEmail?.trim() || '';
    if (!senderEmail) {
      return {
        ok: false,
        message: 'From email is required to send a test.',
        config: toPublicEmailConfig(row),
      };
    }

    // Refresh identity cache on every test send (credentials + ListIdentities).
    const refreshed = await this.refreshIdentities({
      workspaceId: params.workspaceId,
      draft,
    });
    if (!refreshed.ok) {
      return { ok: false, message: refreshed.message, config: refreshed.config };
    }

    if (
      refreshed.verifiedIdentities.length > 0 &&
      !isSenderAllowedByIdentities(senderEmail, refreshed.verifiedIdentities)
    ) {
      return {
        ok: false,
        message:
          'From email must match a verified SES email identity or a verified domain. Refresh identities and pick a verified sender.',
        config: refreshed.config,
      };
    }

    const provider = new SesProvider({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      region: creds.region,
    });
    try {
      const result = await provider.sendEmail({
        from: senderEmail,
        fromName: 'ConvoSync',
        to: params.to,
        subject: 'ConvoSync SES test email',
        text:
          `This is a test email from ConvoSync using your AWS SES credentials.\n\n` +
          `Region: ${creds.region}\nSender: ${senderEmail}\n\n` +
          `If you received this, your Bring Your Own Email setup is working.`,
      });
      return {
        ok: true,
        message: `Test email sent to ${params.to}`,
        messageId: result.messageId,
        config: refreshed.config,
      };
    } catch (err) {
      return {
        ok: false,
        message: formatSesSendError(err),
        config: refreshed.config,
      };
    }
  }
}
