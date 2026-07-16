import type { Prisma, PrismaClient } from '@prisma/client';

export class EmailRepository {
  constructor(private readonly db: PrismaClient) {}

  async hasExistingEmailSetup(workspaceId: string): Promise<boolean> {
    const [domainCount, addressCount, providerCount] = await Promise.all([
      this.db.emailDomain.count({ where: { workspaceId } }),
      this.db.emailAddress.count({ where: { workspaceId } }),
      this.db.emailProviderConfig.count({ where: { workspaceId } }),
    ]);
    return domainCount > 0 || addressCount > 0 || providerCount > 0;
  }

  async isEmailIntegrationEnabled(workspaceId: string): Promise<boolean> {
    const row = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { emailIntegrationEnabled: true },
    });
    if (row?.emailIntegrationEnabled) return true;

    const hasLegacySetup = await this.hasExistingEmailSetup(workspaceId);
    if (hasLegacySetup) {
      await this.setEmailIntegrationEnabled(workspaceId, true);
      return true;
    }

    return false;
  }

  setEmailIntegrationEnabled(workspaceId: string, enabled: boolean) {
    return this.db.workspace.update({
      where: { id: workspaceId },
      data: { emailIntegrationEnabled: enabled },
    });
  }

  /** Removes domains, senders, and provider configs; keeps delivery logs and templates. */
  async purgeWorkspaceEmailSetup(workspaceId: string) {
    await this.db.$transaction([
      this.db.emailAddress.deleteMany({ where: { workspaceId } }),
      this.db.emailDomain.deleteMany({ where: { workspaceId } }),
      this.db.emailProviderConfig.deleteMany({ where: { workspaceId } }),
      this.db.workspace.update({
        where: { id: workspaceId },
        data: { emailIntegrationEnabled: false },
      }),
    ]);
  }

  listDomains(workspaceId: string) {
    return this.db.emailDomain.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  findDomainById(workspaceId: string, id: string) {
    return this.db.emailDomain.findFirst({ where: { id, workspaceId } });
  }

  findDomainByName(workspaceId: string, domain: string) {
    return this.db.emailDomain.findFirst({ where: { workspaceId, domain } });
  }

  createDomain(data: Prisma.EmailDomainCreateInput) {
    return this.db.emailDomain.create({ data });
  }

  updateDomain(id: string, data: Prisma.EmailDomainUpdateInput) {
    return this.db.emailDomain.update({ where: { id }, data });
  }

  listAddresses(workspaceId: string) {
    return this.db.emailAddress.findMany({
      where: { workspaceId },
      include: { domain: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  findAddressByEmail(workspaceId: string, email: string) {
    return this.db.emailAddress.findFirst({
      where: { workspaceId, email: email.toLowerCase() },
      include: { domain: true },
    });
  }

  createAddress(data: Prisma.EmailAddressCreateInput) {
    return this.db.emailAddress.create({ data });
  }

  updateAddress(id: string, data: Prisma.EmailAddressUpdateInput) {
    return this.db.emailAddress.update({ where: { id }, data });
  }

  getWorkspaceBrand(workspaceId: string) {
    return this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true, slug: true },
    });
  }

  async clearDefaultSenders(workspaceId: string, exceptId?: string) {
    await this.db.emailAddress.updateMany({
      where: {
        workspaceId,
        isDefault: true,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { isDefault: false },
    });
  }

  listLogs(workspaceId: string, limit = 50) {
    return this.db.emailLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { providerConfig: { select: { provider: true, encryptedConfig: true } } },
    });
  }

  createLog(data: Prisma.EmailLogCreateInput) {
    return this.db.emailLog.create({ data });
  }

  updateLog(id: string, data: Prisma.EmailLogUpdateInput) {
    return this.db.emailLog.update({ where: { id }, data });
  }

  listProviderConfigs(workspaceId: string) {
    return this.db.emailProviderConfig.findMany({
      where: { workspaceId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  findProviderConfigById(workspaceId: string, id: string) {
    return this.db.emailProviderConfig.findFirst({ where: { id, workspaceId } });
  }

  findProviderConfigByType(workspaceId: string, provider: string) {
    return this.db.emailProviderConfig.findFirst({ where: { workspaceId, provider } });
  }

  findDefaultProviderConfig(workspaceId: string) {
    return this.db.emailProviderConfig.findFirst({
      where: { workspaceId, isDefault: true },
    });
  }

  createProviderConfig(data: Prisma.EmailProviderConfigCreateInput) {
    return this.db.emailProviderConfig.create({ data });
  }

  updateProviderConfig(id: string, data: Prisma.EmailProviderConfigUpdateInput) {
    return this.db.emailProviderConfig.update({ where: { id }, data });
  }

  deleteProviderConfig(id: string) {
    return this.db.emailProviderConfig.delete({ where: { id } });
  }

  async clearDefaultProviderConfigs(workspaceId: string, exceptId?: string) {
    await this.db.emailProviderConfig.updateMany({
      where: {
        workspaceId,
        isDefault: true,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { isDefault: false },
    });
  }

  listEmailTemplates(workspaceId: string) {
    return this.db.emailTemplate.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  findEmailTemplateById(workspaceId: string, id: string) {
    return this.db.emailTemplate.findFirst({ where: { id, workspaceId } });
  }

  findEmailTemplateByName(workspaceId: string, name: string) {
    return this.db.emailTemplate.findFirst({
      where: { workspaceId, name: name.toLowerCase() },
    });
  }

  createEmailTemplate(data: Prisma.EmailTemplateCreateInput) {
    return this.db.emailTemplate.create({ data });
  }

  updateEmailTemplate(id: string, data: Prisma.EmailTemplateUpdateInput) {
    return this.db.emailTemplate.update({ where: { id }, data });
  }

  deleteEmailTemplate(id: string) {
    return this.db.emailTemplate.delete({ where: { id } });
  }
}
