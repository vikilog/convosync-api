import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { bumpTokenVersion } from './userSecurity.js';

const RESET_TOKEN_TTL_SECONDS = 5 * 60;

function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashOtpCode(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex');
}

function otpHashesMatch(storedHex: string, attemptCode: string): boolean {
  const a = Buffer.from(storedHex, 'hex');
  const b = Buffer.from(hashOtpCode(attemptCode), 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function otpKey(userId: string) {
  return `pwreset:otp:v1:${userId}`;
}

function sendRateKey(userId: string) {
  return `pwreset:send:v1:${userId}`;
}

function resetTokenKey(token: string) {
  return `pwreset:token:v1:${token}`;
}

type StoredOtp = { hash: string; attempts: number };

async function sendResetEmail(workspaceId: string, to: string, code: string) {
  const { sendWorkspaceEmail } = await import(
    '../modules/email/services/send-workspace-email.js'
  );
  await sendWorkspaceEmail({
    workspaceId,
    to: [to],
    subject: `${code} is your ConvoSync password reset code`,
    text:
      `Your ConvoSync password reset code is ${code}.\n\n` +
      `It expires in ${Math.round(config.contactOtp.ttlSeconds / 60)} minutes.\n` +
      `If you did not request this, you can ignore this email — your password will not change.`,
  });
}

/** Throws if the email is not a registered account, or on repeated abuse. */
export async function requestPasswordReset(emailInput: string): Promise<void> {
  const email = emailInput.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, workspaceId: true },
  });
  if (!user) throw new Error('No account found with that email');

  const redis = getRedis();
  const rateKey = sendRateKey(user.id);
  const n = await redis.incr(rateKey);
  if (n === 1) {
    await redis.expire(rateKey, config.contactOtp.sendWindowSeconds);
  }
  if (n > config.contactOtp.maxSendPerWindow) {
    throw new Error('Too many reset requests. Try again in a few minutes.');
  }

  const code = generateOtpCode();
  await redis.set(
    otpKey(user.id),
    JSON.stringify({ hash: hashOtpCode(code), attempts: 0 } satisfies StoredOtp),
    'EX',
    config.contactOtp.ttlSeconds
  );
  await sendResetEmail(user.workspaceId, user.email, code);
}

/**
 * Verify the emailed code without changing the password yet.
 * Returns a short-lived, single-use token the client carries into resetPasswordWithToken.
 */
export async function verifyResetCode(input: {
  email: string;
  code: string;
}): Promise<{ resetToken: string }> {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error('Invalid or expired code');

  const redis = getRedis();
  const key = otpKey(user.id);
  const raw = await redis.get(key);
  if (!raw) throw new Error('Invalid or expired code');

  let stored: StoredOtp;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredOtp>;
    if (!parsed?.hash) throw new Error('bad payload');
    stored = { hash: parsed.hash, attempts: parsed.attempts ?? 0 };
  } catch {
    throw new Error('Invalid or expired code');
  }

  if (!otpHashesMatch(stored.hash, input.code)) {
    const next = stored.attempts + 1;
    if (next >= config.contactOtp.maxVerifyAttempts) {
      await redis.del(key);
      throw new Error('Too many incorrect codes. Request a new one.');
    }
    const ttl = await redis.ttl(key);
    await redis.set(
      key,
      JSON.stringify({ ...stored, attempts: next } satisfies StoredOtp),
      'EX',
      ttl > 0 ? ttl : config.contactOtp.ttlSeconds
    );
    throw new Error('Invalid or expired code');
  }

  await redis.del(key);
  const resetToken = randomUUID();
  await redis.set(resetTokenKey(resetToken), user.id, 'EX', RESET_TOKEN_TTL_SECONDS);
  return { resetToken };
}

export async function resetPasswordWithToken(input: {
  resetToken: string;
  newPassword: string;
}): Promise<void> {
  const redis = getRedis();
  const key = resetTokenKey(input.resetToken);
  const userId = await redis.get(key);
  if (!userId) throw new Error('Reset session expired. Request a new code.');
  await redis.del(key);

  await prisma.user.update({
    where: { id: userId },
    data: { password: await bcrypt.hash(input.newPassword, 12) },
  });
  await bumpTokenVersion(userId, 'password_reset');
}
