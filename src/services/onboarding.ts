import { Prisma } from '@prisma/client';
import { prisma } from '../index.js';
import { isSuperAdminWorkspace } from './superAdminWorkspace.js';

export const ONBOARDING_TOTAL_STEPS = 7;
export const OPTIONAL_ONBOARDING_STEPS = [5] as const;

export type AccountType = 'company' | 'freelancer' | 'individual';

export type OnboardingState = {
  onboardingStep: number;
  onboardingCompleted: boolean;
  onboardingSkippedSteps: number[];
  onboardingData: Record<string, unknown>;
  progressPercent: number;
  /** Super-admin workspaces skip Meta Embedded Signup; channels are seeded via env. */
  skipEmbeddedSignup: boolean;
  channelsPreconfigured: boolean;
  accountType: AccountType | null;
  user: {
    name: string;
    email: string;
    phone: string | null;
    jobTitle: string | null;
  };
  workspace: {
    id: string;
    name: string;
    industry: string | null;
    country: string | null;
    timezone: string | null;
    companySize: string | null;
    useCases: string[];
    heardAbout: string | null;
    referralCode: string | null;
  };
};

function calcProgressPercent(step: number, completed: boolean, skipped: number[]) {
  if (completed) return 100;
  const requiredSteps = [1, 2, 3, 4, 6, 7];
  const optionalDone = OPTIONAL_ONBOARDING_STEPS.filter((s) => skipped.includes(s)).length;
  const optionalTotal = OPTIONAL_ONBOARDING_STEPS.length;
  const requiredDone = requiredSteps.filter((s) => s < step || (s === step && step > 1)).length;
  const base = Math.round(((requiredDone + optionalDone) / (requiredSteps.length + optionalTotal)) * 100);
  return Math.min(99, Math.max(0, base));
}

async function ensureSuperAdminOnboardingComplete(userId: string, workspaceId: string) {
  if (!(await isSuperAdminWorkspace(workspaceId))) return;

  await prisma.user.updateMany({
    where: { id: userId, onboardingCompleted: false },
    data: {
      onboardingCompleted: true,
      onboardingStep: ONBOARDING_TOTAL_STEPS,
    },
  });
}

export async function getOnboardingState(userId: string, workspaceId: string): Promise<OnboardingState> {
  await ensureSuperAdminOnboardingComplete(userId, workspaceId);

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (!user) throw new Error('User not found');

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      instagramAccounts: { select: { id: true }, take: 1 },
    },
  });
  if (!workspace) throw new Error('Workspace not found');

  const superAdmin = workspace.isSuperAdmin;
  const channelsPreconfigured =
    superAdmin &&
    Boolean(workspace.waNumberId && workspace.wabaId && workspace.instagramAccounts.length > 0);
  const onboardingCompleted = superAdmin ? true : user.onboardingCompleted;
  const onboardingStep = superAdmin ? ONBOARDING_TOTAL_STEPS : user.onboardingStep;

  const onboardingData =
    user.onboardingData && typeof user.onboardingData === 'object' && !Array.isArray(user.onboardingData)
      ? (user.onboardingData as Record<string, unknown>)
      : {};

  return {
    onboardingStep,
    onboardingCompleted,
    onboardingSkippedSteps: user.onboardingSkippedSteps,
    onboardingData,
    progressPercent: calcProgressPercent(
      onboardingStep,
      onboardingCompleted,
      user.onboardingSkippedSteps
    ),
    skipEmbeddedSignup: superAdmin,
    channelsPreconfigured,
    accountType: (workspace.accountType as AccountType | null) ?? null,
    user: {
      name: user.name,
      email: user.email,
      phone: user.phone,
      jobTitle: user.jobTitle,
    },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      industry: workspace.industry,
      country: workspace.country,
      timezone: workspace.timezone,
      companySize: workspace.companySize,
      useCases: workspace.useCases,
      heardAbout: workspace.heardAbout,
      referralCode: workspace.referralCode,
    },
  };
}

type SaveStepInput = {
  step: number;
  skip?: boolean;
  data?: Record<string, unknown>;
};

