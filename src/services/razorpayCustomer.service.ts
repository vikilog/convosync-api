import { prisma } from '../lib/prisma.js';
import type { RazorpayService } from '../modules/billing/razorpay.service.js';

export function normalizeIndianPhone(phone?: string | null): string | undefined {
  if (!phone?.trim()) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length > 10) return digits.slice(-10);
  return digits.length >= 10 ? digits : undefined;
}

export async function getWorkspaceRazorpayContact(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      legalName: true,
      email: true,
      phone: true,
      razorpayCustomerId: true,
      users: {
        take: 1,
        orderBy: { createdAt: 'asc' },
        select: { name: true, email: true, phone: true },
      },
    },
  });
  if (!workspace) throw new Error('Workspace not found');

  const primaryUser = workspace.users[0];
  return {
    workspaceId,
    customerId: workspace.razorpayCustomerId,
    name: workspace.legalName?.trim() || workspace.name?.trim() || primaryUser?.name || 'Customer',
    email: workspace.email?.trim() || primaryUser?.email?.trim() || undefined,
    phone: normalizeIndianPhone(workspace.phone || primaryUser?.phone),
  };
}

export async function ensureRazorpayCustomer(
  workspaceId: string,
  razorpay: RazorpayService
): Promise<string> {
  const contact = await getWorkspaceRazorpayContact(workspaceId);
  if (contact.customerId) return contact.customerId;

  const customer = await razorpay.createCustomer({
    name: contact.name,
    email: contact.email,
    contact: contact.phone,
    notes: { workspaceId },
  });

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { razorpayCustomerId: customer.id },
  });

  return customer.id;
}

export async function saveWalletPaymentCredentials(
  workspaceId: string,
  params: {
    tokenId?: string | null;
    customerId?: string | null;
  }
) {
  if (params.customerId) {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { razorpayCustomerId: params.customerId },
    });
  }

  if (!params.tokenId) return;

  await prisma.workspaceWallet.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      razorpayTokenId: params.tokenId,
      autoRechargeStatus: 'idle',
      autoRechargeFailCount: 0,
    },
    update: {
      razorpayTokenId: params.tokenId,
      autoRechargeStatus: 'idle',
      autoRechargeFailCount: 0,
    },
  });
}

export async function syncRazorpayTokenForWorkspace(
  workspaceId: string,
  razorpay: RazorpayService
): Promise<string | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { razorpayCustomerId: true },
  });
  if (!workspace?.razorpayCustomerId) return null;

  try {
    const tokenPage = await razorpay.fetchCustomerTokens(workspace.razorpayCustomerId);
    const items = tokenPage.items ?? [];
    const preferred =
      items.find((token) => token.recurring === true) ??
      items.find((token) => (token as { status?: string }).status === 'confirmed') ??
      items[0];
    if (!preferred?.id) return null;

    await saveWalletPaymentCredentials(workspaceId, {
      tokenId: preferred.id,
      customerId: workspace.razorpayCustomerId,
    });
    return preferred.id;
  } catch {
    return null;
  }
}

export async function persistWalletPaymentMethod(
  workspaceId: string,
  payment: { token_id?: string; customer_id?: string },
  razorpay: RazorpayService
): Promise<{ tokenId?: string; customerId?: string }> {
  let creds = extractPaymentCredentials(payment);
  if (!creds.tokenId) {
    const synced = await syncRazorpayTokenForWorkspace(workspaceId, razorpay);
    if (synced) creds = { ...creds, tokenId: synced };
  }
  await saveWalletPaymentCredentials(workspaceId, creds);
  return creds;
}

export function extractPaymentCredentials(payment: {
  token_id?: string;
  customer_id?: string;
}): { tokenId?: string; customerId?: string } {
  return {
    tokenId: payment.token_id || undefined,
    customerId: payment.customer_id || undefined,
  };
}

export async function enableWalletAutoRecharge(workspaceId: string) {
  await prisma.workspaceWallet.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      autoRechargeEnabled: true,
      autoRechargeStatus: 'idle',
      autoRechargeFailCount: 0,
    },
    update: {
      autoRechargeEnabled: true,
      autoRechargeStatus: 'idle',
      autoRechargeFailCount: 0,
    },
  });
}
