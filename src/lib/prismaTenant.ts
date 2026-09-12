import type { PrismaClient } from '@prisma/client';
import { getTenantWorkspaceId } from '../modules/identity/tenant-context.js';

export const SOFT_DELETE_MODELS = new Set([
  'User',
  'Workspace',
  'Contact',
  'Conversation',
  'Campaign',
  'AiAgent',
]);

/** Models with a real workspaceId column. User is excluded (home workspace ≠ tenant scope). */
export const TENANT_SCOPED_MODELS = new Set([
  'Contact',
  'Conversation',
  'Campaign',
  'AiAgent',
  'Template',
  'Journey',
  'InstagramJourney',
  'Lead',
  'CannedResponse',
  'MediaAsset',
  'WhatsAppFlow',
  'DataTable',
  'CallSession',
  'WorkspaceTag',
  'InboxAssignmentRule',
  'InboxTeamGroup',
]);

type Where = Record<string, unknown> | undefined;

export function applySoftDeleteWhere(model: string, where: Where): Where {
  if (!SOFT_DELETE_MODELS.has(model)) return where;
  if (where && Object.prototype.hasOwnProperty.call(where, 'deletedAt')) return where;
  return { ...(where ?? {}), deletedAt: null };
}

export function applyTenantWhere(model: string, where: Where, workspaceId?: string): Where {
  if (!workspaceId || !TENANT_SCOPED_MODELS.has(model)) return where;
  if (where && Object.prototype.hasOwnProperty.call(where, 'workspaceId')) {
    return where.workspaceId === workspaceId ? where : { AND: [where, { workspaceId }] };
  }
  return { ...(where ?? {}), workspaceId };
}

function delegateName(model: string) {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

export function applyPrismaExtensions(client: PrismaClient) {
  return client.$extends({
    query: {
      $allModels: {
        async findMany({ model, args, query }) {
          const next = args as { where?: Where };
          next.where = applySoftDeleteWhere(model, next.where);
          next.where = applyTenantWhere(model, next.where, getTenantWorkspaceId());
          return query(args);
        },
        async findFirst({ model, args, query }) {
          const next = args as { where?: Where };
          next.where = applySoftDeleteWhere(model, next.where);
          next.where = applyTenantWhere(model, next.where, getTenantWorkspaceId());
          return query(args);
        },
        async findFirstOrThrow({ model, args, query }) {
          const next = args as { where?: Where };
          next.where = applySoftDeleteWhere(model, next.where);
          next.where = applyTenantWhere(model, next.where, getTenantWorkspaceId());
          return query(args);
        },
        async count({ model, args, query }) {
          const next = args as { where?: Where };
          next.where = applySoftDeleteWhere(model, next.where);
          next.where = applyTenantWhere(model, next.where, getTenantWorkspaceId());
          return query(args);
        },
        async findUnique({ model, args, query }) {
          const result = (await query(args)) as { deletedAt?: Date | null; workspaceId?: string } | null;
          if (!result) return result;
          if (SOFT_DELETE_MODELS.has(model) && result.deletedAt) return null;
          const tenant = getTenantWorkspaceId();
          if (tenant && TENANT_SCOPED_MODELS.has(model) && result.workspaceId && result.workspaceId !== tenant) {
            return null;
          }
          return result;
        },
        async findUniqueOrThrow({ model, args, query }) {
          const result = (await query(args)) as { deletedAt?: Date | null; workspaceId?: string };
          if (SOFT_DELETE_MODELS.has(model) && result.deletedAt) {
            throw new Error(`${model} not found`);
          }
          const tenant = getTenantWorkspaceId();
          if (tenant && TENANT_SCOPED_MODELS.has(model) && result.workspaceId && result.workspaceId !== tenant) {
            throw new Error(`${model} not found`);
          }
          return result;
        },
        async delete({ model, args, query }) {
          if (!SOFT_DELETE_MODELS.has(model)) return query(args);
          return (client as unknown as Record<string, { update: (a: unknown) => unknown }>)[
            delegateName(model)
          ].update({
            ...(args as object),
            data: { deletedAt: new Date() },
          });
        },
        async deleteMany({ model, args, query }) {
          if (!SOFT_DELETE_MODELS.has(model)) return query(args);
          const next = args as { where?: Where };
          next.where = applyTenantWhere(model, next.where, getTenantWorkspaceId());
          const name = delegateName(model);
          return (client as unknown as Record<string, { updateMany: (a: unknown) => unknown }>)[name].updateMany({
            where: next.where,
            data: { deletedAt: new Date() },
          });
        },
        async updateMany({ model, args, query }) {
          const next = args as { where?: Where };
          next.where = applyTenantWhere(model, next.where, getTenantWorkspaceId());
          return query(args);
        },
      },
    },
  });
}
