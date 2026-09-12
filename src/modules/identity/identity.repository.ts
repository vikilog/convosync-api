import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export function findUserByEmailWithWorkspace(email: string) {
  return prisma.user.findUnique({
    where: { email },
    include: { workspace: true },
  });
}

export function findUserById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

export function findUserByIdWithWorkspace(id: string) {
  return prisma.user.findUnique({
    where: { id },
    include: {
      workspace: true,
      memberships: { include: { workspace: true } },
    },
  });
}

export function findWorkspaceById(id: string) {
  return prisma.workspace.findUnique({ where: { id } });
}

export function findWorkspaceCompany(id: string) {
  return prisma.workspace.findUnique({
    where: { id },
    include: { plan: { select: { name: true, slug: true } } },
  });
}

export function findWorkspaceContact(id: string) {
  return prisma.workspace.findUnique({
    where: { id },
    select: { email: true, phone: true },
  });
}

export function createWorkspace(data: Prisma.WorkspaceCreateInput) {
  return prisma.workspace.create({ data });
}

/** Signup row — tokenVersion 0. Do not change without updating userSecurity.check.ts. */
export function createSignupUser(data: {
  name: string;
  email: string;
  password: string;
  workspaceId: string;
}) {
  return prisma.user.create({
    data: {
      name: data.name,
      email: data.email,
      password: data.password,
      role: 'admin',
      workspaceId: data.workspaceId,
      onboardingStep: 1,
      onboardingCompleted: false,
      onboardingSkippedSteps: [],
      memberships: {
        create: { workspaceId: data.workspaceId, role: 'admin' },
      },
      securityState: {
        create: { tokenVersion: 0, updatedReason: 'signup' },
      },
    },
  });
}

export function createAdminMembership(userId: string, workspaceId: string) {
  return prisma.workspaceMembership.create({
    data: { userId, workspaceId, role: 'admin' },
  });
}

export function updateWorkspace(id: string, data: Prisma.WorkspaceUpdateInput) {
  return prisma.workspace.update({ where: { id }, data });
}

export function updateWorkspaceLocale(
  id: string,
  data: { country: string; timezone: string }
) {
  return prisma.workspace.update({
    where: { id },
    data,
    select: { id: true, country: true, timezone: true },
  });
}
