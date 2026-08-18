import { prisma } from '../index.js';
import { config } from '../config.js';
import { registerWorkspaceTags } from './workspaceTags.service.js';
import {
  buildCrmContactPayload,
  mergeContactTags,
  mergeCustomFields,
} from './pushOrganizationCrmContact.helpers.js';

export {
  CRM_CONTACT_TAGS,
  buildCrmContactPayload,
  mergeContactTags,
  mergeCustomFields,
  resolveCrmContactPhone,
  type OrgCrmContactInput,
} from './pushOrganizationCrmContact.helpers.js';

function tenantWorkspaceIdFromCustomFields(customFields: unknown): string | null {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) {
    return null;
  }
  const value = (customFields as Record<string, unknown>).tenantWorkspaceId;
  return typeof value === 'string' && value ? value : null;
}

/**
 * Upsert tenant owner into ConvoSync sales CRM workspace as a Contact.
 * Requires CONVOSYNC_CRM_WORKSPACE_ID and a usable phone on the org/owner.
 */
export async function pushOrganizationToCrmContact(tenantWorkspaceId: string) {
  const crmWorkspaceId = config.convosyncCrmWorkspaceId;
  if (!crmWorkspaceId) {
    throw new Error(
      'CONVOSYNC_CRM_WORKSPACE_ID is not configured — set it to the ConvoSync sales workspace id'
    );
  }

  const [crmWorkspace, tenant] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: crmWorkspaceId },
      select: { id: true },
    }),
    prisma.workspace.findUnique({
      where: { id: tenantWorkspaceId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        country: true,
        industry: true,
        website: true,
        companySize: true,
        users: {
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { name: true, email: true, phone: true, jobTitle: true },
        },
      },
    }),
  ]);

  if (!crmWorkspace) {
    throw new Error('CRM workspace not found — check CONVOSYNC_CRM_WORKSPACE_ID');
  }
  if (!tenant) throw new Error('Organization not found');
  if (tenant.id === crmWorkspaceId) {
    throw new Error('Cannot push the CRM workspace into itself');
  }

  const owner = tenant.users[0];
  const payload = buildCrmContactPayload({
    workspaceId: tenant.id,
    workspaceName: tenant.name,
    workspaceEmail: tenant.email,
    workspacePhone: tenant.phone,
    country: tenant.country,
    industry: tenant.industry,
    website: tenant.website,
    companySize: tenant.companySize,
    ownerName: owner?.name,
    ownerEmail: owner?.email,
    ownerPhone: owner?.phone,
    ownerJobTitle: owner?.jobTitle,
  });

  if (!payload.phone) {
    throw new Error(
      'Owner/company phone is required to create a CRM contact (needed for WhatsApp messaging)'
    );
  }

  const emailNorm = payload.email.trim().toLowerCase() || null;

  let existing = await prisma.contact.findUnique({
    where: {
      phone_workspaceId: { phone: payload.phone, workspaceId: crmWorkspaceId },
    },
  });

  if (!existing && emailNorm) {
    const emailMatch = await prisma.contact.findFirst({
      where: {
        workspaceId: crmWorkspaceId,
        email: { equals: emailNorm, mode: 'insensitive' },
      },
    });
    // A shared/generic email address between two DIFFERENT tenants must not
    // let the second tenant's push silently reassign the first tenant's
    // already-linked CRM contact (name, tags, tenantWorkspaceId) to itself —
    // only trust the email match if it's unambiguously the same tenant.
    const matchedTenantId = tenantWorkspaceIdFromCustomFields(emailMatch?.customFields);
    if (emailMatch && (!matchedTenantId || matchedTenantId === tenant.id)) {
      existing = emailMatch;
    }
  }

  if (existing) {
    const tags = mergeContactTags(existing.tags ?? [], payload.tags);
    const customFields = mergeCustomFields(existing.customFields, payload.customFields);
    const updated = await prisma.contact.update({
      where: { id: existing.id },
      data: {
        name: payload.name,
        email: payload.email || existing.email,
        // Keep existing phone on email-match to avoid unique collisions
        tags,
        customFields,
        source: existing.source || payload.source,
      },
    });
    void registerWorkspaceTags(crmWorkspaceId, tags);
    return {
      ok: true as const,
      created: false,
      alreadyExists: true,
      contactId: updated.id,
      phone: updated.phone,
      email: updated.email,
      message: 'Contact already in ConvoSync CRM — updated with latest signup info',
    };
  }

  const created = await prisma.contact.create({
    data: {
      workspaceId: crmWorkspaceId,
      name: payload.name,
      phone: payload.phone,
      email: payload.email || null,
      source: payload.source,
      tags: payload.tags,
      customFields: payload.customFields,
    },
  });
  void registerWorkspaceTags(crmWorkspaceId, payload.tags);

  return {
    ok: true as const,
    created: true,
    alreadyExists: false,
    contactId: created.id,
    phone: created.phone,
    email: created.email,
    message: 'Added to ConvoSync CRM as contact',
  };
}
