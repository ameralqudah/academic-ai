import { invalidateProviderCache, AI_SETTINGS_KEY, type AISettings } from '@/ai/registry';
import { logger } from '@/lib/logger';
import { AppError } from '@/server/http/errors';
import * as adminRepo from '@/server/repositories/admin.repository';
import { billingProvider } from '@/server/billing';
import { PayPalBillingProvider } from '@/server/billing/paypal';
import * as appSettingsRepo from '@/server/repositories/app-settings.repository';
import * as paymentsRepo from '@/server/repositories/payments.repository';
import * as plansRepo from '@/server/repositories/plans.repository';
import { periodKeyFor } from '@/server/repositories/usage.repository';

export async function overview() {
  const periodKey = periodKeyFor();
  const [stats, byProvider, daily] = await Promise.all([
    adminRepo.platformStats(periodKey),
    adminRepo.usageByProvider(periodKey),
    adminRepo.dailyUsage(30),
  ]);

  return { periodKey, stats, byProvider, daily };
}

export async function users(input: { search?: string; page: number; pageSize: number }) {
  const pageSize = Math.min(100, Math.max(10, input.pageSize));
  const page = Math.max(1, input.page);

  const { rows, total } = await adminRepo.listUsers({
    search: input.search?.trim() || undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function aiUsage() {
  const periodKey = periodKeyFor();
  const [byUser, byProvider] = await Promise.all([
    adminRepo.usageByUser(periodKey, 50),
    adminRepo.usageByProvider(periodKey),
  ]);
  return { periodKey, byUser, byProvider };
}

/** An admin may not suspend or demote themselves — that is how an org locks itself out. */
export async function setUserStatus(
  actorId: string,
  userId: string,
  status: 'ACTIVE' | 'SUSPENDED',
): Promise<void> {
  if (actorId === userId && status === 'SUSPENDED') {
    throw AppError.conflict(
      'You cannot suspend your own account.',
      'لا يمكنك إيقاف حسابك أنت.',
    );
  }
  await adminRepo.setUserStatus(userId, status);
  logger.info('admin.user.status', { userId, status });
}

export async function setUserRole(
  actorId: string,
  userId: string,
  role: 'USER' | 'ADMIN',
): Promise<void> {
  if (actorId === userId && role === 'USER') {
    throw AppError.conflict(
      'You cannot remove your own admin role.',
      'لا يمكنك إزالة صلاحية الإدارة عن نفسك.',
    );
  }
  await adminRepo.setUserRole(userId, role);
  logger.info('admin.user.role', { userId, role });
}

export async function listPlans() {
  return plansRepo.listActivePlans();
}

export interface PlanUpdateInput {
  priceCents?: number;
  maxProjects?: number;
  maxAiRequests?: number;
  maxGeneratedWords?: number;
  maxExports?: number;
  toolAccess?: Record<string, boolean>;
  isActive?: boolean;
  externalPriceId?: string | null;
}

export async function updatePlan(planId: string, values: PlanUpdateInput): Promise<void> {
  await adminRepo.updatePlan(planId, values);
  logger.info('admin.plan.updated', { planId, fields: Object.keys(values) });
}

export async function getAISettings(): Promise<AISettings> {
  const stored = await appSettingsRepo.getSetting<AISettings>(AI_SETTINGS_KEY);
  return stored ?? { provider: 'anthropic' };
}

export async function setAISettings(settings: AISettings): Promise<void> {
  await appSettingsRepo.setSetting(AI_SETTINGS_KEY, settings);
  invalidateProviderCache();
  logger.info('admin.ai.provider', { provider: settings.provider });
}

export interface BillingOverview {
  provider: string;
  takesRealPayments: boolean;
  /** `sandbox` means every payment shown here is a simulation. */
  environment?: 'sandbox' | 'live';
  /** Configured for live, authenticated against sandbox — nothing real is charged. */
  environmentMismatch?: boolean;
  configured: boolean;
  subscribers: adminRepo.SubscriberRow[];
  payments: paymentsRepo.PaymentWithUser[];
  revenue: paymentsRepo.RevenueSummary;
  monthlyRecurringCents: number;
}

/** Everything the billing tab shows, in one round of queries. */
export async function billingOverview(): Promise<BillingOverview> {
  const provider = billingProvider();

  const [subscribers, payments, revenue, monthlyRecurringCents, gateway] = await Promise.all([
    adminRepo.listSubscribers(),
    paymentsRepo.listRecent(),
    paymentsRepo.revenueSummary(),
    paymentsRepo.activeRecurringCents(),
    // Resolved before anything is reported: see `resolvedEnvironment`.
    provider instanceof PayPalBillingProvider ? provider.resolvedEnvironment() : null,
  ]);

  return {
    provider: provider.name,
    takesRealPayments: provider.takesRealPayments,
    ...(gateway
      ? { environment: gateway.environment, environmentMismatch: gateway.mismatch }
      : {}),
    configured: provider.isConfigured(),
    subscribers,
    payments,
    revenue,
    monthlyRecurringCents,
  };
}
