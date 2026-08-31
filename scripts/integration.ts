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
import { users, analysisJobs } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { consume, resetRateLimitStore } from '@/server/http/rate-limit';
import * as adminRepo from '@/server/repositories/admin.repository';
import * as analysisRunsRepo from '@/server/repositories/analysis-runs.repository';
import * as agentTasksRepo from '@/server/repositories/agent-tasks.repository';
import * as jobsRepo from '@/server/repositories/analysis-jobs.repository';
import * as chatRepo from '@/server/repositories/chat.repository';
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
import {
  deleteConversation,
  editMessage,
  getThread,
  listRecent,
  recordTurn,
  renameConversation,
  startConversation,
  switchToBranch,
} from '@/server/services/chat.service';
import { cancelJob, getJob, runPls, startBootstrap } from '@/server/services/pls.service';
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
      searchQueries: [],
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

  /*
   * Logistic regression used to be declined here, and this assertion checked
   * that. It is built now, so what matters is the opposite: the request must
   * reach the agent rather than being refused. The refusal path is still
   * exercised above by PLS-SEM, which genuinely is not built.
   */
  const logisticRun = await drive('stats.logistic', {
    roles: [
      { column: 'gender', role: 'dependent' },
      { column: 'score', role: 'independent' },
    ],
  });
  assertTrue(
    'logistic regression is no longer declined',
    !logisticRun.some((event) => event.type === 'unavailable'),
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

  /*
   * The join that was missing: running the agent must leave a conversation
   * behind. Every layer of persistence passed its own tests while nothing
   * called it, and a refresh emptied the chat — so this drives the orchestrator
   * end to end and then reads the database.
   */
  const persistedEvents = await drive('general.question');
  const conversationEvent = persistedEvents.find(
    (event): event is Extract<AgentEvent, { type: 'conversation' }> =>
      event.type === 'conversation',
  );

  assertTrue('the agent reports which conversation this is', conversationEvent !== undefined);

  const savedThread = await getThread(conversationEvent?.conversationId as string, agentOwner);
  assertTrue('and the turn is actually stored', savedThread.messages.length >= 1);
  check('with the user\'s message first', savedThread.messages[0]?.role, 'USER');
  check('and the message text as sent', savedThread.messages[0]?.content, 'test');
  assertTrue(
    'the conversation appears in the sidebar list',
    (await listRecent(agentOwner)).some((c) => c.id === conversationEvent?.conversationId),
  );

  /* A second message joins the same thread rather than starting another. */
  const sameThread = await drive('general.question', {
    conversationId: conversationEvent?.conversationId,
  });
  const secondEvent = sameThread.find(
    (event): event is Extract<AgentEvent, { type: 'conversation' }> =>
      event.type === 'conversation',
  );
  check(
    'a follow-up stays in the same conversation',
    secondEvent?.conversationId,
    conversationEvent?.conversationId,
  );

  const grown = await getThread(conversationEvent?.conversationId as string, agentOwner);
  assertTrue('and the thread grows rather than restarting', grown.messages.length > savedThread.messages.length);

  /*
   * A structured result — an analysis, a refusal — is stored alongside the
   * prose, so reopening the conversation redraws the real table rather than a
   * description of one.
   */
  const withResult = await drive('stats.reliability', {
    roles: [
      { column: 'q1', role: 'independent' },
      { column: 'q2', role: 'independent' },
      { column: 'q3', role: 'independent' },
    ],
  });
  const resultConversation = withResult.find(
    (event): event is Extract<AgentEvent, { type: 'conversation' }> =>
      event.type === 'conversation',
  );
  const storedWithPayload = await getThread(
    resultConversation?.conversationId as string,
    agentOwner,
  );
  const assistantMessage = storedWithPayload.messages.find((message) => message.role === 'ASSISTANT');
  assertTrue(
    'a structured result is stored with the message',
    Boolean((assistantMessage?.payload as { results?: unknown[] } | null)?.results?.length),
  );

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

  /* ------------------------------------------------------ PLS-SEM as a job */

  section('PLS-SEM: estimation inline, bootstrapping in the background');

  const plsOwner = await newUser('pls-owner');
  const plsIntruder = await newUser('pls-intruder');

  /*
   * A questionnaire-shaped file: nine indicators measuring three constructs,
   * with a known structure. Written as CSV and uploaded through the ordinary
   * path so the whole chain is exercised — storage, parsing, profiling — rather
   * than the algorithm being handed a Map directly.
   */
  let plsSeed = 11;
  const plsRand = () => {
    plsSeed = (plsSeed * 1103515245 + 12345) & 0x7fffffff;
    return plsSeed / 0x7fffffff;
  };
  const plsNormal = () => {
    const u = Math.max(plsRand(), 1e-9);
    const v = plsRand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const plsRows: string[] = ['a1,a2,a3,b1,b2,b3,c1,c2,c3'];
  for (let i = 0; i < 200; i += 1) {
    const A = plsNormal();
    const B = 0.55 * A + Math.sqrt(1 - 0.3025) * plsNormal();
    const C = 0.5 * B + 0.7 * plsNormal();
    const cells: number[] = [];
    for (const latent of [A, B, C]) {
      for (let j = 0; j < 3; j += 1) cells.push(0.85 * latent + 0.5 * plsNormal());
    }
    plsRows.push(cells.map((value) => value.toFixed(4)).join(','));
  }

  const plsFile = await saveUpload({
    userId: plsOwner,
    file: {
      name: 'survey.csv',
      bytes: new TextEncoder().encode(`${plsRows.join('\n')}\n`).buffer as ArrayBuffer,
    },
  });

  const plsModelSpec = {
    constructs: [
      { name: 'A', indicators: ['a1', 'a2', 'a3'], mode: 'reflective' as const },
      { name: 'B', indicators: ['b1', 'b2', 'b3'], mode: 'reflective' as const },
      { name: 'C', indicators: ['c1', 'c2', 'c3'], mode: 'reflective' as const },
    ],
    paths: [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'A', to: 'C' },
    ],
  };

  /* Estimation runs inline and answers immediately. */
  const analysis = await runPls({
    datasetId: plsFile.dataset.id,
    userId: plsOwner,
    model: plsModelSpec,
  });

  assertTrue('the model converges on real uploaded data', analysis.converged);
  check('every construct is assessed', analysis.measurement.length, 3);
  check('and every pair gets an HTMT', analysis.discriminant.htmt.length, 3);
  check('two endogenous constructs get an R²', analysis.structural.endogenous.length, 2);
  assertTrue('the sample survives the round trip through storage', analysis.n === 200);

  /* Ownership, on the estimation path. */
  await expectAppError('another user cannot analyse this dataset', 'NOT_FOUND', () =>
    runPls({ datasetId: plsFile.dataset.id, userId: plsIntruder, model: plsModelSpec }),
  );

  /*
   * A specification error is caught before any job is created. Discovering it a
   * minute into a background run would be a minute spent to learn something
   * knowable immediately.
   */
  await expectAppError('a cyclic model is refused before the job starts', 'VALIDATION', () =>
    startBootstrap({
      datasetId: plsFile.dataset.id,
      userId: plsOwner,
      model: {
        ...plsModelSpec,
        paths: [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'A' },
        ],
      },
    }),
  );

  /* The background job: started, polled, and read. */
  const job = await startBootstrap({
    datasetId: plsFile.dataset.id,
    userId: plsOwner,
    model: plsModelSpec,
    resamples: 1000,
  });

  check('the job starts queued or running', ['QUEUED', 'RUNNING'].includes(job.status), true);

  /* Poll until it settles, as the interface will. */
  let view = await getJob(job.id, plsOwner);
  for (let attempt = 0; attempt < 120 && view.status !== 'COMPLETED' && view.status !== 'FAILED'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    view = await getJob(job.id, plsOwner);
  }

  check('the job completes', view.status, 'COMPLETED');
  check('and reports full progress', view.progress, 100);
  assertTrue('with a duration recorded', (view.durationMs ?? 0) > 0);
  assertTrue('and a bootstrap result', Boolean(view.result?.bootstrap));

  const bootstrapped = view.result?.bootstrap;
  check('every path is bootstrapped', bootstrapped?.paths.length, 3);
  assertTrue('and every loading', (bootstrapped?.loadings.length ?? 0) === 9);

  /*
   * The substantive check, surviving a full round trip through JSON and the
   * database: the path built to be zero is still not significant.
   */
  const nullPath = bootstrapped?.paths.find((path) => path.key === 'A→C');
  check('a path that is really zero stays non-significant', nullPath?.significant, false);

  const realPath = bootstrapped?.paths.find((path) => path.key === 'A→B');
  check('and a real one is significant', realPath?.significant, true);

  /* Ownership again, on the job. */
  await expectAppError('another user cannot read the job', 'NOT_FOUND', () =>
    getJob(job.id, plsIntruder),
  );

  /* A finished job cannot be cancelled — its result is already there. */
  await expectAppError('a completed job cannot be cancelled', 'VALIDATION', () =>
    cancelJob(job.id, plsOwner),
  );

  /*
   * Jobs orphaned by a restart are closed out rather than left showing a
   * progress bar that will never move.
   */
  const orphanJob = await jobsRepo.create({
    userId: plsOwner,
    datasetId: plsFile.dataset.id,
    kind: 'pls.bootstrap',
    status: 'RUNNING',
    spec: { model: plsModelSpec, resamples: 1000, confidenceLevel: 0.95, seed: 1 },
  });

  /* Backdated past the staleness window, as a restart would leave it. */
  await db
    .update(analysisJobs)
    .set({
      startedAt: new Date(Date.now() - 30 * 60_000),
      createdAt: new Date(Date.now() - 30 * 60_000),
    })
    .where(eq(analysisJobs.id, orphanJob.id));

  const cleared = await jobsRepo.failStale();
  assertTrue('a stale job is closed out', cleared >= 1);

  const orphanView = await getJob(orphanJob.id, plsOwner);
  check('and reported as failed rather than running', orphanView.status, 'FAILED');
  assertTrue('with a reason the user can act on', Boolean(orphanView.error?.ar));
  assertTrue(
    'resolved to a sentence, not a key',
    (orphanView.error?.ar ?? '').includes('إعادة تشغيل'),
  );

  await rm(storageRoot, { recursive: true, force: true });
  delete process.env.STORAGE_LOCAL_DIR;
  resetEnvCache();
  resetStorageCache();

  /* ------------------------------------------- conversation persistence */

  section('conversations: persistence, branching and deletion');

  const chatOwner = await newUser('chat-owner');
  const chatIntruder = await newUser('chat-intruder');

  const thread = await startConversation({
    userId: chatOwner,
    firstMessage: 'ما الفرق بين اختبار t وتحليل التباين؟',
  });

  /* The title comes from the first message — no model call, and no "New chat". */
  assertTrue('a conversation is titled from its first message', (thread.title ?? '').includes('اختبار t'));

  await recordTurn({
    conversationId: thread.id,
    userId: chatOwner,
    userMessage: 'ما الفرق بين اختبار t وتحليل التباين؟',
    assistantMessage: 'اختبار t يقارن مجموعتين، وتحليل التباين ثلاثًا فأكثر.',
  });

  const firstView = await getThread(thread.id, chatOwner);
  check('the turn is saved', firstView.messages.length, 2);
  check('the question comes first', firstView.messages[0]?.role, 'USER');
  check('and the answer replies to it', firstView.messages[1]?.parentMessageId, firstView.messages[0]?.id);
  check('an unedited thread has no forks', firstView.branchPoints.length, 0);

  await recordTurn({
    conversationId: thread.id,
    userId: chatOwner,
    userMessage: 'ومتى أستخدم Welch؟',
    assistantMessage: 'حين لا تتساوى التباينات.',
  });

  const fourMessages = await getThread(thread.id, chatOwner);
  check('a second turn extends the same thread', fourMessages.messages.length, 4);
  assertTrue(
    'and each message hangs off the one before it',
    fourMessages.messages[3]?.parentMessageId === fourMessages.messages[2]?.id,
  );

  /*
   * The operation the tree exists for. Editing the second question must not
   * destroy the answer that followed it — that answer is still there on an
   * inactive branch, and a user who preferred it can go back.
   */
  const edited = await editMessage({
    conversationId: thread.id,
    userId: chatOwner,
    messageId: fourMessages.messages[2]?.id as string,
    content: 'ومتى أستخدم مان-ويتني؟',
  });

  const afterEdit = await getThread(thread.id, chatOwner);
  check('the edited thread shows the new question', afterEdit.messages.length, 3);
  check('and it is the new text', afterEdit.messages[2]?.content, 'ومتى أستخدم مان-ويتني؟');
  assertTrue('marked as edited', afterEdit.messages[2]?.editedAt !== null);
  check('the edit hangs off the same parent as the original', edited.parentMessageId, afterEdit.messages[1]?.id);

  /*
   * Nothing was deleted. Five messages exist; three are on the active path.
   * This is the difference between editing a message and losing the
   * conversation that came after it.
   */
  const everything = await chatRepo.allMessages(thread.id);
  check('the original question and its answer still exist', everything.length, 5);
  check('but two of them are off the active path', everything.filter((m) => !m.isActive).length, 2);

  check('the fork is reported to the interface', afterEdit.branchPoints.length, 1);

  /* And the user can go back to what they had. */
  const restoredThread = await switchToBranch(
    thread.id,
    chatOwner,
    fourMessages.messages[2]?.id as string,
  );
  check('switching back restores the original question', restoredThread.messages[2]?.content, 'ومتى أستخدم Welch؟');

  /*
   * What the interface needs to offer "1 of 2": not just where the fork is, but
   * which version is showing and what its neighbours are. Computing this on the
   * client would mean reconstructing tree traversal there, where it can drift
   * from the server's.
   */
  /*
   * The thread is on the *first* version here — the assertions above stepped
   * back to it deliberately. Reading the fork fresh rather than reusing an
   * earlier view: a branch point describes the thread as it stands, and an
   * earlier snapshot describes a state that has since been navigated away from.
   */
  const forked = await getThread(thread.id, chatOwner);
  check('the fork is reported once', forked.branchPoints.length, 1);

  const point = forked.branchPoints[0];
  check('with two versions', point?.total, 2);
  check('showing the original, which is where the previous step left it', point?.index, 0);
  check('and both siblings listed', point?.siblingIds.length, 2);
  assertTrue(
    'the fork names the message currently on the active path',
    point?.messageId === forked.messages[2]?.id,
  );

  /* Forward to the edit, by id from the sibling list. */
  const forward = await switchToBranch(thread.id, chatOwner, point?.siblingIds[1] as string);
  check('stepping forward shows the edit', forward.messages[2]?.content, 'ومتى أستخدم مان-ويتني؟');
  check('and the position updates', forward.branchPoints[0]?.index, 1);

  /* And back again — navigation has to work in both directions. */
  const backward = await switchToBranch(thread.id, chatOwner, point?.siblingIds[0] as string);
  check('stepping back returns to the original', backward.messages[2]?.content, 'ومتى أستخدم Welch؟');
  check('and the position follows', backward.branchPoints[0]?.index, 0);
  check('with the sibling count unchanged', backward.branchPoints[0]?.total, 2);

  /* A thread nobody edited reports no forks at all. */
  const untouched = await startConversation({ userId: chatOwner, firstMessage: 'بلا تعديل' });
  await recordTurn({
    conversationId: untouched.id,
    userId: chatOwner,
    userMessage: 'بلا تعديل',
    assistantMessage: 'جواب.',
  });
  check('an unedited thread has no forks', (await getThread(untouched.id, chatOwner)).branchPoints.length, 0);

  /* Only the user's own messages. An assistant reply is a record of what was said. */
  let editAssistantBlocked = false;
  try {
    await editMessage({
      conversationId: thread.id,
      userId: chatOwner,
      messageId: firstView.messages[1]?.id as string,
      content: 'something else',
    });
  } catch (error) {
    editAssistantBlocked = error instanceof AppError && error.code === 'VALIDATION';
  }
  assertTrue('an assistant reply cannot be rewritten', editAssistantBlocked);

  /* Ownership, on every path into a conversation. */
  let threadCrossUser = false;
  try {
    await getThread(thread.id, chatIntruder);
  } catch (error) {
    threadCrossUser = error instanceof AppError && error.code === 'NOT_FOUND';
  }
  assertTrue('another user cannot read the thread', threadCrossUser);

  let renameCrossUser = false;
  try {
    await renameConversation(thread.id, chatIntruder, 'mine now');
  } catch (error) {
    renameCrossUser = error instanceof AppError;
  }
  assertTrue('nor rename it', renameCrossUser);

  /* The sidebar list. */
  const second = await startConversation({ userId: chatOwner, firstMessage: 'سؤال آخر' });
  await recordTurn({
    conversationId: second.id,
    userId: chatOwner,
    userMessage: 'سؤال آخر',
    assistantMessage: 'جواب.',
  });

  /*
   * Three: the main thread, the untouched one used for the no-forks check, and
   * this second one. Counting them explicitly rather than asserting a bare
   * number keeps the test honest when another conversation is added above.
   */
  const recent = await listRecent(chatOwner);
  check('every conversation appears in the sidebar', recent.length, 3);
  check('newest first', recent[0]?.id, second.id);
  check('and another user sees none of them', (await listRecent(chatIntruder)).length, 0);

  await renameConversation(thread.id, chatOwner, 'مقارنة الاختبارات');
  check(
    'renaming works',
    (await listRecent(chatOwner)).find((c) => c.id === thread.id)?.title,
    'مقارنة الاختبارات',
  );

  /* Deleting hides without destroying, and can be undone. */
  await deleteConversation(second.id, chatOwner);
  check('a deleted conversation leaves the list', (await listRecent(chatOwner)).length, 2);
  check(
    'but its messages are still there',
    (await chatRepo.allMessages(second.id)).length,
    2,
  );
  await chatRepo.unarchive(second.id, chatOwner);
  check('and it can be restored', (await listRecent(chatOwner)).length, 3);

  /* A permanent purge is a separate, deliberate act. */
  await deleteConversation(second.id, chatOwner, true);
  check('purging removes the messages too', (await chatRepo.allMessages(second.id)).length, 0);

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
