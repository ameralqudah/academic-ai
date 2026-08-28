/**
 * Integration tests against a real PostgreSQL database.
 *
 *   createdb academic_ai_test
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run db:migrate
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run db:seed
 *   DATABASE_URL=postgresql://…/academic_ai_test npm run test:integration
 *
 * These exercise the service layer — ownership, plan limits, usage metering,
 * billing, section versioning, export — with real SQL underneath. They never call
 * an AI provider, so no API key is needed.
 *
 * Every test creates its own users with a run-scoped email prefix and deletes
 * them at the end, so the suite is safe to re-run and leaves nothing behind.
 */

import 'dotenv/config';

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import bcrypt from 'bcryptjs';
import { eq, like } from 'drizzle-orm';

import type { AgentEvent } from '@/agents/events';
import { buildResultsContext } from '@/ai/context/results';
import { clearIntentStubForTests, setIntentStubForTests } from '@/agents/intent';
import { runAgent } from '@/agents/orchestrator';
import { PROPOSAL_SECTIONS, WIZARD_STEPS } from '@/config/research';
import { resetEnvCache } from '@/config/env';
import { db } from '@/server/db';
import { users } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { consume, resetRateLimitStore } from '@/server/http/rate-limit';
import * as adminRepo from '@/server/repositories/admin.repository';
import * as analysisRunsRepo from '@/server/repositories/analysis-runs.repository';
import * as agentTasksRepo from '@/server/repositories/agent-tasks.repository';
import * as datasetsRepo from '@/server/repositories/datasets.repository';
import * as paymentsRepo from '@/server/repositories/payments.repository';
import * as plansRepo from '@/server/repositories/plans.repository';
import { periodKeyFor } from '@/server/repositories/usage.repository';
import {
  register,
  requestPasswordReset,
  resetPassword,
} from '@/server/services/account.service';
import { applyBillingEvent, cancelSubscription, listUserPayments, startCheckout } from '@/server/services/billing.service';
import { exportProjectDocx } from '@/server/services/export.service';
import {
  createProject,
  getOwnedProject,
  getProjectWithSections,
  switchDocType,
} from '@/server/services/project.service';
import { addReference, listReferences, markVerified } from '@/server/services/reference.service';
import { approveSection, listVersions, saveSection } from '@/server/services/section.service';
import {
  deleteEverything,
  deleteFileOnly,
  deletionImpact,
  loadForAnalysis,
  saveCleanedCopy,
  saveUpload,
} from '@/server/services/dataset.service';
import {
  attachRun,
  detachRun,
  getRun,
  recommend,
  runAnalysis,
} from '@/server/services/statistics.service';
import { resolvePlanForUser } from '@/server/services/subscription.service';
import { resetStorageCache } from '@/server/storage';
import { isOwnerEmail } from '@/server/auth/owner';
import {
  assertCanCreateProject,
  assertCanUseAI,
  getSummary,
  recordAIUsage,
} from '@/server/services/usage.service';

const RUN = `itest-${Date.now()}`;
let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

function assertTrue(name: string, value: boolean) {
  check(name, value, true);
}

