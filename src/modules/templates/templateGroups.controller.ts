import type { FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { getJwtUser } from '../../middleware/auth.js';
import type { TemplateGroupBody, TemplateGroupUpdateBody } from '../../routes/templateGroups.schemas.js';

function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function listTemplateGroups(request: FastifyRequest) {
  const { workspaceId } = getJwtUser(request);
  const groups = await prisma.templateGroup.findMany({
    where: { workspaceId },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    include: { _count: { select: { templates: true } } },
  });
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    order: g.order,
    templateCount: g._count.templates,
  }));
}

export async function createTemplateGroup(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const body = request.body as TemplateGroupBody;

  const last = await prisma.templateGroup.findFirst({ where: { workspaceId }, orderBy: { order: 'desc' } });
  const order = (last?.order ?? -1) + 1;

  try {
    const group = await prisma.templateGroup.create({ data: { workspaceId, name: body.name, order } });
    return reply.code(201).send({ id: group.id, name: group.name, order: group.order, templateCount: 0 });
  } catch (err) {
    if (isPrismaUniqueViolation(err)) {
      return reply.code(409).send({ error: 'A group with this name already exists.' });
    }
    throw err;
  }
}

export async function updateTemplateGroup(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };
  const body = request.body as TemplateGroupUpdateBody;

  const existing = await prisma.templateGroup.findFirst({ where: { id, workspaceId } });
  if (!existing) return reply.code(404).send({ error: 'Group not found' });

  try {
    const group = await prisma.templateGroup.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.order !== undefined && { order: body.order }),
      },
    });
    return group;
  } catch (err) {
    if (isPrismaUniqueViolation(err)) {
      return reply.code(409).send({ error: 'A group with this name already exists.' });
    }
    throw err;
  }
}

/** Templates in this group aren't deleted — Template.groupId just goes back to null
 * (see the groupId relation's onDelete: SetNull) so they fall back to "Ungrouped". */
export async function deleteTemplateGroup(request: FastifyRequest, reply: FastifyReply) {
  const { workspaceId } = getJwtUser(request);
  const { id } = request.params as { id: string };

  const existing = await prisma.templateGroup.findFirst({ where: { id, workspaceId } });
  if (!existing) return reply.code(404).send({ error: 'Group not found' });

  await prisma.templateGroup.delete({ where: { id } });
  return { ok: true };
}
