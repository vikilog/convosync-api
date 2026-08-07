import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { normalizeWhatsAppRecipient } from '../lib/phone.js';
import { prisma } from '../lib/prisma.js';
import { sendWhatsAppTemplateMessage } from './whatsapp.js';

export const VERIFICATION_TARGETS = ['user_email', 'company_email', 'company_phone'] as const;
export type VerificationTarget = (typeof VERIFICATION_TARGETS)[number];

export function isVerificationTarget(v: string): v is VerificationTarget {
  return (VERIFICATION_TARGETS as readonly string[]).includes(v);
}

export type ContactVerifyState = {
  value: string | null;
  verified: boolean;
  verifiedAt: string | null;
};

export type VerificationStatus = {
  userEmail: ContactVerifyState;
  companyEmail: ContactVerifyState;
  companyPhone: ContactVerifyState;
};

/** Exported for self-check — pure helpers */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex');
}

export function otpHashesMatch(storedHex: string, attemptCode: string): boolean {
  const a = Buffer.from(storedHex, 'hex');
  const b = Buffer.from(hashOtpCode(attemptCode), 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function normalizeVerificationPhone(phone: string): string {
  const digits = normalizeWhatsAppRecipient(phone);
  if (digits.length < 10 || digits.length > 15) {
    throw new Error('Enter a valid mobile number with country code');
  }
  return digits;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const keep = local.slice(0, Math.min(2, local.length));
  return `${keep}***@${domain}`;
}

export function maskPhone(digits: string): string {
  if (digits.length <= 4) return '****';
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function otpKey(ownerId: string, target: VerificationTarget) {
  return `otp:v2:${ownerId}:${target}`;
}

function sendRateKey(ownerId: string, target: VerificationTarget) {
  return `otp:send:v2:${ownerId}:${target}`;
}

async function assertSendAllowed(ownerId: string, target: VerificationTarget) {
  const redis = getRedis();
  const key = sendRateKey(ownerId, target);
  const n = await redis.incr(key);
  if (n === 1) {
    await redis.expire(key, config.contactOtp.sendWindowSeconds);
  }
  if (n > config.contactOtp.maxSendPerWindow) {
    throw new Error('Too many OTP requests. Try again in a few minutes.');
  }
}

async function storeOtp(
  ownerId: string,
  target: VerificationTarget,
  code: string,
  destination: string
) {
  const redis = getRedis();
  await redis.set(
    otpKey(ownerId, target),
    JSON.stringify({ hash: hashOtpCode(code), destination, attempts: 0 }),
    'EX',
    config.contactOtp.ttlSeconds
  );
}

type StoredOtp = { hash: string; destination: string; attempts: number };

async function loadOtp(ownerId: string, target: VerificationTarget): Promise<StoredOtp | null> {
  const raw = await getRedis().get(otpKey(ownerId, target));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredOtp;
    if (!parsed?.hash || !parsed?.destination) return null;
    return { hash: parsed.hash, destination: parsed.destination, attempts: parsed.attempts ?? 0 };
  } catch {
    return null;
  }
}

async function bumpAttemptOrClear(
  ownerId: string,
  target: VerificationTarget,
  stored: StoredOtp
) {
  const redis = getRedis();
  const next = stored.attempts + 1;
  if (next >= config.contactOtp.maxVerifyAttempts) {
    await redis.del(otpKey(ownerId, target));
    throw new Error('Too many incorrect codes. Request a new OTP.');
  }
  const ttl = await redis.ttl(otpKey(ownerId, target));
  await redis.set(
    otpKey(ownerId, target),
    JSON.stringify({ ...stored, attempts: next }),
    'EX',
    ttl > 0 ? ttl : config.contactOtp.ttlSeconds
  );
}

async function sendOtpEmail(workspaceId: string, to: string, code: string) {
  const { sendWorkspaceEmail } = await import(
    '../modules/email/services/send-workspace-email.js'
  );
  await sendWorkspaceEmail({
    workspaceId,
    to: [to],
    subject: `${code} is your ConvoSync verification code`,
    text:
      `Your ConvoSync verification code is ${code}.\n\n` +
      `It expires in ${Math.round(config.contactOtp.ttlSeconds / 60)} minutes.\n` +
      `If you did not request this, you can ignore this email.`,
  });
}

async function sendOtpWhatsApp(toDigits: string, code: string) {
  const token = config.superAdmin.whatsappAccessToken;
  const phoneNumberId = config.superAdmin.phoneNumberId;
  const templateName = config.contactOtp.waTemplateName;
  if (!token || !phoneNumberId || !templateName) {
    throw new Error(
      'WhatsApp OTP is not configured. Set SUPER_ADMIN_ACCESS_TOKEN, SUPER_ADMIN_PHONE_NUMBER_ID, and CONVOSYNC_OTP_WA_TEMPLATE_NAME.'
    );
  }
  await sendWhatsAppTemplateMessage(
    token,
    phoneNumberId,
    toDigits,
    templateName,
    config.contactOtp.waTemplateLang,
    [code],
    config.contactOtp.waIncludeButtonParam ? { buttonUrlParameter: code } : undefined
  );
}

function state(value: string | null | undefined, at: Date | null | undefined): ContactVerifyState {
  return {
    value: value ?? null,
    verified: Boolean(at),
    verifiedAt: at?.toISOString() ?? null,
  };
}

export async function getVerificationStatus(
  userId: string,
  workspaceId: string
): Promise<VerificationStatus> {
  const [user, workspace] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { email: true, phone: true, emailVerifiedAt: true, phoneVerifiedAt: true },
    }),
  ]);
  if (!user) throw new Error('User not found');
  if (!workspace) throw new Error('Company not found');
  return {
    userEmail: state(user.email, user.emailVerifiedAt),
    companyEmail: state(workspace.email, workspace.emailVerifiedAt),
    companyPhone: state(workspace.phone, workspace.phoneVerifiedAt),
  };
}