async function expectAppError(name: string, code: string, run: () => Promise<unknown>) {
  try {
    await run();
    failed += 1;
    console.log(`  FAIL ${name}: expected ${code} but nothing was thrown`);
  } catch (error) {
    if (error instanceof AppError && error.code === code) {
      passed += 1;
      console.log(`  ok   ${name}`);
    } else {
      failed += 1;
      console.log(
        `  FAIL ${name}: expected ${code}, got ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

async function newUser(tag: string) {
  const email = `${RUN}-${tag}@example.test`;
  const created = await register({
    name: `Test ${tag}`,
    email,
    password: 'Passw0rd123',
    confirmPassword: 'Passw0rd123',
    locale: 'ar',
  });
  return created.id;
}

const projectInput = {
  academicField: 'educationalSciences' as const,
  specialization: 'المناهج وطرق التدريس',
  degree: 'MASTER' as const,
  language: 'AR' as const,
  researchType: 'QUANTITATIVE' as const,
  docType: 'PAPER' as const,
  keywords: ['التعلم النشط', 'التحصيل الدراسي'],
  problemArea:
    'ضعف مستوى التحصيل في مادة الرياضيات لدى طلبة المرحلة الأساسية رغم تطبيق استراتيجيات حديثة.',
};

async function main() {
  /* ---------------------------------------------------------------- accounts */
  section('accounts & default plan');

  const userA = await newUser('a');
  const summaryA = await getSummary(userA);
  check('new account lands on the default plan', summaryA.plan.code, 'FREE');
  check('free plan allows one project', summaryA.projects.limit, 1);
  check('free plan starts with zero usage', summaryA.aiRequests.used, 0);

  await expectAppError('duplicate email is rejected', 'CONFLICT', () =>
    register({
      name: 'Duplicate',
      email: `${RUN}-a@example.test`,
      password: 'Passw0rd123',
      confirmPassword: 'Passw0rd123',
      locale: 'ar',
    }),
  );

  // Three server components resolve the plan concurrently on a real page render.
  // The unique index on subscriptions.userId used to make the losers throw 23505.
  const userRace = await newUser('race');
  const raced = await Promise.all([
    resolvePlanForUser(userRace),
    resolvePlanForUser(userRace),
    resolvePlanForUser(userRace),
  ]);
  check('concurrent plan resolution does not race', raced.map((r) => r.plan.code), [
    'FREE',
    'FREE',
    'FREE',
  ]);

  /* ---------------------------------------------------------------- projects */
  section('projects & plan limits');

  const project = await createProject(userA, projectInput);
  const { sections } = await getProjectWithSections(project.id, userA);
  check('a paper project gets the 13 wizard sections', sections.length, WIZARD_STEPS.length);
  check('sections start empty', sections.every((s) => s.status === 'EMPTY'), true);

  await expectAppError('second project hits the free limit', 'PLAN_LIMIT', () =>
    assertCanCreateProject(userA),
  );

  const userB = await newUser('b');
  await expectAppError("another user cannot open the project", 'NOT_FOUND', () =>
    getOwnedProject(project.id, userB),
  );

  /* ---------------------------------------------------------------- sections */
  section('sections, versions & approval');

  const draft = 'مشكلة الدراسة تتمثل في تدنّي مستوى التحصيل رغم توافر الإمكانات.';
  const saved = await saveSection({
    projectId: project.id,
    userId: userA,
    sectionKey: 'PROBLEM',
    content: draft,
    origin: 'AI',
    status: 'AI_SUGGESTED',
  });
  check('saving records the word count', saved.wordCount > 0, true);
  check('AI output is marked as suggested', saved.status, 'AI_SUGGESTED');

  await saveSection({
    projectId: project.id,
    userId: userA,
    sectionKey: 'PROBLEM',
    content: `${draft} وقد لوحظ ذلك عبر ثلاث سنوات متتالية.`,
    origin: 'USER',
  });

  const versions = await listVersions(project.id, userA, 'PROBLEM');
  check('every save keeps a version', versions.length, 2);
  check('versions record who wrote them', versions.map((v) => v.origin).sort(), ['AI', 'USER']);

  const approved = await approveSection(project.id, userA, 'PROBLEM');
  check('approval sets the status', approved.status, 'APPROVED');
  assertTrue('approval stamps approvedAt', approved.approvedAt instanceof Date);

  // The upsert conflict path used to drop approvedAt.
  const reapproved = await saveSection({
    projectId: project.id,
    userId: userA,
    sectionKey: 'PROBLEM',
    content: approved.content,
    origin: 'USER',
    status: 'APPROVED',
  });
  assertTrue('re-saving an approved section keeps approvedAt', reapproved.approvedAt instanceof Date);

  const afterApproval = await getOwnedProject(project.id, userA);
  assertTrue('project progress moves off zero', afterApproval.progressPercent > 0);
  assertTrue('project word count is aggregated', afterApproval.totalWords > 0);

  await expectAppError('an empty section cannot be approved', 'CONFLICT', () =>
    approveSection(project.id, userA, 'CONCLUSION'),
  );

  /* ------------------------------------------------------------- doc type */
  section('document type switching');

  await switchDocType(project.id, userA, 'PROPOSAL');
  const afterSwitch = await getProjectWithSections(project.id, userA);
  check('switching to a proposal keeps existing sections', afterSwitch.project.docType, 'PROPOSAL');
  check(
    'every proposal part now exists',
    PROPOSAL_SECTIONS.every((key) =>
      afterSwitch.sections.some((row) => row.sectionKey === key),
    ),
    true,
  );
  check(
    'the approved problem statement survived the switch',
    afterSwitch.sections.find((row) => row.sectionKey === 'PROBLEM')?.status,
    'APPROVED',
  );

  /* ------------------------------------------------------------- references */
  section('references & verification');

  const reference = await addReference({
    projectId: project.id,
    userId: userA,
    rawText: 'الزهراني، محمد. (2021). أثر التعلم النشط في التحصيل. مجلة التربية، 12(3)، 45-67.',
  });
  check('a new reference is unverified', reference.verification, 'UNVERIFIED');

  const verified = await markVerified(project.id, userA, reference.id);
  check('only an explicit action confirms it', verified.verification, 'USER_CONFIRMED');

  await expectAppError('references are project-scoped', 'NOT_FOUND', () =>
    listReferences(project.id, userB),
  );

  /* ------------------------------------------------------------------ usage */
  section('usage metering');

  await recordAIUsage({
    userId: userA,
    projectId: project.id,
    generatedWords: 450,
    tokensIn: 1200,
    tokensOut: 800,
    costMicroUsd: 15_600,
    provider: 'anthropic',
    model: 'test-model',
  });

  const afterUsage = await getSummary(userA);
  check('a request is counted', afterUsage.aiRequests.used, 1);
  check('generated words are counted', afterUsage.generatedWords.used, 450);
  check('remaining is derived from the plan', afterUsage.aiRequests.remaining, 19);

  for (let i = 0; i < 19; i += 1) {
    await recordAIUsage({
      userId: userA,
      projectId: project.id,
      generatedWords: 1,
      tokensIn: 1,
      tokensOut: 1,
      costMicroUsd: 1,
      provider: 'anthropic',
      model: 'test-model',
    });
  }

  await expectAppError('the request quota is enforced', 'PLAN_LIMIT', () =>
    assertCanUseAI(userA, 10),
  );

  /* ---------------------------------------------------------------- billing */
  section('billing');

  const checkout = await startCheckout({ userId: userA, planCode: 'PRO', locale: 'ar' });
  check('manual billing applies the change directly', checkout.applied, true);

  const proSummary = await getSummary(userA);
  check('the user is now on Pro', proSummary.plan.code, 'PRO');
  check('Pro raises the project limit', proSummary.projects.limit, 25);
  check('Pro unlocks the editor', proSummary.toolAccess.editor, true);
  check('usage carries over, it is not reset by an upgrade', proSummary.aiRequests.used, 20);

  await assertCanCreateProject(userA);
  passed += 1;
  console.log('  ok   a Pro user can create another project');

  /* ----------------------------------------------------------------- export */
  section('export');

  const exported = await exportProjectDocx({
    projectId: project.id,
    userId: userA,
    sectionLabels: { problem: 'مشكلة الدراسة' },
    referencesLabel: 'المراجع',
    unverifiedLabel: 'غير متحقَّق منه',
  });
  check('export produces a docx container', exported.buffer.subarray(0, 2).toString('latin1'), 'PK');
  assertTrue('the exported file is not trivially small', exported.buffer.byteLength > 2000);
  assertTrue('the filename comes from the project title', exported.filename.endsWith('.docx'));

  await expectAppError('a free user cannot export', 'PLAN_LIMIT', () =>
    exportProjectDocx({
      projectId: project.id,
      userId: userB,
      sectionLabels: {},
      referencesLabel: 'المراجع',
      unverifiedLabel: 'غير متحقَّق منه',
    }),
  );

  /* ------------------------------------------------------------ cancellation */
  section('cancellation');

  await cancelSubscription(userA, false);
  const afterCancel = await getSummary(userA);
  check('cancelling returns the user to the free plan', afterCancel.plan.code, 'FREE');
  check('the free plan locks the editor again', afterCancel.toolAccess.editor, false);

  /* ---------------------------------------------------------------- admin */
  section('admin aggregates');

  const periodKey = periodKeyFor();
  const stats = await adminRepo.platformStats(periodKey);
  assertTrue('platform stats count our users', stats.totalUsers >= 3);
  assertTrue('platform stats count AI requests', stats.aiRequestsThisPeriod >= 20);

  const byUser = await adminRepo.usageByUser(periodKey, 10);
  assertTrue('usage by user includes the test account', byUser.some((row) => row.userId === userA));

  const byProvider = await adminRepo.usageByProvider(periodKey);
  assertTrue(
    'usage by provider groups the test model',
    byProvider.some((row) => row.model === 'test-model'),
  );

  const daily = await adminRepo.dailyUsage(30);
  assertTrue('daily usage returns at least today', daily.length >= 1);

  const listed = await adminRepo.listUsers({ search: RUN, limit: 10, offset: 0 });
  check('user search finds this run', listed.total, 3);

  /* -------------------------------------------------------- password reset */
  section('password reset');

  const resetEmail = `${RUN}-b@example.test`;
  const requested = await requestPasswordReset(resetEmail, 'ar');
  assertTrue('a reset link is issued for a known address', Boolean(requested.devUrl));

  const link = new URL(requested.devUrl ?? 'http://x/');
  const uid = link.searchParams.get('uid') ?? '';
  const resetToken = link.searchParams.get('token') ?? '';
  check('the link carries the user id', uid, userB);
  check('the token is 32 random bytes in hex', resetToken.length, 64);

  await resetPassword({ userId: uid, token: resetToken, password: 'BrandNew123' });
  const [afterReset] = await db.select().from(users).where(eq(users.id, userB)).limit(1);
  assertTrue(
    'the new password is stored hashed and verifies',
    await bcrypt.compare('BrandNew123', afterReset?.passwordHash ?? ''),
  );
  assertTrue(
    'the old password no longer works',
    !(await bcrypt.compare('Passw0rd123', afterReset?.passwordHash ?? '')),
  );

  await expectAppError('a reset link works only once', 'CONFLICT', () =>
    resetPassword({ userId: uid, token: resetToken, password: 'Another123' }),
  );

  await expectAppError('a forged token is rejected', 'CONFLICT', () =>
    resetPassword({ userId: uid, token: 'f'.repeat(64), password: 'Another123' }),
  );

  const unknown = await requestPasswordReset(`${RUN}-nobody@example.test`, 'ar');
  check('an unknown address reveals nothing', unknown.devUrl, undefined);

  /* ------------------------------------------------------------ rate limit */
  section('rate limiting');

  resetRateLimitStore();
  const limitKey = `test:${RUN}`;
  const first = await consume(limitKey, 3, 60);
  await consume(limitKey, 3, 60);
  const third = await consume(limitKey, 3, 60);
  const fourth = await consume(limitKey, 3, 60);

  check('the first request is allowed', first.allowed, true);
  check('remaining counts down', third.remaining, 0);
  check('the fourth request is blocked', fourth.allowed, false);
  assertTrue('a blocked request reports when to retry', fourth.retryAfterSeconds > 0);

  const otherKey = await consume(`test:${RUN}:other`, 3, 60);
  check('separate keys have separate windows', otherKey.allowed, true);

  /* --------------------------------------------------- billing lifecycle */
  section('billing lifecycle (gateway events)');

  const payer = await newUser('payer');
  const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await applyBillingEvent({
    type: 'subscription.activated',
    userId: payer,
    planCode: 'PRO',
    externalSubscriptionId: `I-${RUN}-SUB`,
    externalCustomerId: `CUST-${RUN}`,
    periodEnd: nextMonth,
    externalEventId: `evt-${RUN}-1`,
  });

  const activated = await resolvePlanForUser(payer);
  check('an activation event grants Pro', activated.plan.code, 'PRO');
  check('activation records the renewal date', activated.periodEnd !== null, true);
  assertTrue('activation marks the account as Pro', activated.isPro);

  // The renewal charge: a sale with no next-billing date must still roll the
  // period forward, otherwise a paying subscriber lapses after one month.
  await applyBillingEvent({
    type: 'payment.succeeded',
    externalSubscriptionId: `I-${RUN}-SUB`,
    externalEventId: `evt-${RUN}-2`,
    payment: {
      externalPaymentId: `PAY-${RUN}-1`,
      amountCents: 1500,
      currency: 'USD',
      occurredAt: new Date(),
    },
  });

  const afterRenewal = await resolvePlanForUser(payer);
  check('a renewal keeps the account on Pro', afterRenewal.plan.code, 'PRO');

  const ledger = await listUserPayments(payer);
  check('the charge is written to the ledger', ledger.length, 1);
  check('the ledger stores the amount in minor units', ledger[0]?.amountCents, 1500);
  check('the ledger marks it paid', ledger[0]?.status, 'SUCCEEDED');

  // PayPal redelivers webhooks routinely; counting a sale twice would overstate
  // revenue in the admin dashboard.
  await applyBillingEvent({
    type: 'payment.succeeded',
    externalSubscriptionId: `I-${RUN}-SUB`,
    externalEventId: `evt-${RUN}-2-redelivered`,
    payment: {
      externalPaymentId: `PAY-${RUN}-1`,
      amountCents: 1500,
      currency: 'USD',
      occurredAt: new Date(),
    },
  });

  check('a redelivered webhook is not double-counted', (await listUserPayments(payer)).length, 1);

  /* a failed payment must never be a route to Pro */
  const deadbeat = await newUser('deadbeat');
  await applyBillingEvent({
    type: 'payment.failed',
    userId: deadbeat,
    externalSubscriptionId: `I-${RUN}-FAIL`,
    externalEventId: `evt-${RUN}-3`,
  });

  const failedPlan = await resolvePlanForUser(deadbeat);
  check('a failed payment leaves the account on Free', failedPlan.plan.code, 'FREE');
  assertTrue('a failed payment does not grant Pro', !failedPlan.isPro);
  check('the failure is recorded', (await listUserPayments(deadbeat))[0]?.status, 'FAILED');

  /* cancellation honours time already paid for */
  await applyBillingEvent({
    type: 'subscription.canceled',
    userId: payer,
    externalSubscriptionId: `I-${RUN}-SUB`,
    externalEventId: `evt-${RUN}-4`,
  });

  const cancelled = await resolvePlanForUser(payer);
  check('cancelling keeps Pro until the period ends', cancelled.plan.code, 'PRO');
  assertTrue('cancelling flags the end of the period', cancelled.cancelAtPeriodEnd);

  /* …and the plan lapses once that period is over */
  const payerSub = await plansRepo.findSubscriptionByUser(payer);
  if (payerSub) {
    await plansRepo.updateSubscription(payerSub.subscription.id, {
      periodEnd: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
  }

  const lapsed = await resolvePlanForUser(payer);
  check('an expired period falls back to Free', lapsed.plan.code, 'FREE');
  assertTrue('an expired period revokes Pro', !lapsed.isPro);

  /* a renewal that lands after the grace period must restore Pro, not bury it */
  const straggler = await newUser('straggler');
  await applyBillingEvent({
    type: 'subscription.activated',
    userId: straggler,
    planCode: 'PRO',
    providerStatus: 'ACTIVE',
    externalSubscriptionId: `I-${RUN}-LATE`,
    periodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
    externalEventId: `evt-${RUN}-10`,
  });

  const stragglerSub = await plansRepo.findSubscriptionByUser(straggler);
  if (stragglerSub) {
    await plansRepo.updateSubscription(stragglerSub.subscription.id, {
      periodEnd: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });
  }

  check('the lapse takes effect on read', (await resolvePlanForUser(straggler)).plan.code, 'FREE');

  // The retried card finally clears. Without the paid plan surviving the lapse,
  // this event would write ACTIVE-on-FREE and strand a paying customer.
  await applyBillingEvent({
    type: 'payment.succeeded',
    externalSubscriptionId: `I-${RUN}-LATE`,
    externalEventId: `evt-${RUN}-11`,
    payment: {
      externalPaymentId: `PAY-${RUN}-LATE`,
      amountCents: 1500,
      currency: 'USD',
      occurredAt: new Date(),
    },
  });

  const restored = await resolvePlanForUser(straggler);
  check('a late renewal restores the paid plan', restored.plan.code, 'PRO');
  assertTrue('a late renewal restores Pro access', restored.isPro);

  /* an UPDATED event that PayPal does not call ACTIVE must grant nothing */
  const editor = await newUser('editor');
  await applyBillingEvent({
    type: 'payment.failed',
    userId: editor,
    externalSubscriptionId: `I-${RUN}-SUSP`,
    externalEventId: `evt-${RUN}-12`,
  });

  const updateOutcome = await applyBillingEvent({
    type: 'subscription.updated',
    userId: editor,
    planCode: 'PRO',
    providerStatus: 'SUSPENDED',
    externalSubscriptionId: `I-${RUN}-SUSP`,
    periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    externalEventId: `evt-${RUN}-13`,
  });

  check('a non-active update is ignored', updateOutcome, 'ignored');
  check(
    'editing a funding source does not grant Pro',
    (await resolvePlanForUser(editor)).plan.code,
    'FREE',
  );

  /* a sale that arrives before its activation must be retried, not dropped */
  const orphan = await applyBillingEvent({
    type: 'payment.succeeded',
    externalSubscriptionId: `I-${RUN}-UNKNOWN`,
    externalEventId: `evt-${RUN}-14`,
    payment: {
      externalPaymentId: `PAY-${RUN}-ORPHAN`,
      amountCents: 1500,
      currency: 'USD',
      occurredAt: new Date(),
    },
  });
  check('an unattributable sale asks for redelivery', orphan, 'unmatched');

  /* refunds link back through the charge they reverse */
  await applyBillingEvent({
    type: 'payment.refunded',
    relatedPaymentId: `PAY-${RUN}-1`,
    externalEventId: `evt-${RUN}-15`,
    payment: {
      externalPaymentId: `REF-${RUN}-1`,
      amountCents: 1500,
      currency: 'USD',
      occurredAt: new Date(),
    },
  });

  const afterRefund = await listUserPayments(payer);
  check(
    'a refund is matched through the original charge',
    afterRefund.some((row) => row.status === 'REFUNDED'),
    true,
  );

  /* a retried failure notice does not pile up in the history */
  const failEvent = {
    type: 'payment.failed' as const,
    userId: deadbeat,
    externalSubscriptionId: `I-${RUN}-FAIL`,
    externalEventId: `evt-${RUN}-3`,
  };
  await applyBillingEvent(failEvent);
  await applyBillingEvent(failEvent);
  check(
    'a redelivered failure is recorded once',
    (await listUserPayments(deadbeat)).filter((row) => row.status === 'FAILED').length,
    1,
  );

  const revenue = await paymentsRepo.revenueSummary();
  assertTrue('revenue reporting counts the successful charge', revenue.grossCents >= 1500);

  /* ------------------------------------------------------ owner override */
  section('owner override');

  const ownerEmail = `${RUN}-owner@example.test`;
  process.env.OWNER_EMAIL = `  ${ownerEmail.toUpperCase()}  `;
  resetEnvCache();

  const ownerId = await newUser('owner');
  const ownerPlan = await resolvePlanForUser(ownerId);

  check('the owner lands on the paid plan', ownerPlan.plan.code, 'PRO');
  assertTrue('the owner counts as Pro', ownerPlan.isPro);
  assertTrue('the owner is flagged as owner', ownerPlan.isOwner);
  check('the owner plan never expires', ownerPlan.periodEnd, null);

  // The address is matched case-insensitively and with surrounding whitespace,
  // because it is typed into a hosting panel by hand.
  assertTrue('owner matching ignores case', isOwnerEmail(ownerEmail.toUpperCase()));
  assertTrue('owner matching ignores padding', isOwnerEmail(`  ${ownerEmail}  `));
  assertTrue('a different address is not the owner', !isOwnerEmail('someone@example.test'));

  // Owner access must not come from a subscription row, and must not create one
  // that the billing system would then try to renew or cancel.
  const ownerSubscription = await plansRepo.findSubscriptionByUser(ownerId);
  check(
    'the owner has no paid subscription record',
    ownerSubscription ? ownerSubscription.plan.priceCents : 0,
    0,
  );

  await expectAppError('the owner cannot start a checkout', 'CONFLICT', () =>
    startCheckout({ userId: ownerId, planCode: 'PRO', locale: 'ar' }),
  );

  // Pro limits apply to the owner, so metering keeps working normally.
  const ownerUsage = await getSummary(ownerId);
  check('the owner gets the paid plan limits', ownerUsage.plan.code, 'PRO');
  assertTrue('the owner is unrestricted by the free project cap', ownerUsage.projects.limit !== 1);

  /* everyone else is untouched */
  const bystander = await newUser('bystander');
  const bystanderPlan = await resolvePlanForUser(bystander);
  check('other accounts stay on the free plan', bystanderPlan.plan.code, 'FREE');
  assertTrue('other accounts are not owners', !bystanderPlan.isOwner);
  assertTrue('other accounts are not Pro', !bystanderPlan.isPro);

  delete process.env.OWNER_EMAIL;
  resetEnvCache();
  check(
    'clearing OWNER_EMAIL removes the override',
    (await resolvePlanForUser(ownerId)).plan.code,
    'FREE',
  );

  /* --------------------------------------------------------------- datasets */

  section('datasets: storing, cleaning and the two kinds of delete');

  const storageRoot = await mkdtemp(join(tmpdir(), 'academic-ai-datasets-'));
  process.env.STORAGE_PROVIDER = 'local';
  process.env.STORAGE_LOCAL_DIR = storageRoot;
  resetEnvCache();
  resetStorageCache();

  const dataOwner = await newUser('data-owner');
  const dataIntruder = await newUser('data-intruder');

  const csvBody =
    'gender,score,q1,q2\n' +
    Array.from({ length: 40 }, (_, i) =>
      [i % 2 === 0 ? 'male' : 'female', 60 + ((i * 7) % 30), (i % 5) + 1, ((i * 3) % 5) + 1].join(','),
    ).join('\n') +
    '\n';

  const savedFile = await saveUpload({
    userId: dataOwner,
    file: { name: 'survey.csv', bytes: new TextEncoder().encode(csvBody).buffer as ArrayBuffer },
  });

  check('the upload is profiled on the way in', savedFile.profile.rowCount, 40);
  check('and its columns counted', savedFile.profile.columnCount, 4);
  check('it is stored as an original', savedFile.dataset.kind, 'ORIGINAL');
  check('a checksum is recorded', savedFile.dataset.checksum?.length, 64);
  assertTrue('the key is scoped to its owner', savedFile.dataset.storageKey.startsWith(`datasets/${dataOwner}/`));

  /*
   * The point of storing at all: the file is still there on a later request,
   * which is what lets a conversation refer back to "this file".
   */
  const reloaded = await loadForAnalysis(savedFile.dataset.id, dataOwner);
  check('the rows come back on a later request', reloaded.data.rows.length, 40);
  check('and the profile agrees with the stored one', reloaded.profile.columnCount, 4);

  /*
   * The check that matters most in this whole phase. Knowing an id — or a
   * storage key — must not be enough.
   */
  let crossUserBlocked = false;
  try {
    await loadForAnalysis(savedFile.dataset.id, dataIntruder);
  } catch (error) {
    crossUserBlocked = error instanceof AppError && error.code === 'NOT_FOUND';
  }
  assertTrue('another user cannot load the file by id', crossUserBlocked);

  let crossUserDeleteBlocked = false;
  try {
    await deleteFileOnly(savedFile.dataset.id, dataIntruder);
  } catch (error) {
    crossUserDeleteBlocked = error instanceof AppError;
  }
  assertTrue('nor delete it', crossUserDeleteBlocked);
  assertTrue(
    'and the file is untouched afterwards',
    (await loadForAnalysis(savedFile.dataset.id, dataOwner)).data.rows.length === 40,
  );

  /* Cleaning derives a new dataset and leaves the original exactly as it was. */
  const cleaned = await saveCleanedCopy({
    datasetId: savedFile.dataset.id,
    userId: dataOwner,
    actions: savedFile.proposals.slice(0, 1),
  });
  check('a cleaned copy is a separate dataset', cleaned.dataset.kind, 'CLEANED');
  check('linked to its parent', cleaned.dataset.parentDatasetId, savedFile.dataset.id);
  assertTrue(
    'the original is untouched by cleaning',
    (await loadForAnalysis(savedFile.dataset.id, dataOwner)).data.rows.length === 40,
  );
  assertTrue(
    'and the two occupy different objects',
    cleaned.dataset.storageKey !== savedFile.dataset.storageKey,
  );

  let doubleCleanBlocked = false;
  try {
    await saveCleanedCopy({ datasetId: cleaned.dataset.id, userId: dataOwner, actions: [] });
  } catch (error) {
    doubleCleanBlocked = error instanceof AppError;
  }
  assertTrue('a cleaned copy cannot itself be cleaned', doubleCleanBlocked);

  /* Record an analysis, then check each deletion mode against it. */
  await analysisRunsRepo.create({
    userId: dataOwner,
    datasetId: savedFile.dataset.id,
    testKey: 't.independent',
    spec: { columns: ['score', 'gender'] },
    result: { pValue: 0.03 },
  });

  const impact = await deletionImpact(savedFile.dataset.id, dataOwner);
  check('the confirmation knows how many analyses are at stake', impact.analyses, 1);
  check('and how many cleaned copies', impact.cleanedCopies, 1);

  /* Delete the file only: bytes gone, results kept. */
  await deleteFileOnly(savedFile.dataset.id, dataOwner);
  check(
    'the analyses survive deleting the file',
    (await analysisRunsRepo.listByDataset(savedFile.dataset.id, dataOwner)).length,
    1,
  );
  let readAfterDelete = false;
  try {
    await loadForAnalysis(savedFile.dataset.id, dataOwner);
  } catch {
    readAfterDelete = true;
  }
  assertTrue('but the file itself can no longer be read', readAfterDelete);

  /* Delete everything: confirmation required, then nothing is left. */
  let unconfirmedBlocked = false;
  try {
    await deleteEverything(savedFile.dataset.id, dataOwner, false);
  } catch (error) {
    unconfirmedBlocked = error instanceof AppError && error.code === 'VALIDATION';
  }
  assertTrue('deleting everything requires confirmation', unconfirmedBlocked);

  await deleteEverything(savedFile.dataset.id, dataOwner, true);
  check(
    'confirmed, the analyses go too',
    (await analysisRunsRepo.listByDataset(savedFile.dataset.id, dataOwner)).length,
    0,
  );
  check(
    'and so does the cleaned copy',
    (await datasetsRepo.findOwnedIncludingDeleted(cleaned.dataset.id, dataOwner)) === undefined,
    true,
  );

  /* Nothing is left on disk either — the bytes, not just the rows. */
  const leftovers = await readdir(join(storageRoot, 'datasets', dataOwner)).catch(() => []);
  check('no objects are left behind on disk', leftovers.length, 0);

  /* ------------------------------------------------ statistics on stored data */

  section('statistics: running tests on a stored dataset and saving the results');

  const statsOwner = await newUser('stats-owner');
  const statsIntruder = await newUser('stats-intruder');

  const statsCsv =
    'gender,score,q1,q2,q3\n' +
    [
      ['male', 82, 4, 5, 4], ['female', 74, 3, 3, 3], ['male', 88, 5, 4, 5],
      ['female', 70, 2, 2, 3], ['male', 85, 4, 4, 4], ['female', 76, 3, 4, 3],
      ['male', 90, 5, 5, 5], ['female', 72, 2, 3, 2], ['male', 84, 4, 4, 5],
      ['female', 78, 3, 3, 4], ['male', 86, 5, 4, 4], ['female', 73, 2, 2, 2],
      ['male', 81, 4, 5, 4], ['female', 77, 3, 4, 3], ['male', 89, 5, 5, 5],
      ['female', 71, 2, 2, 3], ['male', 83, 4, 4, 4], ['female', 75, 3, 3, 3],
      ['male', 87, 5, 5, 4], ['female', 79, 3, 4, 4],
    ]
      .map((row) => row.join(','))
      .join('\n') +
    '\n';

  const statsFile = await saveUpload({
    userId: statsOwner,
    file: { name: 'scores.csv', bytes: new TextEncoder().encode(statsCsv).buffer as ArrayBuffer },
  });

  /* The recommender decides which test fits, from the profiled scales. */
  const recommended = await recommend({
    datasetId: statsFile.dataset.id,
    userId: statsOwner,
    roles: [
      { column: 'score', role: 'dependent' },
      { column: 'gender', role: 'grouping' },
    ],
  });
  check('two groups and a quantitative outcome suggest a t-test', recommended.recommendation.best?.test, 't.independent');

  const tTest = await runAnalysis({
    datasetId: statsFile.dataset.id,
    userId: statsOwner,
    test: 't.independent',
    columns: { dependent: 'score', grouping: 'gender' },
  });

  check('the result is recorded against the dataset', tTest.run.datasetId, statsFile.dataset.id);
  check('with the test it ran', tTest.run.testKey, 't.independent');
  check('and Welch is the primary form', (tTest.result as { detail?: { primaryForm?: string } }).detail?.primaryForm, 'welch');
  assertTrue(
    'the p-value is real and significant',
    (tTest.result as { pValue: number }).pValue < 0.001,
  );
  assertTrue(
    'the spec records which columns were used, so the result can be reproduced',
    JSON.stringify(tTest.run.spec).includes('gender'),
  );

  /* Cronbach's alpha on the three Likert items. */
  const alphaRun = await runAnalysis({
    datasetId: statsFile.dataset.id,
    userId: statsOwner,
    test: 'reliability.cronbachAlpha',
    columns: { items: ['q1', 'q2', 'q3'] },
  });
  assertTrue(
    'alpha is computed and stored',
    typeof (alphaRun.result as { alpha?: number }).alpha === 'number',
  );

  /* A test that does not fit the data is refused rather than run. */
  let wrongTestBlocked = false;
  try {
    await runAnalysis({
      datasetId: statsFile.dataset.id,
      userId: statsOwner,
      test: 't.oneSample',
      columns: { dependent: 'score' },
    });
  } catch (error) {
    wrongTestBlocked = error instanceof AppError && error.code === 'VALIDATION';
  }
  assertTrue('a one-sample t-test without a comparison value is refused', wrongTestBlocked);

  let missingColumnBlocked = false;
  try {
    await runAnalysis({
      datasetId: statsFile.dataset.id,
      userId: statsOwner,
      test: 't.independent',
      columns: { dependent: 'not_a_column', grouping: 'gender' },
    });
  } catch (error) {
    missingColumnBlocked = error instanceof AppError;
  }
  assertTrue('a column that is not in the file is refused', missingColumnBlocked);

  /* Ownership again, this time on the analysis path. */
  let statsCrossUser = false;
  try {
    await runAnalysis({
      datasetId: statsFile.dataset.id,
      userId: statsIntruder,
      test: 't.independent',
      columns: { dependent: 'score', grouping: 'gender' },
    });
  } catch (error) {
    statsCrossUser = error instanceof AppError && error.code === 'NOT_FOUND';
  }
  assertTrue('another user cannot analyse someone else\u2019s file', statsCrossUser);

  let runCrossUser = false;
  try {
    await getRun(tTest.run.id, statsIntruder);
  } catch (error) {
    runCrossUser = error instanceof AppError && error.code === 'NOT_FOUND';
  }
  assertTrue('nor read the saved result', runCrossUser);

  /* Attaching a result to a project section — the link to the results chapter. */
  const statsProject = await createProject(statsOwner, projectInput);

  const attached = await attachRun({
    runId: tTest.run.id,
    userId: statsOwner,
    projectId: statsProject.id,
    sectionKey: 'RESULTS',
  });
  check('a result can be attached to a section', attached.sectionKey, 'RESULTS');
  check(
    'and is then findable from the project',
    (await analysisRunsRepo.listForSection(statsProject.id, statsOwner, 'RESULTS')).length,
    1,
  );

  await detachRun(tTest.run.id, statsOwner);
  check(
    'detaching removes it from the section',
    (await analysisRunsRepo.listForSection(statsProject.id, statsOwner, 'RESULTS')).length,
    0,
  );

  /* ------------------------------------------------------------ the agent */

  section('agent: routing, refusals and measurement');

  const agentOwner = await newUser('agent-owner');

  const agentFile = await saveUpload({
    userId: agentOwner,
    file: { name: 'agent.csv', bytes: new TextEncoder().encode(statsCsv).buffer as ArrayBuffer },
  });

  /*
   * The classifier is the one place a model decides anything, so it is stubbed
   * here and the rest of the orchestrator is exercised for real: real dataset,
   * real engines, real rows in `agent_tasks`. What is being tested is the
   * routing and the refusals, not the model's reading comprehension.
   */
  async function drive(
    intent: string,
    extra: Partial<Parameters<typeof runAgent>[0]> = {},
  ): Promise<AgentEvent[]> {
    setIntentStubForTests({
      intent: intent as Parameters<typeof setIntentStubForTests>[0]['intent'],
      confidence: 0.95,
      mentionedColumns: [],
      restatement: intent,
      clarifyingQuestion: null,
      usage: { tokensIn: 0, tokensOut: 0 },
    });

    const events: AgentEvent[] = [];
    for await (const event of runAgent({
      userId: agentOwner,
      message: 'test',
      locale: 'ar',
      datasetId: agentFile.dataset.id,
      ...extra,
    })) {
      events.push(event);
    }
    return events;
  }

  const kinds = (events: AgentEvent[]) => events.map((event) => event.type);

  /* A comparison, end to end: understand, plan, choose the test, compute. */
  const comparison = await drive('stats.compare', {
    roles: [
      { column: 'score', role: 'dependent' },
      { column: 'gender', role: 'grouping' },
    ],
  });

  assertTrue('the agent reports what it understood', kinds(comparison).includes('understanding'));
  assertTrue('and announces a plan before acting', kinds(comparison).includes('plan'));
  assertTrue('and streams each stage', kinds(comparison).includes('step'));
  assertTrue('and finishes', kinds(comparison).includes('done'));

  const analysisEvent = comparison.find(
    (event): event is Extract<AgentEvent, { type: 'result' }> =>
      event.type === 'result' && event.kind === 'analysis',
  );
  assertTrue('a real analysis comes back', analysisEvent !== undefined);
  assertTrue(
    'and it was saved so it can be attached to a chapter',
    Boolean(analysisEvent?.runId),
  );
  assertTrue(
    'with a p-value from the engines, not from a model',
    typeof (analysisEvent?.payload as { pValue?: number })?.pValue === 'number',
  );

  /*
   * The announced cost of an analysis is zero, and this is not a courtesy: no
   * model call produced any number in it. If this ever changes, something has
   * started asking a model to do arithmetic.
   */
  const planEvent = comparison.find(
    (event): event is Extract<AgentEvent, { type: 'plan' }> => event.type === 'plan',
  );
  check('statistical work is announced as free', planEvent?.estimatedUnits, 0);
  const doneEvent = comparison.find(
    (event): event is Extract<AgentEvent, { type: 'done' }> => event.type === 'done',
  );
  check('and charged as free', doneEvent?.units, 0);

  /* The task was measured even though nothing was enforced. */
  const measured = await agentTasksRepo.findOwned(doneEvent?.taskId as string, agentOwner);
  check('the task is recorded', measured?.kind, 'stats.compare');
  check('as completed', measured?.status, 'COMPLETED');
  assertTrue('with its stages counted', (measured?.stagesCompleted ?? 0) > 0);
  assertTrue('and its duration', (measured?.durationMs ?? -1) >= 0);

  /*
   * The refusal that matters most. PLS-SEM is understood, named, and declined —
   * not quietly turned into a regression that would produce numbers.
   */
  const plsSem = await drive('stats.plsSem');
  const unavailable = plsSem.find(
    (event): event is Extract<AgentEvent, { type: 'unavailable' }> => event.type === 'unavailable',
  );
  assertTrue('PLS-SEM is declined rather than substituted', unavailable !== undefined);
  check('by name', unavailable?.intent, 'stats.plsSem');
  assertTrue('with a reason', Boolean(unavailable?.reasonKey));
  assertTrue('and something else offered instead', (unavailable?.alternatives.length ?? 0) > 0);
  assertTrue('and no analysis is produced', !kinds(plsSem).includes('result'));

  check(
    'logistic regression is declined the same way',
    (await drive('stats.logistic')).some((event) => event.type === 'unavailable'),
    true,
  );

  /* Without confirmed roles the agent asks rather than deciding for the researcher. */
  const noRoles = await drive('stats.compare');
  assertTrue('a comparison with no roles asks instead of guessing', kinds(noRoles).includes('question'));
  assertTrue('and runs no analysis', !noRoles.some((event) => event.type === 'result' && event.kind === 'analysis'));

  /* An unclear request becomes a question, never an action. */
  const unclearRun = await drive('general.unclear');
  assertTrue('an unclear request asks for clarification', kinds(unclearRun).includes('question'));
  assertTrue('and does nothing else', !kinds(unclearRun).includes('result'));

  /* A statistics request with no file asks for one. */
  const noFile = await drive('stats.compare', { datasetId: null });
  assertTrue('a request needing data asks for a file', kinds(noFile).includes('question'));

  /* Reliability runs end to end on the Likert items. */
  const reliabilityRun = await drive('stats.reliability', {
    roles: [
      { column: 'q1', role: 'independent' },
      { column: 'q2', role: 'independent' },
      { column: 'q3', role: 'independent' },
    ],
  });
  const alphaEvent = reliabilityRun.find(
    (event): event is Extract<AgentEvent, { type: 'result' }> =>
      event.type === 'result' && event.kind === 'reliability',
  );
  assertTrue('reliability produces a coefficient', typeof (alphaEvent?.payload as { alpha?: number })?.alpha === 'number');

  clearIntentStubForTests();

  /* ------------------------------------------- results from real analyses */

  section('results chapter: written from attached analyses, not invented');

  /*
   * The end-to-end version of the guarantee. A real file, a real t-test, a real
   * row in `analysis_runs`, attached to a real project — and then the check that
   * the figures which reach the prompt are the ones the engines computed.
   */
  const chapterRun = await runAnalysis({
    datasetId: statsFile.dataset.id,
    userId: statsOwner,
    test: 't.independent',
    columns: { dependent: 'score', grouping: 'gender' },
  });

  /* Nothing attached yet: the section must still refuse to invent. */
  check(
    'an unattached analysis does not reach the chapter',
    buildResultsContext(await analysisRunsRepo.listForSection(statsProject.id, statsOwner, 'RESULTS')),
    null,
  );

  await attachRun({
    runId: chapterRun.run.id,
    userId: statsOwner,
    projectId: statsProject.id,
    sectionKey: 'RESULTS',
  });

  const attachedForChapter = await analysisRunsRepo.listForSection(
    statsProject.id,
    statsOwner,
    'RESULTS',
  );
  check('attaching makes it available to the chapter', attachedForChapter.length, 1);

  const chapterContext = buildResultsContext(attachedForChapter) ?? '';
  const computed = chapterRun.result as { statistic: { value: number }; pValue: number };

  /*
   * The figures in the prompt must be the figures the engine produced. Not
   * approximately — the same numbers, formatted once, here.
   */
  assertTrue(
    'the computed statistic reaches the prompt',
    chapterContext.includes(computed.statistic.value.toFixed(3)),
  );
  assertTrue(
    'and the computed p-value',
    chapterContext.includes(computed.pValue < 0.001 ? 'p < .001' : `p = ${computed.pValue.toFixed(3)}`),
  );
  assertTrue('the variables are named', chapterContext.includes('male'));
  assertTrue('the rules travel with the numbers', chapterContext.includes('They are facts.'));

  /*
   * Detaching restores the original behaviour exactly. This is what makes the
   * whole feature safe to ship: it adds a capability when results exist and
   * changes nothing when they do not.
   */
  await detachRun(chapterRun.run.id, statsOwner);
  check(
    'detaching returns the section to producing a template',
    buildResultsContext(await analysisRunsRepo.listForSection(statsProject.id, statsOwner, 'RESULTS')),
    null,
  );

  await rm(storageRoot, { recursive: true, force: true });
  delete process.env.STORAGE_LOCAL_DIR;
  resetEnvCache();
  resetStorageCache();

  /* --------------------------------------------------------------- cleanup */
  await db.delete(users).where(like(users.email, `${RUN}-%`));

  console.log(
    failed === 0
      ? `\n✓ ${passed} integration assertions passed\n`
      : `\n✗ ${failed} failing, ${passed} passing\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nintegration run crashed:', error);
  await db.delete(users).where(like(users.email, `${RUN}-%`)).catch(() => undefined);
  process.exit(1);
});
