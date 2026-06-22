import bcrypt from 'bcryptjs';
import { prisma } from '../index.js';

const MAX_AVATAR_BYTES = 512 * 1024;

export function sanitizeUser(user: {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
  role: string;
  workspaceId: string;
  createdAt: Date;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    role: user.role,
    workspaceId: user.workspaceId,
    createdAt: user.createdAt,
  };
}

function estimateDataUrlBytes(dataUrl: string) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return dataUrl.length;
  const base64 = dataUrl.slice(comma + 1);
  return Math.ceil((base64.length * 3) / 4);
}

export function validateAvatarValue(avatar: string | null | undefined) {
  if (avatar === null || avatar === undefined || avatar === '') {
    return null;
  }

  const trimmed = avatar.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    if (trimmed.length > 2048) {
      throw new Error('Avatar URL is too long');
    }
    return trimmed;
  }

  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(trimmed)) {
    throw new Error('Avatar must be a JPEG, PNG, or WebP image');
  }

  if (estimateDataUrlBytes(trimmed) > MAX_AVATAR_BYTES) {
    throw new Error('Avatar image must be smaller than 512 KB');
  }

  return trimmed;
}

export async function updateUserProfile(userId: string, input: { name?: string }) {
  const name = input.name?.trim();
  if (!name || name.length < 2) {
    throw new Error('Name must be at least 2 characters');
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { name },
  });

  return sanitizeUser(user);
}

export async function updateUserAvatar(userId: string, avatar: string | null | undefined) {
  const validated = validateAvatarValue(avatar);

  const user = await prisma.user.update({
    where: { id: userId },
    data: { avatar: validated },
  });

  return sanitizeUser(user);
}

export async function changeUserPassword(
  userId: string,
  input: { currentPassword: string; newPassword: string }
) {
  const currentPassword = input.currentPassword;
  const newPassword = input.newPassword?.trim();

  if (!currentPassword) {
    throw new Error('Current password is required');
  }
  if (!newPassword || newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters');
  }
  if (currentPassword === newPassword) {
    throw new Error('New password must be different from the current password');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error('User not found');
  }

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) {
    throw new Error('Current password is incorrect');
  }

  await prisma.user.update({
    where: { id: userId },
    data: { password: await bcrypt.hash(newPassword, 12) },
  });

  return { success: true };
}