type SendResult =
  | { sent: false; alreadyVerified: true }
  | {
      sent: true;
      alreadyVerified: false;
      expiresInSeconds: number;
      destinationHint: string;
    };

export async function sendVerificationOtp(input: {
  userId: string;
  workspaceId: string;
  target: VerificationTarget;
  email?: string | null;
  phone?: string | null;
}): Promise<SendResult> {
  const { userId, workspaceId, target } = input;

  if (target === 'user_email') {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user) throw new Error('User not found');
    if (user.emailVerifiedAt) return { sent: false, alreadyVerified: true };
    await assertSendAllowed(userId, target);
    const code = generateOtpCode();
    await storeOtp(userId, target, code, user.email.toLowerCase());
    await sendOtpEmail(workspaceId, user.email, code);
    return {
      sent: true,
      alreadyVerified: false,
      expiresInSeconds: config.contactOtp.ttlSeconds,
      destinationHint: maskEmail(user.email),
    };
  }

  if (target === 'company_email') {
    let email = input.email?.trim().toLowerCase() || '';
    const current = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!current) throw new Error('Company not found');
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('Enter a valid company email');
      }
      if (current.email?.toLowerCase() !== email) {
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: { email, emailVerifiedAt: null },
        });
      } else if (current.emailVerifiedAt) {
        return { sent: false, alreadyVerified: true };
      }
    } else {
      if (current.emailVerifiedAt) return { sent: false, alreadyVerified: true };
      if (!current.email?.trim()) {
        throw new Error('Add a company email before requesting an OTP');
      }
      email = current.email.trim().toLowerCase();
    }
    await assertSendAllowed(workspaceId, target);
    const code = generateOtpCode();
    await storeOtp(workspaceId, target, code, email);
    await sendOtpEmail(workspaceId, email, code);
    return {
      sent: true,
      alreadyVerified: false,
      expiresInSeconds: config.contactOtp.ttlSeconds,
      destinationHint: maskEmail(email),
    };
  }

  // company_phone
  let phoneDigits: string;
  const current = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { phone: true, phoneVerifiedAt: true },
  });
  if (!current) throw new Error('Company not found');
  if (input.phone?.trim()) {
    phoneDigits = normalizeVerificationPhone(input.phone);
    if (current.phone !== phoneDigits) {
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { phone: phoneDigits, phoneVerifiedAt: null },
      });
    } else if (current.phoneVerifiedAt) {
      return { sent: false, alreadyVerified: true };
    }
  } else {
    if (current.phoneVerifiedAt) return { sent: false, alreadyVerified: true };
    if (!current.phone?.trim()) {
      throw new Error('Add a company phone before requesting a WhatsApp OTP');
    }
    phoneDigits = normalizeVerificationPhone(current.phone);
  }
  await assertSendAllowed(workspaceId, target);
  const code = generateOtpCode();
  await storeOtp(workspaceId, target, code, phoneDigits);
  await sendOtpWhatsApp(phoneDigits, code);
  return {
    sent: true,
    alreadyVerified: false,
    expiresInSeconds: config.contactOtp.ttlSeconds,
    destinationHint: maskPhone(phoneDigits),
  };
}

