import { z } from 'zod';

export const registerBodySchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  workspaceName: z.string().min(2).optional(),
});

export const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string(),
  workspaceId: z.string().optional(),
});

export const forgotPasswordBodySchema = z.object({
  email: z.string().email(),
});

export const verifyResetCodeBodySchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(12),
});

export const resetPasswordBodySchema = z.object({
  resetToken: z.string().min(1),
  newPassword: z.string().min(8),
});

export const switchWorkspaceBodySchema = z.object({
  workspaceId: z.string().min(1),
});

export const createWorkspaceBodySchema = z.object({
  name: z.string().min(2),
});

export const patchProfileBodySchema = z.object({
  name: z.string().min(2).max(120).optional(),
  phone: z.string().max(32).nullable().optional(),
});

export const patchAvatarBodySchema = z
  .object({
    avatar: z.string().nullable().optional(),
  })
  .default({});

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