export async function saveOnboardingStep(
  userId: string,
  workspaceId: string,
  input: SaveStepInput
) {
  if (await isSuperAdminWorkspace(workspaceId)) {
    await ensureSuperAdminOnboardingComplete(userId, workspaceId);
    return getOnboardingState(userId, workspaceId);
  }

  const { step, skip, data = {} } = input;
  if (step < 1 || step > ONBOARDING_TOTAL_STEPS) {
    throw new Error('Invalid onboarding step');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  const existingData =
    user.onboardingData && typeof user.onboardingData === 'object' && !Array.isArray(user.onboardingData)
      ? (user.onboardingData as Record<string, unknown>)
      : {};

  const mergedData = { ...existingData, [`step${step}`]: data };
  const skipped = new Set(user.onboardingSkippedSteps);

  if (skip) {
    if (!OPTIONAL_ONBOARDING_STEPS.includes(step as (typeof OPTIONAL_ONBOARDING_STEPS)[number])) {
      throw new Error('This step cannot be skipped');
    }
    skipped.add(step);
  }

  const userUpdate: Prisma.UserUpdateInput = {
    onboardingData: mergedData as Prisma.InputJsonValue,
    onboardingSkippedSteps: Array.from(skipped).sort((a: number, b: number) => a - b),
    onboardingStep: Math.min(step + 1, ONBOARDING_TOTAL_STEPS),
  };

  const workspaceUpdate: Prisma.WorkspaceUpdateInput = {};

  if (step === 1 && data.accountType) {
    workspaceUpdate.accountType = String(data.accountType);
  }

  if (step === 2) {
    if (typeof data.name === 'string' && data.name.trim().length >= 2) {
      userUpdate.name = data.name.trim();
    }
    if (typeof data.phone === 'string') userUpdate.phone = data.phone.trim() || null;
    if (typeof data.jobTitle === 'string') userUpdate.jobTitle = data.jobTitle.trim() || null;
  }

  if (step === 3) {
    if (typeof data.companyName === 'string' && data.companyName.trim()) {
      workspaceUpdate.name = data.companyName.trim();
    }
    if (typeof data.industry === 'string') workspaceUpdate.industry = data.industry.trim() || null;
    if (typeof data.country === 'string') workspaceUpdate.country = data.country.trim() || null;
    if (typeof data.companySize === 'string') workspaceUpdate.companySize = data.companySize.trim() || null;
    if (typeof data.displayName === 'string' && data.displayName.trim()) {
      workspaceUpdate.name = data.displayName.trim();
    }
  }

  if (step === 4 && Array.isArray(data.useCases)) {
    workspaceUpdate.useCases = data.useCases.map(String);
  }

  if (step === 5 && !skip) {
    if (typeof data.heardAbout === 'string') workspaceUpdate.heardAbout = data.heardAbout.trim() || null;
    if (typeof data.referralCode === 'string') {
      workspaceUpdate.referralCode = data.referralCode.trim() || null;
    }
  }

  if (step === 6) {
    if (typeof data.workspaceName === 'string' && data.workspaceName.trim()) {
      workspaceUpdate.name = data.workspaceName.trim();
    }
    if (typeof data.timezone === 'string') workspaceUpdate.timezone = data.timezone.trim() || null;
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: userUpdate }),
    prisma.workspace.update({ where: { id: workspaceId }, data: workspaceUpdate }),
  ]);

  return getOnboardingState(userId, workspaceId);
}

export async function completeOnboarding(userId: string, workspaceId: string) {
  if (await isSuperAdminWorkspace(workspaceId)) {
    return getOnboardingState(userId, workspaceId);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      onboardingCompleted: true,
      onboardingStep: ONBOARDING_TOTAL_STEPS,
    },
  });
  return getOnboardingState(userId, workspaceId);
}

export function onboardingPayloadFromUser(user: {
  onboardingStep: number;
  onboardingCompleted: boolean;
  onboardingSkippedSteps: number[];
}) {
  return {
    onboardingStep: user.onboardingStep,
    onboardingCompleted: user.onboardingCompleted,
    onboardingSkippedSteps: user.onboardingSkippedSteps,
  };
}