export async function verifyVerificationOtp(input: {
  userId: string;
  workspaceId: string;
  target: VerificationTarget;
  code: string;
}): Promise<VerificationStatus> {
  const { userId, workspaceId, target, code } = input;
  const ownerId = target === 'user_email' ? userId : workspaceId;

  if (target === 'user_email') {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user) throw new Error('User not found');
    if (user.emailVerifiedAt) return getVerificationStatus(userId, workspaceId);
    const stored = await loadOtp(ownerId, target);
    if (!stored) throw new Error('OTP expired or not requested. Send a new code.');
    if (stored.destination !== user.email.toLowerCase()) {
      throw new Error('Email changed since the code was sent. Request a new OTP.');
    }
    if (!otpHashesMatch(stored.hash, code)) {
      await bumpAttemptOrClear(ownerId, target, stored);
      throw new Error('Incorrect verification code');
    }
    await getRedis().del(otpKey(ownerId, target));
    await prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
    return getVerificationStatus(userId, workspaceId);
  }

  if (target === 'company_email') {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!workspace) throw new Error('Company not found');
    if (workspace.emailVerifiedAt) return getVerificationStatus(userId, workspaceId);
    if (!workspace.email) throw new Error('No company email on file');
    const stored = await loadOtp(ownerId, target);
    if (!stored) throw new Error('OTP expired or not requested. Send a new code.');
    if (stored.destination !== workspace.email.toLowerCase()) {
      throw new Error('Email changed since the code was sent. Request a new OTP.');
    }
    if (!otpHashesMatch(stored.hash, code)) {
      await bumpAttemptOrClear(ownerId, target, stored);
      throw new Error('Incorrect verification code');
    }
    await getRedis().del(otpKey(ownerId, target));
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { emailVerifiedAt: new Date() },
    });
    return getVerificationStatus(userId, workspaceId);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { phone: true, phoneVerifiedAt: true },
  });
  if (!workspace) throw new Error('Company not found');
  if (workspace.phoneVerifiedAt) return getVerificationStatus(userId, workspaceId);
  if (!workspace.phone) throw new Error('No company phone on file');
  const phoneDigits = normalizeVerificationPhone(workspace.phone);
  const stored = await loadOtp(ownerId, target);
  if (!stored) throw new Error('OTP expired or not requested. Send a new code.');
  if (stored.destination !== phoneDigits) {
    throw new Error('Phone changed since the code was sent. Request a new OTP.');
  }
  if (!otpHashesMatch(stored.hash, code)) {
    await bumpAttemptOrClear(ownerId, target, stored);
    throw new Error('Incorrect verification code');
  }
  await getRedis().del(otpKey(ownerId, target));
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { phone: phoneDigits, phoneVerifiedAt: new Date() },
  });
  return getVerificationStatus(userId, workspaceId);
}
