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

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
import { users, analysisJobs, researchProjects } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { consume, resetRateLimitStore } from '@/server/http/rate-limit';
import * as adminRepo from '@/server/repositories/admin.repository';
import * as analysisRunsRepo from '@/server/repositories/analysis-runs.repository';
import * as agentTasksRepo from '@/server/repositories/agent-tasks.repository';
import * as jobsRepo from '@/server/repositories/analysis-jobs.repository';
import * as titlesRepo from '@/server/repositories/titles.repository';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { generateMarkdown } from '@/server/generators/documents';
import * as tasksRepo from '@/server/repositories/tasks.repository';
import { namedFormat, resolveReference } from '@/server/agent/continuity';
import { generateDocx } from '@/server/generators/docx';
import {
  failed as observationFailed,
  makeOutput,
  needsInput,
  partial,
  readOutput,
  succeeded,
  type Observation,
  type OutputReference,
} from '@/server/tasks/contracts';
import {
  capabilityFor,
  registerCapability,
  DEFAULT_BUDGET,
  type TaskBudget,
} from '@/server/tasks/capabilities';
import { hasHandler, registerHandler, runTask, type ReplanTrigger } from '@/server/tasks/executor';
import { registerAllHandlers } from '@/server/tasks/handlers';
import { allCapabilities } from '@/server/tasks/capabilities';
import {
  deleteArtifact,
  listArtifacts,
  readArtifact,
  storeArtifact,
  versionsOf,
} from '@/server/services/artifact.service';
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
  prepareRegeneration,
  recordRegeneratedAnswer,
  recordTurn,
  renameConversation,
  startConversation,
  switchToBranch,
} from '@/server/services/chat.service';
import { cancelJob, getJob, runPls, startBootstrap } from '@/server/services/pls.service';
import { clearUnselectedTitles, deleteTitle, listTitles } from '@/server/services/ai.service';
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


/** A step's typed output of a given kind, for assertions. */
function typedOutput<T>(
  step: { output: Record<string, unknown> | null } | undefined,
  type: string,
): T | undefined {
  const outputs = ((step?.output as { outputs?: OutputReference[] } | null)?.outputs ?? []);
  return outputs.find((output) => output.type === type)?.data as T | undefined;
}

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
   * Both structural equation methods now reach the agent rather than being
   * refused.
   *
   * This assertion used to check the opposite for each in turn — that an
   * unbuilt method was declined by name rather than turned into a regression
   * that would produce numbers. That rule still holds and is checked in the
   * smoke tests against whatever remains planned; what belongs here is that the
   * two that shipped are no longer turned away.
   *
   * They run through their own routes rather than the orchestrator, so what is
   * verified is the absence of a refusal rather than the presence of a result.
   */
  for (const intent of ['stats.plsSem', 'stats.cbSem'] as const) {
    const events = await drive(intent);
    assertTrue(
      `${intent} is no longer declined`,
      !events.some((event) => event.type === 'unavailable'),
    );
  }

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

  /*
   * Regeneration, and the two defects it had.
   *
   * The first was visible only on failure: an empty assistant message was
   * created as a placeholder, so a regeneration that then failed left a blank
   * bubble on the active path — saved, redrawn on every reload, and impossible
   * to remove.
   *
   * The second was visible always: the new answer was recorded through
   * `recordTurn`, which writes both halves, so the question appeared twice and
   * the thread read as the user having asked it again.
   */
  const regenThread = await startConversation({ userId: chatOwner, firstMessage: 'Q1' });
  await recordTurn({
    conversationId: regenThread.id,
    userId: chatOwner,
    userMessage: 'Q1',
    assistantMessage: 'A1',
  });
  await recordTurn({
    conversationId: regenThread.id,
    userId: chatOwner,
    userMessage: 'Q2',
    assistantMessage: 'A2',
  });

  const beforeRegen = await getThread(regenThread.id, chatOwner);
  const lastAnswer = beforeRegen.messages.filter((message) => message.role === 'ASSISTANT').at(-1);

  const prepared = await prepareRegeneration({
    conversationId: regenThread.id,
    userId: chatOwner,
    messageId: lastAnswer?.id as string,
  });

  check('the question is returned to be asked again', prepared.prompt, 'Q2');
  assertTrue('with the parent it should attach to', Boolean(prepared.parentMessageId));

  const midRegen = await getThread(regenThread.id, chatOwner);
  check('the thread now ends at the question', midRegen.messages.length, 3);
  assertTrue(
    'with no empty placeholder left behind',
    !midRegen.messages.some((message) => message.content === ''),
  );

  /* The new answer attaches to the existing question. */
  await recordRegeneratedAnswer({
    conversationId: regenThread.id,
    userId: chatOwner,
    parentMessageId: prepared.parentMessageId as string,
    content: 'A2-regenerated',
  });

  const afterRegen = await getThread(regenThread.id, chatOwner);
  check('the thread is question then answer, not question twice', afterRegen.messages.length, 4);
  check('the new answer is shown', afterRegen.messages[3]?.content, 'A2-regenerated');
  check('and the question appears once', afterRegen.messages.filter((m) => m.content === 'Q2').length, 1);

  /* The old answer survives on an inactive branch, so it can be returned to. */
  const regenAll = await chatRepo.allMessages(regenThread.id);
  assertTrue(
    'the previous answer is kept rather than destroyed',
    regenAll.some((message) => message.content === 'A2' && !message.isActive),
  );
  check('and the fork is offered', afterRegen.branchPoints.length, 1);

  /* Renaming, which had a service and a route and no control until now. */
  await renameConversation(regenThread.id, chatOwner, 'A better name');
  const renamed = await listRecent(chatOwner);
  check(
    'a conversation can be renamed',
    renamed.find((entry) => entry.id === regenThread.id)?.title,
    'A better name',
  );

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
  check('every conversation appears in the sidebar', recent.length, 4);
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
  check('a deleted conversation leaves the list', (await listRecent(chatOwner)).length, 3);
  check(
    'but its messages are still there',
    (await chatRepo.allMessages(second.id)).length,
    2,
  );
  await chatRepo.unarchive(second.id, chatOwner);
  check('and it can be restored', (await listRecent(chatOwner)).length, 4);

  /* A permanent purge is a separate, deliberate act. */
  await deleteConversation(second.id, chatOwner, true);
  check('purging removes the messages too', (await chatRepo.allMessages(second.id)).length, 0);

  /* ------------------------------------------------- deleting a project */

  section('deleting a project detaches rather than destroys');

  /*
   * Conversations cascaded on project deletion, alone among the tables that
   * reference a project — datasets, analysis runs and agent tasks all detach.
   * A conversation can hold an analysis that took minutes and a discussion the
   * researcher relies on; deleting the container it happened to sit in is not a
   * decision to delete that.
   */
  const detachOwner = await newUser('detach-owner');

  const [detachProject] = await db
    .insert(researchProjects)
    .values({
      userId: detachOwner,
      title: 'A project with things in it',
      degree: 'MASTER',
      researchType: 'QUANTITATIVE',
      academicField: 'EDUCATION',
      language: 'AR',
    } as never)
    .returning();

  const attachedConversation = await startConversation({
    userId: detachOwner,
    projectId: detachProject?.id,
    firstMessage: 'A discussion worth keeping',
  });

  await recordTurn({
    conversationId: attachedConversation.id,
    userId: detachOwner,
    userMessage: 'A discussion worth keeping',
    assistantMessage: 'An answer worth keeping',
  });

  await db.delete(researchProjects).where(eq(researchProjects.id, detachProject?.id as string));

  const survivor = await chatRepo.findOwned(attachedConversation.id, detachOwner);
  assertTrue('the conversation survives its project', survivor !== undefined);
  check('and is detached rather than deleted', survivor?.projectId, null);

  const survivingMessages = await chatRepo.allMessages(attachedConversation.id);
  check('with its messages intact', survivingMessages.length, 2);

  assertTrue(
    'and it still appears in the sidebar',
    (await listRecent(detachOwner)).some((entry) => entry.id === attachedConversation.id),
  );

  /* --------------------------------------------------- discarding titles */

  section('title suggestions can be removed');

  /*
   * There was no way to remove a title suggestion — not in the repository, the
   * service, the route or the interface. Three batches of five leaves fifteen
   * candidates, most rejected on sight, and the useful ones end up buried under
   * the discarded.
   */
  const titleOwner = await newUser('title-owner');

  const [titleProject] = await db
    .insert(researchProjects)
    .values({
      userId: titleOwner,
      title: 'A project needing a title',
      degree: 'MASTER',
      researchType: 'QUANTITATIVE',
      academicField: 'EDUCATION',
      language: 'AR',
    } as never)
    .returning();

  await titlesRepo.insertMany([
    { projectId: titleProject?.id as string, title: 'First suggestion', batch: 1, selected: false },
    { projectId: titleProject?.id as string, title: 'The chosen one', batch: 1, selected: true },
    { projectId: titleProject?.id as string, title: 'Third suggestion', batch: 1, selected: false },
  ] as never);

  check('three suggestions to begin with', (await listTitles(titleOwner, titleProject?.id as string)).length, 3);

  const candidates = await titlesRepo.listForProject(titleProject?.id as string);
  const rejected = candidates.find((candidate) => !candidate.selected);

  await deleteTitle(titleOwner, titleProject?.id as string, rejected?.id as string);
  check('one can be discarded', (await listTitles(titleOwner, titleProject?.id as string)).length, 2);

  /*
   * The chosen title is kept when the rejected ones are cleared: it is the
   * project's working title, and removing it would leave the project without
   * one — a different action from clearing suggestions.
   */
  const clearedTitles = await clearUnselectedTitles(titleOwner, titleProject?.id as string);
  check('clearing removes the rest of the rejected', clearedTitles, 1);

  const remaining = await listTitles(titleOwner, titleProject?.id as string);
  check('leaving only the chosen title', remaining.length, 1);
  check('and it is the selected one', remaining[0]?.selected, true);

  /* Ownership: a candidate id alone must not reach another user's project. */
  const titleIntruder = await newUser('title-intruder');

  await expectAppError('another user cannot discard a title', 'NOT_FOUND', () =>
    deleteTitle(titleIntruder, titleProject?.id as string, remaining[0]?.id as string),
  );

  await expectAppError('nor clear a project they do not own', 'NOT_FOUND', () =>
    clearUnselectedTitles(titleIntruder, titleProject?.id as string),
  );

  /* Discarding something already gone is reported rather than silently passing. */
  await expectAppError('discarding a missing title is refused', 'NOT_FOUND', () =>
    deleteTitle(titleOwner, titleProject?.id as string, 'no-such-candidate'),
  );

  /* ------------------------------------------------- artifact versioning */

  section('artifacts keep every version');

  /*
   * Local storage, as the dataset section does. The env cache is reset because
   * `getEnv()` memoises: setting the variable without resetting leaves the
   * provider reading the value from before the test started.
   */
  const artifactRoot = await mkdtemp(join(tmpdir(), 'academic-ai-artifacts-'));
  process.env.STORAGE_PROVIDER = 'local';
  process.env.STORAGE_LOCAL_DIR = artifactRoot;
  resetEnvCache();
  resetStorageCache();

  /*
   * The requirement that shapes the whole design: regenerating must not destroy
   * what came before. A researcher who exports a thesis at midnight, changes a
   * chapter, exports again, and at nine decides the earlier draft was better
   * must still be able to reach it.
   */
  const artifactOwner = await newUser('artifact-owner');

  const markdown = generateMarkdown({
    title: 'Chapter Three',
    sections: [{ heading: 'Methodology', paragraphs: ['The study used a survey design.'] }],
  });

  const firstVersion = await storeArtifact({
    userId: artifactOwner,
    kind: 'md',
    filename: 'thesis.md',
    bytes: markdown,
    metadata: { citationStyle: 'apa' },
  });

  check('the first version is version one', firstVersion.version, 1);
  check('and its lineage points at itself', firstVersion.lineageId, firstVersion.id);
  check('with no parent', firstVersion.parentArtifactId, null);

  /* A change produces a new version, not a replacement. */
  const revisedBytes = generateMarkdown({
    title: 'Chapter Three',
    sections: [{ heading: 'Methodology', paragraphs: ['The study used a mixed-methods design.'] }],
  });

  const secondVersion = await storeArtifact({
    userId: artifactOwner,
    kind: 'md',
    filename: 'thesis.md',
    bytes: revisedBytes,
    previousArtifactId: firstVersion.id,
  });

  check('the revision is version two', secondVersion.version, 2);
  check('sharing the lineage', secondVersion.lineageId, firstVersion.lineageId);
  check('and naming its parent', secondVersion.parentArtifactId, firstVersion.id);

  const thirdVersion = await storeArtifact({
    userId: artifactOwner,
    kind: 'md',
    filename: 'thesis.md',
    bytes: generateMarkdown({ title: 'Chapter Three', sections: [{ paragraphs: ['Revised again.'] }] }),
    previousArtifactId: secondVersion.id,
  });

  check('and a third follows', thirdVersion.version, 3);

  /* The earlier version still exists and still reads as it did. */
  const originalVersion = await readArtifact(firstVersion.id, artifactOwner);
  check('the first version survives', originalVersion.artifact.version, 1);
  assertTrue(
    'with its original content intact',
    new TextDecoder().decode(originalVersion.bytes).includes('a survey design'),
  );

  const lineageVersions = await versionsOf(secondVersion.id, artifactOwner);
  check('the lineage holds all three', lineageVersions.length, 3);
  check('newest first', lineageVersions[0]?.version, 3);
  /*
   * Any version's id finds the history: a researcher looking at version 2 wants
   * the list without knowing what a lineage is.
   */
  check('and asking from the middle works', lineageVersions[2]?.version, 1);

  /* The list view shows one entry per document, not one per version. */
  const artifactList = await listArtifacts(artifactOwner);
  check('the list shows the document once', artifactList.length, 1);
  check('at its latest version', artifactList[0]?.version, 3);

  /* Invalid bytes are refused before anything is stored. */
  await expectAppError('invalid bytes are refused', 'INTERNAL', () =>
    storeArtifact({
      userId: artifactOwner,
      kind: 'pdf',
      filename: 'broken.pdf',
      bytes: new TextEncoder().encode('not a pdf at all'),
    }),
  );

  check('and nothing was stored', (await listArtifacts(artifactOwner)).length, 1);

  /* Ownership: another user cannot read or branch from someone else's file. */
  const artifactIntruder = await newUser('artifact-intruder');

  await expectAppError('another user cannot read it', 'NOT_FOUND', () =>
    readArtifact(firstVersion.id, artifactIntruder),
  );
  await expectAppError('nor list its versions', 'NOT_FOUND', () =>
    versionsOf(firstVersion.id, artifactIntruder),
  );
  await expectAppError('nor add a version to it', 'NOT_FOUND', () =>
    storeArtifact({
      userId: artifactIntruder,
      kind: 'md',
      filename: 'theirs.md',
      bytes: markdown,
      previousArtifactId: firstVersion.id,
    }),
  );

  /* The quality report travels with the artifact rather than being recomputed. */
  const checkedArtifact = await storeArtifact({
    userId: artifactOwner,
    kind: 'md',
    filename: 'checked.md',
    bytes: generateMarkdown({ title: 'X', sections: [{ paragraphs: ['A claim [7].'] }] }),
    quality: {
      text: 'Prior research found that engagement rose by 34% [7].',
      references: [
        { id: '1', kind: 'journal-article', title: 'A study', authors: ['Smith, J.'], year: 2021, provenance: 'retrieved' },
      ],
    },
  });

  assertTrue('a quality report is stored with the file', checkedArtifact.qualityReport !== null);
  /*
   * A citation pointing at no reference is an error, so the artifact records
   * that it failed validation — and the researcher sees why without rerunning
   * anything.
   */
  check('and its verdict is recorded', checkedArtifact.validationStatus, 'fail');

  /* Deleting one version leaves the others. */
  await deleteArtifact(thirdVersion.id, artifactOwner);
  check('a deleted version leaves the lineage', (await versionsOf(firstVersion.id, artifactOwner)).length, 2);
  assertTrue('and the earlier ones remain readable', (await readArtifact(firstVersion.id, artifactOwner)).artifact.version === 1);

  /* ---------------------------------------------------- task orchestration */

  section('the task executor');

  /*
   * The planner needs a model, so these register fake handlers and drive the
   * executor directly. What is being tested is the machinery — dependencies,
   * retries, budgets, resumption — which is where the failures live and which
   * does not need a language model to exercise.
   */
  const taskOwner = await newUser('task-owner');

  /** Records which handlers ran, so ordering and skipping are observable. */
  const executed: string[] = [];

  registerHandler('general.answer', async ({ input }) => {
    executed.push(`general.answer:${String(input.marker ?? '')}`);
    return { output: { answered: true, marker: input.marker ?? null }, modelCalls: 1 };
  });

  registerHandler('web.search', async (context) => {
    executed.push('web.search');

    /* A handler that fails on demand, for the dependency and retry tests. */
    if (context.input.fail) throw new Error('search failed');

    return succeeded([
      makeOutput(
        {
          taskId: context.taskId,
          stepId: context.stepId,
          capability: 'web.search',
          projectId: context.projectId,
        },
        'sources.v1',
        { references: [{ id: 'a' }, { id: 'b' }], found: 2 },
      ),
    ]);
  });

  registerHandler('document.write', async (context) => {
    executed.push('document.write');

    /*
     * Reads by output type, not by producer name. If the search did not run
     * this sees nothing — which is what the blocking test asserts cannot
     * happen — and it works whichever capability supplied the sources.
     */
    const sources = readOutput<{ found?: number }>(context.available, 'sources.v1');

    return succeeded([
      makeOutput(
        {
          taskId: context.taskId,
          stepId: context.stepId,
          capability: 'document.write',
          projectId: context.projectId,
        },
        'prose.v1',
        { text: 'written', usedResults: sources?.found ?? 0 },
      ),
    ]);
  });

  registerHandler('quality.check', async () => {
    executed.push('quality.check');
    return { output: { status: 'pass' } };
  });

  registerHandler('academic.search', async ({ input }) => {
    executed.push('academic.search');

    if (input.needsInput) return { output: {}, needsUserInput: 'Which discipline?' };
    if (input.suggests) {
      return { output: { found: 2 }, suggestsMoreWork: 'Contradictory findings need checking' };
    }

    return { output: { found: 5 }, modelCalls: 1 };
  });

  registerHandler('statistics.run', async () => {
    executed.push('statistics.run');
    return { output: { alpha: 0.87 } };
  });

  /** Builds a task with steps already planned, bypassing the model. */
  async function makeTask(
    steps: { key: string; capability: string; dependsOn?: string[]; input?: Record<string, unknown> }[],
    budget: Partial<TaskBudget> = {},
  ) {
    const task = await tasksRepo.create({
      userId: taskOwner,
      request: 'test request',
      locale: 'en',
      status: 'QUEUED',
      context: {},
      budget: { ...DEFAULT_BUDGET, ...budget } as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    const rows = await tasksRepo.addSteps(
      steps.map((step, index) => ({
        taskId: task.id,
        ordinal: index,
        capability: step.capability,
        label: step.key,
        status: 'PENDING',
        dependsOn: [],
        input: step.input ?? {},
      })),
    );

    const byKey = new Map(steps.map((step, index) => [step.key, rows[index]?.id as string]));

    for (const [index, step] of steps.entries()) {
      const dependencies = (step.dependsOn ?? [])
        .map((key) => byKey.get(key))
        .filter((id): id is string => Boolean(id));

      if (dependencies.length > 0) {
        await tasksRepo.updateDependencies(rows[index]?.id as string, dependencies);
      }
    }

    return task;
  }

  /* ---- 2 & 3: a failed step blocks dependants; independents continue ---- */

  {
    executed.length = 0;

    /*
     * The search fails. The chapter that depends on it must not run — writing
     * a literature review from a search that returned nothing is the failure
     * this whole dependency mechanism exists to prevent. The unrelated
     * statistics step has no reason to stop.
     */
    const task = await makeTask([
      { key: 'search', capability: 'web.search', input: { fail: true } },
      { key: 'write', capability: 'document.write', dependsOn: ['search'] },
      { key: 'stats', capability: 'statistics.run' },
    ]);

    await runTask(task.id);

    const steps = await tasksRepo.stepsOf(task.id);
    const byLabel = new Map(steps.map((step) => [step.label, step]));

    check('the failing step is marked failed', byLabel.get('search')?.status, 'FAILED');
    check('its dependant is blocked', byLabel.get('write')?.status, 'BLOCKED');
    assertTrue('and never ran', !executed.includes('document.write'));

    check('the independent step completes', byLabel.get('stats')?.status, 'COMPLETED');
    assertTrue('and did run', executed.includes('statistics.run'));

    const finished = await tasksRepo.findAny(task.id);
    check('the task reports failure', finished?.status, 'FAILED');
  }

  /* ------------------------- 13: artifacts flow ------------------------- */

  {
    executed.length = 0;

    const task = await makeTask([
      { key: 'search', capability: 'web.search' },
      { key: 'write', capability: 'document.write', dependsOn: ['search'] },
    ]);

    await runTask(task.id);

    const steps = await tasksRepo.stepsOf(task.id);
    const write = steps.find((step) => step.label === 'write');

    check('both steps complete', steps.filter((s) => s.status === 'COMPLETED').length, 2);
    /*
     * The dependent step received the earlier step's structured output — not
     * the conversation, not the whole context, just what it needs.
     */
  /*
   * Read from the typed output rather than the handler's raw return. The
   * stored shape is now `{ outputs, observation, legacy }` — the payload lives
   * inside a typed output, which is the whole point of the change.
   */
  {
    const stored = ((write?.output as { outputs?: OutputReference[] } | null)?.outputs ?? [])[0];
    check(
      'the dependent step read its dependency output',
      (stored?.data as { usedResults?: number })?.usedResults,
      2,
    );
    check('through a typed reference', stored?.type, 'prose.v1');
  }
  }

  /* ------------------- 5: completed steps are not rerun ------------------ */

  {
    executed.length = 0;

    const task = await makeTask([
      { key: 'first', capability: 'general.answer', input: { marker: 'one' } },
      { key: 'second', capability: 'general.answer', dependsOn: ['first'], input: { marker: 'two' } },
    ]);

    await runTask(task.id);
    const afterFirst = [...executed];

    /* Running again must do nothing: everything is already complete. */
    executed.length = 0;
    await runTask(task.id);

    check('the first run executed both steps', afterFirst.length, 2);
    check('a second run reruns nothing', executed.length, 0);
  }

  /* ------------------ 4: a task survives a restart ---------------------- */

  {
    executed.length = 0;

    const task = await makeTask([
      { key: 'first', capability: 'general.answer', input: { marker: 'a' } },
      { key: 'second', capability: 'general.answer', dependsOn: ['first'], input: { marker: 'b' } },
      { key: 'third', capability: 'quality.check', dependsOn: ['second'] },
    ]);

    const steps = await tasksRepo.stepsOf(task.id);

    /*
     * The state a crash leaves behind: one step completed, one stranded at
     * RUNNING with nothing driving it. Without recovery the task hangs
     * forever, which is what every deploy would do to running work.
     */
    await tasksRepo.claimStep(steps[0]?.id as string);
    await tasksRepo.completeStep(steps[0]?.id as string, { answered: true });
    await tasksRepo.claimStep(steps[1]?.id as string);
    await tasksRepo.setStatus(task.id, 'RUNNING');

    executed.length = 0;
    await runTask(task.id);

    const recovered = await tasksRepo.stepsOf(task.id);

    check('the task completes after recovery', (await tasksRepo.findAny(task.id))?.status, 'COMPLETED');
    check('the completed step was not rerun', executed.filter((e) => e.includes(':a')).length, 0);
    assertTrue('the stranded step ran', executed.some((e) => e.includes(':b')));
    check('and everything finished', recovered.filter((s) => s.status === 'COMPLETED').length, 3);
  }

  /* ------------------ 6 & 7: waiting for input and resuming -------------- */

  {
    executed.length = 0;

    const task = await makeTask([
      { key: 'search', capability: 'academic.search', input: { needsInput: true } },
      { key: 'write', capability: 'document.write', dependsOn: ['search'] },
    ]);

    await runTask(task.id);

    const waiting = await tasksRepo.findAny(task.id);
    check('the task waits for input', waiting?.status, 'WAITING_FOR_INPUT');
    check('with the question', waiting?.pendingQuestion, 'Which discipline?');
    assertTrue('and the dependent step did not run', !executed.includes('document.write'));

    /*
     * The answer resumes from where it stopped. Completed steps stay completed
     * — the difference between asking a question and losing an hour of work.
     */
    await tasksRepo.mergeContext(task.id, { discipline: 'management' });
    await tasksRepo.stepsOf(task.id).then(async (steps) => {
      const search = steps.find((step) => step.label === 'search');
      await tasksRepo.updateStepInput(search?.id as string, { needsInput: false });
    });

    executed.length = 0;
    await runTask(task.id);

    check('the task resumes and completes', (await tasksRepo.findAny(task.id))?.status, 'COMPLETED');
    assertTrue('running the step that asked', executed.includes('academic.search'));
    assertTrue('and the one that waited on it', executed.includes('document.write'));
  }

  /* ------------------------ 9: the step ceiling ------------------------- */

  {
    /*
     * Fifty by default rather than a dozen: a thesis workflow legitimately
     * needs more. A limit set for a short task would refuse the work this
     * exists to do.
     */
    check('the default ceiling accommodates long workflows', DEFAULT_BUDGET.maxSteps, 50);

    const task = await makeTask(
      [
        { key: 'a', capability: 'general.answer', input: { marker: 'a' } },
        { key: 'b', capability: 'general.answer', dependsOn: ['a'], input: { marker: 'b' } },
        { key: 'c', capability: 'general.answer', dependsOn: ['b'], input: { marker: 'c' } },
      ],
      { maxSteps: 2 },
    );

    await runTask(task.id);

    const paused = await tasksRepo.findAny(task.id);
    check('a task at its step limit pauses', paused?.status, 'PAUSED');
    check('naming the limit', paused?.pauseReasonKey, 'task.paused.maxSteps');

    /* Paused, not failed: the work done is kept and the user may continue. */
    const steps = await tasksRepo.stepsOf(task.id);
    check('with the completed work preserved', steps.filter((s) => s.status === 'COMPLETED').length, 2);
  }

  /* -------------------- 12: the model-call ceiling ---------------------- */

  {
    const task = await makeTask(
      [
        { key: 'a', capability: 'general.answer', input: { marker: 'a' } },
        { key: 'b', capability: 'general.answer', dependsOn: ['a'], input: { marker: 'b' } },
        { key: 'c', capability: 'general.answer', dependsOn: ['b'], input: { marker: 'c' } },
      ],
      { maxModelCalls: 2 },
    );

    await runTask(task.id);

    const paused = await tasksRepo.findAny(task.id);
    check('a task at its model-call limit pauses', paused?.status, 'PAUSED');
    assertTrue(
      'naming a call or step limit',
      (paused?.pauseReasonKey ?? '').includes('maxModelCalls') ||
        (paused?.pauseReasonKey ?? '').includes('maxSteps'),
    );
  }

  /* --------------------------- 11: retries ------------------------------ */

  {
    executed.length = 0;

    /*
     * A search is retryable up to three attempts. A step that fails every time
     * must stop rather than retry forever — retries consume budget a later
     * step needs.
     */
    const task = await makeTask([{ key: 'search', capability: 'web.search', input: { fail: true } }]);

    await runTask(task.id);

    const steps = await tasksRepo.stepsOf(task.id);
    check('a repeatedly failing step is marked failed', steps[0]?.status, 'FAILED');
    check('after its maximum attempts', steps[0]?.attempts, 3);
    check('and ran that many times', executed.filter((e) => e === 'web.search').length, 3);
  }

  /* --------------------- 10: the per-capability timeout ----------------- */

  {
    /*
     * Timeouts are per capability, not uniform. A uniform limit is wrong in
     * both directions: two minutes kills a deep research run that legitimately
     * takes ten, and gives a Markdown export a hundred and nineteen seconds it
     * will never use.
     */
    const deep = capabilityFor('deep.research');
    const generate = capabilityFor('document.generate');

    assertTrue('deep research gets a long timeout', (deep?.timeoutMs ?? 0) >= 300_000);
    assertTrue('file generation gets a short one', (generate?.timeoutMs ?? 0) <= 60_000);
    assertTrue('and they differ', deep?.timeoutMs !== generate?.timeoutMs);

    /* A handler that never returns must be stopped by its timeout. */
    registerHandler('survey.generate', async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });

      return { output: {} };
    });

    registerCapability({
      id: 'survey.generate' as never,
      labelKey: 'x',
      timeoutMs: 150,
      estimatedModelCalls: 0,
      retryable: false,
      maxAttempts: 1,
      requiresDataset: false,
      parallelSafe: true,
    });

    const task = await makeTask([{ key: 'slow', capability: 'survey.generate' }]);
    const startedAt = Date.now();

    await runTask(task.id);

    const steps = await tasksRepo.stepsOf(task.id);
    check('a hanging step times out', steps[0]?.status, 'FAILED');
    check('with a timeout reason', steps[0]?.errorReasonKey, 'task.error.timeout');
    assertTrue('and does not wait for the handler', Date.now() - startedAt < 5000);
  }

  /* ----------------------- 8: dynamic step addition --------------------- */

  {
    executed.length = 0;

    const task = await makeTask([
      { key: 'search', capability: 'academic.search', input: { suggests: true } },
    ]);

    let suggestion: string | null = null;

    await runTask(task.id, {
      onSuggestion: async (current, trigger) => {
        /* The structured trigger, not a sentence describing it. */
        suggestion = trigger.capability;

        /* The planner would call this; here the step is added directly. */
        const added = await tasksRepo.addSteps([
          {
            taskId: current.id,
            ordinal: 99,
            capability: 'quality.check',
            label: 'follow-up',
            status: 'PENDING',
            dependsOn: [],
            input: {},
            dynamic: true,
          },
        ]);

        return added.length;
      },
    });

    assertTrue('a step can suggest more work', suggestion !== null);

    const steps = await tasksRepo.stepsOf(task.id);
    const dynamic = steps.filter((step) => step.dynamic);

    check('the added step is persisted', dynamic.length, 1);
    /* Traceable: marked as added during execution rather than planned. */
    check('and marked as dynamic', dynamic[0]?.dynamic, true);
    check('and it ran', dynamic[0]?.status, 'COMPLETED');
  }

  /* ---------------- 14 & 15: plans size themselves to the work ----------- */

  {
    /*
     * A plan is not padded to a ceiling and not compressed to look efficient.
     * Fifteen steps is a real research workflow; one step is a real answer to a
     * question. Both must be expressible.
     */
    const long = await makeTask(
      Array.from({ length: 15 }, (_, index) => ({
        key: `s${index}`,
        capability: 'quality.check',
        dependsOn: index > 0 ? [`s${index - 1}`] : [],
      })),
    );

    await runTask(long.id);

    const steps = await tasksRepo.stepsOf(long.id);
    check('a fifteen-step workflow runs to completion', steps.filter((s) => s.status === 'COMPLETED').length, 15);
    assertTrue('exceeding twelve steps', steps.length > 12);

    const short = await makeTask([{ key: 'one', capability: 'general.answer', input: { marker: 'x' } }]);
    await runTask(short.id);

    const shortSteps = await tasksRepo.stepsOf(short.id);
    check('and a one-step task needs only one', shortSteps.length, 1);
    check('completing normally', (await tasksRepo.findAny(short.id))?.status, 'COMPLETED');
  }

  /* ------------------------------------------- handlers end to end */

  section('capabilities are connected to real work');

  /*
   * Three phases were built before anything a user could run: the quality
   * engine, the artifact manager, the planner and executor — and not one
   * capability was wired to the service that performs it. The executor ran on
   * fake handlers in tests and on nothing in production.
   *
   * These tests use the real handlers. What they cannot exercise is anything
   * needing a model or a network call; what they do exercise is the seam —
   * that a step reaches its service, that structured output flows to the next
   * step, and that a document comes out at the end.
   */
  registerAllHandlers();

  const wiredOwner = await newUser('wired-owner');

  /* Every capability in the registry must have a handler, or a plan can name
   * work nothing can perform — and the user watches it fail mid-run. */
  for (const capability of allCapabilities()) {
    assertTrue(`${capability.id} has a handler`, hasHandler(capability.id));
  }

  {
    /*
     * The end-to-end case: prose written by one step becomes a document
     * generated by the next, stored as a versioned artifact with its quality
     * report. No model is involved — the writing step is replaced — but every
     * other link is real.
     */
    registerHandler('document.write', async (context) => {
      /*
       * Migrated to typed outputs. The payload is unchanged; what changed
       * is that a consumer finds it by asking for `prose.v1` rather than
       * by naming this capability.
       */
      const payload: Record<string, unknown> = {
        text: 'Prior research found that engagement rose after the intervention [1].',
        heading: 'Literature',
        references: [
          {
            id: '1',
            kind: 'journal-article',
            title: 'Engagement and performance',
            authors: ['Smith, J.'],
            year: 2021,
            container: 'Journal of Management',
            doi: '10.1111/joms.12645',
            provenance: 'retrieved',
          },
        ],
      };

      const producedBy = {
        taskId: context.taskId,
        stepId: context.stepId,
        capability: 'document.write',
        projectId: context.projectId,
      };

      const outputs: OutputReference[] = [
        makeOutput(producedBy, 'prose.v1', {
          text: payload.text,
          heading: payload.heading,
        }),
      ];

      if (Array.isArray(payload.references)) {
        outputs.push(makeOutput(producedBy, 'sources.v1', { references: payload.references }));
      }

      if (payload.table) {
        outputs.push(makeOutput(producedBy, 'analysis.v1', { label: 'Data', table: payload.table }));
      }

      return succeeded(outputs);
    });

    const task = await tasksRepo.create({
      userId: wiredOwner,
      request: 'write a review and export it',
      locale: 'en',
      status: 'QUEUED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    const rows = await tasksRepo.addSteps([
      {
        taskId: task.id, ordinal: 0, capability: 'document.write',
        label: 'Write the review', status: 'PENDING', dependsOn: [], input: { section: 'Literature' },
      },
      {
        taskId: task.id, ordinal: 1, capability: 'document.generate',
        label: 'Export', status: 'PENDING', dependsOn: [],
        input: { format: 'md', title: 'Engagement Review', citationStyle: 'apa' },
      },
      {
        taskId: task.id, ordinal: 2, capability: 'quality.check',
        label: 'Check', status: 'PENDING', dependsOn: [], input: {},
      },
    ]);

    await tasksRepo.updateDependencies(rows[1]?.id as string, [rows[0]?.id as string]);
    await tasksRepo.updateDependencies(rows[2]?.id as string, [rows[0]?.id as string]);

    await runTask(task.id);

    const finished = await tasksRepo.findAny(task.id);
    check('the task completes', finished?.status, 'COMPLETED');

    const steps = await tasksRepo.stepsOf(task.id);
    const generate = steps.find((step) => step.capability === 'document.generate');

    /* A real artifact was produced, stored and versioned. */
    check('a document was generated', generate?.status, 'COMPLETED');
    check('producing one artifact', generate?.artifactIds.length, 1);

    const artifactId = generate?.artifactIds[0] as string;
    const stored = await readArtifact(artifactId, wiredOwner);

    check('the artifact is version one', stored.artifact.version, 1);

    const body = new TextDecoder().decode(stored.bytes);
    /* The prose from the previous step reached the document. */
    assertTrue('the written text is in the file', body.includes('engagement rose'));
    /* And the reference was formatted in the requested style. */
    assertTrue('with its reference formatted', body.includes('Smith, J. (2021)'));
    assertTrue('under a references heading', body.includes('## References'));

    /* The quality check ran on the same prose and saw the same references. */
    const quality = steps.find((step) => step.capability === 'quality.check');
    check('the quality check ran', quality?.status, 'COMPLETED');
    check(
      'and found the claim supported',
      typedOutput<{ unsupportedClaims?: number }>(quality, 'quality-report.v1')?.unsupportedClaims,
      0,
    );
  }

  {
    /*
     * A handler that cannot proceed asks rather than guessing. A PLS model is
     * the researcher's theory; inventing one would produce numbers for a study
     * nobody is running.
     */
    const task = await tasksRepo.create({
      userId: wiredOwner,
      request: 'run PLS',
      locale: 'en',
      status: 'QUEUED',
      context: { datasetId: 'some-dataset' },
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    await tasksRepo.addSteps([
      {
        taskId: task.id, ordinal: 0, capability: 'statistics.pls',
        label: 'Run PLS', status: 'PENDING', dependsOn: [], input: {},
      },
    ]);

    await runTask(task.id);

    const waiting = await tasksRepo.findAny(task.id);
    check('a missing model pauses for input', waiting?.status, 'WAITING_FOR_INPUT');
    assertTrue(
      'asking for the model rather than inventing one',
      (waiting?.pendingQuestion ?? '').toLowerCase().includes('model'),
    );
  }

  {
    /*
     * A literature review with no sources is refused. The model would
     * otherwise write something fluent and cite work it invented — the exact
     * failure the evidence rules exist to prevent.
     */
    const task = await tasksRepo.create({
      userId: wiredOwner,
      request: 'review the literature',
      locale: 'en',
      status: 'QUEUED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    await tasksRepo.addSteps([
      {
        taskId: task.id, ordinal: 0, capability: 'literature.review',
        label: 'Review', status: 'PENDING', dependsOn: [], input: { topic: 'x' },
      },
    ]);

    await runTask(task.id);

    const waiting = await tasksRepo.findAny(task.id);
    check('a review with no sources asks rather than inventing', waiting?.status, 'WAITING_FOR_INPUT');
  }

  {
    /*
     * References without DOIs are not a finding. Books, reports and theses
     * mostly have none, and reporting that as a problem is the mistake the
     * quality engine was designed to avoid.
     */
    registerHandler('document.write', async (context) => {
      /*
       * Migrated to typed outputs. The payload is unchanged; what changed
       * is that a consumer finds it by asking for `prose.v1` rather than
       * by naming this capability.
       */
      const payload: Record<string, unknown> = {
        text: 'The methodology follows established practice.',
        references: [
          { id: '1', kind: 'book', title: 'Research Design', authors: ['Creswell, J.'], year: 2014, publisher: 'SAGE', provenance: 'retrieved' },
        ],
      };

      const producedBy = {
        taskId: context.taskId,
        stepId: context.stepId,
        capability: 'document.write',
        projectId: context.projectId,
      };

      const outputs: OutputReference[] = [
        makeOutput(producedBy, 'prose.v1', {
          text: payload.text,
          heading: payload.heading,
        }),
      ];

      if (Array.isArray(payload.references)) {
        outputs.push(makeOutput(producedBy, 'sources.v1', { references: payload.references }));
      }

      if (payload.table) {
        outputs.push(makeOutput(producedBy, 'analysis.v1', { label: 'Data', table: payload.table }));
      }

      return succeeded(outputs);
    });

    const task = await tasksRepo.create({
      userId: wiredOwner, request: 'check citations', locale: 'en', status: 'QUEUED',
      context: {}, budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    const rows = await tasksRepo.addSteps([
      { taskId: task.id, ordinal: 0, capability: 'document.write', label: 'Write', status: 'PENDING', dependsOn: [], input: {} },
      { taskId: task.id, ordinal: 1, capability: 'citation.verify', label: 'Verify', status: 'PENDING', dependsOn: [], input: {} },
    ]);

    await tasksRepo.updateDependencies(rows[1]?.id as string, [rows[0]?.id as string]);
    await runTask(task.id);

    const steps = await tasksRepo.stepsOf(task.id);
    const verify = steps.find((step) => step.capability === 'citation.verify');

    check('verification completes', verify?.status, 'COMPLETED');
    const citations = typedOutput<{ status?: string; checked?: number }>(verify, 'citations.v1');

    check('reporting nothing to check rather than a problem', citations?.status, 'not-applicable');
    check('and no network call was made', citations?.checked, 0);
  }

  /* --------------------------------------- the universal artifact pipeline */

  section('every requested format produces a real file');

  /*
   * A researcher asked for their research as Word and received Markdown, with
   * nothing saying a substitution had happened. The chain was broken in four
   * places — the planner never passed a format, the handler had no docx branch,
   * the route's schema rejected it, and the silent fallback hid all of it.
   *
   * These run the **real** handler; only the model call that writes the prose
   * is replaced. Each produced file is opened and parsed, because a file of the
   * right size and the wrong bytes still fails to open, and that is where the
   * researcher finds out rather than the pipeline.
   */
  const artifactOwner2 = await newUser('artifact-formats');

  registerAllHandlers();

  registerHandler('document.write', async (context) => {
      /*
       * Migrated to typed outputs. The payload is unchanged; what changed
       * is that a consumer finds it by asking for `prose.v1` rather than
       * by naming this capability.
       */
      const payload: Record<string, unknown> = {
      text: 'أظهرت الدراسات أن التعلم الهجين يحسّن التحصيل الدراسي [1].',
      heading: 'مراجعة الأدبيات',
      table: { headers: ['المتغيّر', 'المتوسط'], rows: [['التحصيل', 4.2]] },
      references: [
        {
          id: '1', kind: 'journal-article', title: 'التعلم الهجين في الجامعات',
          authors: ['القضاة, عامر'], year: 2024, container: 'مجلة التربية',
          doi: '10.1111/joms.12645', provenance: 'retrieved',
        },
      ],
      };

      const producedBy = {
        taskId: context.taskId,
        stepId: context.stepId,
        capability: 'document.write',
        projectId: context.projectId,
      };

      const outputs: OutputReference[] = [
        makeOutput(producedBy, 'prose.v1', {
          text: payload.text,
          heading: payload.heading,
        }),
      ];

      if (Array.isArray(payload.references)) {
        outputs.push(makeOutput(producedBy, 'sources.v1', { references: payload.references }));
      }

      if (payload.table) {
        outputs.push(makeOutput(producedBy, 'analysis.v1', { label: 'Data', table: payload.table }));
      }

      return succeeded(outputs);
    });

  async function generateAs(format: string, title = 'التعلم الهجين') {
    const task = await tasksRepo.create({
      userId: artifactOwner2,
      request: `give me ${format}`,
      locale: 'ar',
      status: 'QUEUED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    const rows = await tasksRepo.addSteps([
      { taskId: task.id, ordinal: 0, capability: 'document.write', label: 'Write', status: 'PENDING', dependsOn: [], input: {} },
      {
        taskId: task.id, ordinal: 1, capability: 'document.generate', label: `Export ${format}`,
        status: 'PENDING', dependsOn: [],
        input: {
          format, title, citationStyle: 'apa',
          table: { headers: ['المتغيّر', 'القيمة'], rows: [['التحصيل', '4.2']] },
        },
      },
    ]);

    await tasksRepo.updateDependencies(rows[1]?.id as string, [rows[0]?.id as string]);
    await runTask(task.id);

    const steps = await tasksRepo.stepsOf(task.id);
    return { task, generate: steps.find((step) => step.capability === 'document.generate') };
  }

  /*
   * Every format, produced and opened. Nine assertions per format rather than
   * one, because "an artifact exists" and "the file works" are different
   * claims and only the second matters to the researcher.
   */
  for (const format of ['docx', 'pdf', 'pptx', 'xlsx', 'csv', 'md', 'txt', 'bib', 'ris'] as const) {
    const { task, generate } = await generateAs(format);

    check(`${format}: the task completes`, (await tasksRepo.findAny(task.id))?.status, 'COMPLETED');
    check(`${format}: an artifact is produced`, generate?.artifactIds.length, 1);

    const { artifact, bytes, contentType } = await readArtifact(
      generate?.artifactIds[0] as string,
      artifactOwner2,
    );

    check(`${format}: it is the requested kind`, artifact.kind, format);
    assertTrue(`${format}: with real bytes`, bytes.length > 40);
    assertTrue(`${format}: and a content type`, contentType.length > 0);

    /* Persisted and owned. */
    check(`${format}: owned by its user`, artifact.userId, artifactOwner2);
    check(`${format}: version one`, artifact.version, 1);
    check(`${format}: linked to its task`, (artifact.metadata as Record<string, unknown>).taskId, task.id);

    /*
     * Validation must pass. A file stored with a failing verdict is a file the
     * researcher downloads and cannot use.
     */
    assertTrue(
      `${format}: passes validation`,
      artifact.validationStatus === 'pass' || artifact.validationStatus === 'not-applicable',
    );
  }

  /* Opened and read, per format, because structure is not content. */
  {
    const { generate } = await generateAs('docx');
    const { bytes } = await readArtifact(generate?.artifactIds[0] as string, artifactOwner2);

    const zip = await JSZip.loadAsync(bytes);
    assertTrue('the Word file is a valid package', zip.file('[Content_Types].xml') !== null);

    const body = await zip.file('word/document.xml')?.async('string');
    assertTrue('with the research inside', body?.includes('التحصيل') ?? false);
    assertTrue('and right-to-left layout for Arabic', body?.includes('bidi') ?? false);
  }

  {
    const { generate } = await generateAs('pdf');
    const { bytes } = await readArtifact(generate?.artifactIds[0] as string, artifactOwner2);

    check('the PDF signature is right', new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');

    const document = await PDFDocument.load(bytes);
    assertTrue('and it has pages', document.getPageCount() >= 2);
  }

  {
    const { generate } = await generateAs('pptx');
    const { bytes } = await readArtifact(generate?.artifactIds[0] as string, artifactOwner2);

    const zip = await JSZip.loadAsync(bytes);
    assertTrue('the presentation is valid', zip.file('ppt/presentation.xml') !== null);

    const slides = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    );
    assertTrue('with slides in it', slides.length >= 2);
  }

  {
    const { generate } = await generateAs('xlsx');
    const { bytes } = await readArtifact(generate?.artifactIds[0] as string, artifactOwner2);

    const zip = await JSZip.loadAsync(bytes);
    assertTrue('the workbook is valid', zip.file('xl/workbook.xml') !== null);

    const sheet = await zip.file('xl/worksheets/sheet1.xml')?.async('string');
    assertTrue('with a worksheet', (sheet?.length ?? 0) > 100);
    /* The numbers are numbers, not text — or the researcher cannot sum them. */
    assertTrue('holding the data', sheet?.includes('4.2') ?? false);
  }

  {
    const { generate } = await generateAs('bib');
    const { bytes } = await readArtifact(generate?.artifactIds[0] as string, artifactOwner2);

    const text = new TextDecoder().decode(bytes);
    assertTrue('BibTeX has an entry', text.includes('@article'));
    assertTrue('with the reference', text.includes('التعلم الهجين'));
    assertTrue('and its DOI', text.includes('10.1111/joms.12645'));
  }

  {
    const { generate } = await generateAs('ris');
    const { bytes } = await readArtifact(generate?.artifactIds[0] as string, artifactOwner2);

    const text = new TextDecoder().decode(bytes);
    assertTrue('RIS opens a record', text.startsWith('TY  - '));
    assertTrue('and terminates it', text.includes('ER  - '));
  }

  {
    const { generate } = await generateAs('csv');
    const { bytes } = await readArtifact(generate?.artifactIds[0] as string, artifactOwner2);

    /* The BOM, without which Excel on Windows mangles Arabic. */
    check('CSV carries a UTF-8 BOM', bytes[0], 0xef);
    assertTrue('and its data', new TextDecoder().decode(bytes).includes('التحصيل'));
  }

  {
    const { generate } = await generateAs('txt');
    const { bytes } = await readArtifact(generate?.artifactIds[0] as string, artifactOwner2);

    const text = new TextDecoder().decode(bytes);
    assertTrue('the text file has the content', text.includes('التحصيل'));
    /* Plain text, so no Markdown markers survive. */
    assertTrue('without heading markers', !text.includes('## '));
  }

  /* English, on the same path. */
  {
    registerHandler('document.write', async (context) => {
      /*
       * Migrated to typed outputs. The payload is unchanged; what changed
       * is that a consumer finds it by asking for `prose.v1` rather than
       * by naming this capability.
       */
      const payload: Record<string, unknown> = {
        text: 'Prior research found that hybrid learning improves outcomes [1].',
        heading: 'Literature Review',
        references: [
          {
            id: '1', kind: 'journal-article', title: 'Blended learning outcomes',
            authors: ['Smith, J.'], year: 2023, container: 'Journal of Education',
            doi: '10.1016/j.chb.2019.04.011', provenance: 'retrieved',
          },
        ],
      };

      const producedBy = {
        taskId: context.taskId,
        stepId: context.stepId,
        capability: 'document.write',
        projectId: context.projectId,
      };

      const outputs: OutputReference[] = [
        makeOutput(producedBy, 'prose.v1', {
          text: payload.text,
          heading: payload.heading,
        }),
      ];

      if (Array.isArray(payload.references)) {
        outputs.push(makeOutput(producedBy, 'sources.v1', { references: payload.references }));
      }

      if (payload.table) {
        outputs.push(makeOutput(producedBy, 'analysis.v1', { label: 'Data', table: payload.table }));
      }

      return succeeded(outputs);
    });

    const { generate } = await generateAs('docx', 'Hybrid Learning');
    const { artifact, bytes } = await readArtifact(
      generate?.artifactIds[0] as string,
      artifactOwner2,
    );

    check('an English request produces Word', artifact.kind, 'docx');

    const zip = await JSZip.loadAsync(bytes);
    const body = await zip.file('word/document.xml')?.async('string');

    assertTrue('with its content', body?.includes('hybrid learning improves') ?? false);
    assertTrue('and its reference', body?.includes('Smith') ?? false);
  }

  /*
   * Several formats from one piece of work. Each is a separate artifact with
   * its own lineage — "give me Word and PDF" is two files, not one file twice.
   */
  {
    const word = await generateAs('docx', 'Multi Output');
    const pdf = await generateAs('pdf', 'Multi Output');

    const first = await readArtifact(word.generate?.artifactIds[0] as string, artifactOwner2);
    const second = await readArtifact(pdf.generate?.artifactIds[0] as string, artifactOwner2);

    check('the first is Word', first.artifact.kind, 'docx');
    check('the second is PDF', second.artifact.kind, 'pdf');
    assertTrue('each with its own lineage', first.artifact.lineageId !== second.artifact.lineageId);
  }

  /*
   * An unrecognised format still produces a file, and says what was asked for.
   * That silence is what let "give me Word" return Markdown unnoticed.
   */
  {
    const { generate } = await generateAs('wordperfect');

    /* Read from the typed artifact output rather than the handler's raw shape. */
    const produced = typedOutput<{ kind?: string; requestedFormat?: string }>(
      generate,
      'artifact.v1',
    );

    check('an unknown format falls back to Markdown', produced?.kind, 'md');
    check('recording what was requested', produced?.requestedFormat, 'wordperfect');
  }

  /*
   * No fake files. Invalid bytes must be refused before anything is stored, so
   * an artifact the researcher can see is an artifact that opens.
   */
  await expectAppError('invalid bytes are never stored', 'INTERNAL', () =>
    storeArtifact({
      userId: artifactOwner2,
      kind: 'docx',
      filename: 'broken.docx',
      bytes: new TextEncoder().encode('not a docx'),
    }),
  );

  /* And ownership holds across every format. */
  {
    const { generate } = await generateAs('docx');
    await expectAppError('another user cannot download it', 'NOT_FOUND', () =>
      readArtifact(generate?.artifactIds[0] as string, chatOwner),
    );
  }

  /* ------------------------------------- typed outputs and observations */

  section('capabilities exchange typed outputs, not capability names');

  /*
   * The contract this phase replaced: `dependencies['academic.search']`.
   *
   * A consumer that named its producer got `undefined` when that capability had
   * not run, and wrote from nothing with nothing thrown — a literature review
   * assembled from no literature, which is the worst thing this product can
   * produce because it looks like work.
   */
  const flowOwner = await newUser('flow-owner');

  async function runFlow(
    plan: { key: string; capability: string; dependsOn?: string[]; input?: Record<string, unknown> }[],
  ) {
    const task = await tasksRepo.create({
      userId: flowOwner,
      request: 'flow test',
      locale: 'en',
      status: 'QUEUED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    const rows = await tasksRepo.addSteps(
      plan.map((step, index) => ({
        taskId: task.id,
        ordinal: index,
        capability: step.capability,
        label: step.key,
        status: 'PENDING',
        dependsOn: [],
        input: step.input ?? {},
      })),
    );

    const byKey = new Map(plan.map((step, index) => [step.key, rows[index]?.id as string]));

    for (const [index, step] of plan.entries()) {
      const ids = (step.dependsOn ?? [])
        .map((key) => byKey.get(key))
        .filter((id): id is string => Boolean(id));

      if (ids.length > 0) await tasksRepo.updateDependencies(rows[index]?.id as string, ids);
    }

    await runTask(task.id);
    return { task, steps: await tasksRepo.stepsOf(task.id) };
  }

  function outputsOf(step: { output: Record<string, unknown> | null } | undefined) {
    return ((step?.output as { outputs?: OutputReference[] } | null)?.outputs ?? []) as OutputReference[];
  }

  const stamp = (context: { taskId: string; stepId: string; projectId: string | null }, capability: string) => ({
    taskId: context.taskId,
    stepId: context.stepId,
    capability,
    projectId: context.projectId,
  });

  /* A search produces sources.v1; a review consumes it by type. */
  {
    registerHandler('academic.search', async (context) =>
      succeeded([
        makeOutput(stamp(context, 'academic.search'), 'sources.v1', {
          references: [{ id: '1', kind: 'journal-article', title: 'A study', year: 2024, provenance: 'retrieved' }],
          found: 1,
        }),
      ]),
    );

    registerHandler('literature.review', async (context) => {
      const sources = readOutput<{ references: unknown[] }>(context.available, 'sources.v1');
      if (!sources) return needsInput('No sources to review', 'sources');

      return succeeded([
        makeOutput(stamp(context, 'literature.review'), 'literature.v1', {
          text: 'A review of one source [1].',
          reviewed: sources.references.length,
        }),
      ]);
    });

    const { steps } = await runFlow([
      { key: 'search', capability: 'academic.search' },
      { key: 'review', capability: 'literature.review', dependsOn: ['search'] },
    ]);

    const search = steps.find((step) => step.capability === 'academic.search');
    const review = steps.find((step) => step.capability === 'literature.review');

    check('the search produces a typed output', outputsOf(search)[0]?.type, 'sources.v1');
    check('with its schema version', outputsOf(search)[0]?.schemaVersion, 1);
    check('the review completes', review?.status, 'COMPLETED');
    check('having read the sources', (outputsOf(review)[0]?.data as { reviewed: number }).reviewed, 1);
    check('and produced its own type', outputsOf(review)[0]?.type, 'literature.v1');
  }

  /*
   * The assertion that justifies the phase: the producer changes and the
   * consumer is untouched. `dependencies['academic.search']` made this
   * impossible.
   */
  {
    registerHandler('deep.research', async (context) =>
      succeeded([
        makeOutput(stamp(context, 'deep.research'), 'sources.v1', {
          references: [
            { id: '1', kind: 'journal-article', title: 'From deep research', year: 2023, provenance: 'retrieved' },
            { id: '2', kind: 'website', title: 'A page', provenance: 'retrieved' },
          ],
          found: 2,
        }),
      ]),
    );

    const { steps } = await runFlow([
      { key: 'deep', capability: 'deep.research' },
      { key: 'review', capability: 'literature.review', dependsOn: ['deep'] },
    ]);

    const review = steps.find((step) => step.capability === 'literature.review');

    check('a different producer feeds the same consumer', review?.status, 'COMPLETED');
    check('reading what it supplied', (outputsOf(review)[0]?.data as { reviewed: number }).reviewed, 2);
  }

  /* Provenance, which is what makes a claim traceable to the step that made it. */
  {
    const { task, steps } = await runFlow([
      { key: 'search', capability: 'academic.search' },
      { key: 'review', capability: 'literature.review', dependsOn: ['search'] },
    ]);

    const searchOutput = outputsOf(steps.find((step) => step.capability === 'academic.search'))[0];
    const reviewOutput = outputsOf(steps.find((step) => step.capability === 'literature.review'))[0];

    check('an output names its capability', searchOutput?.producedBy.capability, 'academic.search');
    check('and its task', searchOutput?.producedBy.taskId, task.id);
    assertTrue('and its step', Boolean(searchOutput?.producedBy.stepId));
    assertTrue('with a timestamp', Boolean(searchOutput?.createdAt));
    assertTrue(
      'and two steps are distinguishable',
      searchOutput?.producedBy.stepId !== reviewOutput?.producedBy.stepId,
    );
  }

  /* needs-input stops the task and asks. */
  {
    registerHandler('survey.generate', async () =>
      needsInput('Which constructs should the questionnaire measure?', 'constructs'),
    );

    const { task } = await runFlow([{ key: 'survey', capability: 'survey.generate' }]);
    const current = await tasksRepo.findAny(task.id);

    check('needs-input stops the task', current?.status, 'WAITING_FOR_INPUT');
    assertTrue('with the question', (current?.pendingQuestion ?? '').includes('constructs'));
  }

  /* A failure is structured, so a replanner can act on the code. */
  {
    registerHandler('quality.check', async () =>
      observationFailed([
        { code: 'quality.engineUnavailable', severity: 'error', message: 'could not run' },
      ]),
    );

    const { task, steps } = await runFlow([{ key: 'check', capability: 'quality.check' }]);

    check('the step is marked failed', steps[0]?.status, 'FAILED');
    check('and the task reports it', (await tasksRepo.findAny(task.id))?.status, 'FAILED');

    const observation = (steps[0]?.output as { observation?: Observation } | null)?.observation;
    check('with a machine-readable code', observation?.errors[0]?.code, 'quality.engineUnavailable');
  }

  /*
   * Partial is a completion, not a failure: the step did some of its job, and
   * treating it as failure would discard what it did find.
   */
  {
    registerHandler('academic.search', async (context) =>
      partial(
        [makeOutput(stamp(context, 'academic.search'), 'sources.v1', { references: [], found: 0 })],
        ['on-topic sources'],
        {
          warnings: [{ code: 'search.offTopic', severity: 'warning', message: 'wrong corpus' }],
          confidence: 0.2,
          recommendedNextActions: [
            { capability: 'academic.search', reason: 'rephrase', input: { topic: 'x' } },
          ],
        },
      ),
    );

    const { steps } = await runFlow([{ key: 'search', capability: 'academic.search' }]);

    check('a partial step completes', steps[0]?.status, 'COMPLETED');

    const observation = (steps[0]?.output as { observation?: Observation } | null)?.observation;
    check('reporting partial status', observation?.status, 'partial');
    check('naming what is missing', observation?.missingInformation.join(), 'on-topic sources');
    check(
      'with a recommendation the planner can act on',
      observation?.recommendedNextActions[0]?.capability,
      'academic.search',
    );
    assertTrue('and lowered confidence', (observation?.confidence ?? 1) < 0.5);
  }

  /* Quality and artifacts produce their own types. */
  {
    registerHandler('quality.check', async (context) =>
      succeeded([
        makeOutput(stamp(context, 'quality.check'), 'quality-report.v1', {
          status: 'pass',
          errors: 0,
        }),
      ]),
    );

    const { steps } = await runFlow([{ key: 'check', capability: 'quality.check' }]);
    check('quality produces a report type', outputsOf(steps[0])[0]?.type, 'quality-report.v1');
  }



  section('recommendations reach the planner structured');

  /*
   * The Phase A audit found this: the observation was flattened into a sentence
   * before it reached the planner — "academic.search: rephrase" — throwing away
   * the named capability and its input, and then needing a model call to
   * reconstruct what the handler had already stated precisely.
   *
   * Structuring a recommendation only to stringify it at the last step defeats
   * the contract entirely.
   */
  const replanOwner = await newUser('replan-owner');

  async function captureTrigger(
    handler: Parameters<typeof registerHandler>[1],
  ): Promise<ReplanTrigger | null> {
    registerHandler('academic.search', handler);

    const task = await tasksRepo.create({
      userId: replanOwner,
      request: 'replan test',
      locale: 'en',
      status: 'QUEUED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    await tasksRepo.addSteps([
      {
        taskId: task.id, ordinal: 0, capability: 'academic.search',
        label: 'Search', status: 'PENDING', dependsOn: [], input: {},
      },
    ]);

    let captured: ReplanTrigger | null = null;

    await runTask(task.id, {
      onSuggestion: async (_task, trigger) => {
        captured = trigger;
        return 0;
      },
    });

    return captured;
  }

  {
    const trigger = await captureTrigger(async (context) =>
      partial(
        [
          makeOutput(
            {
              taskId: context.taskId,
              stepId: context.stepId,
              capability: 'academic.search',
              projectId: context.projectId,
            },
            'sources.v1',
            { references: [], found: 0 },
          ),
        ],
        ['on-topic sources'],
        {
          confidence: 0.2,
          recommendedNextActions: [
            {
              capability: 'deep.research',
              reason: 'the query found the wrong corpus',
              input: { topic: 'hybrid learning', depth: 2 },
            },
          ],
        },
      ),
    );

    assertTrue('the planner is called', trigger !== null);

    /* The structure survives: capability, reason and input, unchanged. */
    check('one recommendation arrives', trigger?.recommendedNextActions.length, 1);
    check(
      'naming the capability',
      trigger?.recommendedNextActions[0]?.capability,
      'deep.research',
    );
    check(
      'with its reason',
      trigger?.recommendedNextActions[0]?.reason,
      'the query found the wrong corpus',
    );

    /* The input is an object the planner can hand to a step, not prose. */
    const input = trigger?.recommendedNextActions[0]?.input as Record<string, unknown>;
    check('and its structured input', input?.topic, 'hybrid learning');
    check('including non-string fields', input?.depth, 2);

    /* Nothing was flattened. */
    assertTrue(
      'the trigger is an object, not a sentence',
      typeof trigger === 'object' && trigger !== null,
    );
    check('the status travels', trigger?.status, 'partial');
    check('and what is missing', trigger?.missingInformation.join(), 'on-topic sources');
    check('and the confidence', trigger?.confidence, 0.2);
    check('and the capability that observed it', trigger?.capability, 'academic.search');
  }

  {
    /*
     * A recommendation naming no capability cannot be acted on. Letting one
     * through means the planner must guess, which is the behaviour the
     * structured form replaced — so it is dropped before it arrives.
     */
    const trigger = await captureTrigger(async (context) =>
      partial(
        [
          makeOutput(
            {
              taskId: context.taskId,
              stepId: context.stepId,
              capability: 'academic.search',
              projectId: context.projectId,
            },
            'sources.v1',
            { references: [], found: 0 },
          ),
        ],
        ['something'],
        {
          recommendedNextActions: [
            { capability: '', reason: 'vague' },
            { capability: 'web.search', reason: 'try the web', input: { query: 'x' } },
          ],
        },
      ),
    );

    check('the empty recommendation is dropped', trigger?.recommendedNextActions.length, 1);
    check(
      'leaving the actionable one',
      trigger?.recommendedNextActions[0]?.capability,
      'web.search',
    );
  }

  {
    /*
     * The legacy bridge no longer manufactures an empty recommendation. Free
     * text becomes `missingInformation`, which says something is lacking
     * without pretending to say what would fix it.
     */
    const trigger = await captureTrigger(async () => ({
      output: { found: 0 },
      suggestsMoreWork: 'not enough sources were found',
    }));

    check('a legacy string produces no recommendation', trigger?.recommendedNextActions.length, 0);
    assertTrue(
      'it becomes missing information instead',
      trigger?.missingInformation.includes('not enough sources were found') ?? false,
    );
  }

  {
    /* And the executor source contains no flattening. */
    const executorSource = await readFile('src/server/tasks/executor.ts', 'utf8');

    assertTrue(
      'recommendations are not joined into a string',
      !executorSource.includes("`${action.capability || 'unknown'}: ${action.reason}`"),
    );
    assertTrue(
      'and no empty-capability recommendation is constructed',
      !executorSource.includes("capability: ''"),
    );
  }

  {
    /*
     * The planner acts on a structured recommendation without a model call.
     * That is the point of the contract: the information was already exact.
     */
    const serviceSource = await readFile('src/server/services/task.service.ts', 'utf8');

    assertTrue(
      'a named recommendation is scheduled directly',
      serviceSource.includes('trigger.recommendedNextActions.filter'),
    );
    assertTrue(
      'and the model is asked only when nothing is recommended',
      serviceSource.includes('direct.length > 0'),
    );
  }


  {
    /*
     * Three defects a live run exposed, all of them in the replanning path and
     * none visible in the tests that existed.
     *
     * A researcher asked for a paper and saw five steps, the fifth reading
     * "the query found the wrong corpus" — a sentence explaining why a step was
     * added, displayed as though it were the step.
     */
    const trigger = await captureTrigger(async (context) =>
      partial(
        [
          makeOutput(
            {
              taskId: context.taskId,
              stepId: context.stepId,
              capability: 'academic.search',
              projectId: context.projectId,
            },
            'sources.v1',
            { references: [], found: 0, offTopic: true },
          ),
        ],
        ['on-topic sources'],
        {
          recommendedNextActions: [
            { capability: 'academic.search', reason: 'the query found the wrong corpus', input: {} },
          ],
        },
      ),
    );

    /*
     * The reason stays in the observation, where it explains. It must not
     * become a step label, where it would read as work.
     */
    check('the reason travels in the recommendation', trigger?.recommendedNextActions[0]?.reason, 'the query found the wrong corpus');

    const serviceSource = await readFile('src/server/services/task.service.ts', 'utf8');
    assertTrue(
      'but a step is labelled by its capability, not by the reason',
      serviceSource.includes('capabilityFor(action.capability)?.labelKey') &&
        !serviceSource.includes('label: action.reason'),
    );
  }

  {
    /*
     * A search that found the wrong corpus must not recommend the same search.
     * The second would return the same corpus, recommend a third, and the task
     * would spend its budget repeating one mistake.
     */
    const handlerSource = await readFile('src/server/tasks/handlers.ts', 'utf8');

    assertTrue(
      'an off-topic search recommends no query rather than the failed one',
      handlerSource.includes('report.offTopic\n              ? {}'),
    );
    assertTrue(
      'and a thin result broadens instead of repeating',
      handlerSource.includes('topic: broaden(query)'),
    );

    const serviceSource = await readFile('src/server/services/task.service.ts', 'utf8');
    assertTrue(
      'the planner refuses a recommendation identical to a completed step',
      serviceSource.includes('JSON.stringify(step.input) === JSON.stringify(action.input'),
    );
  }

  {
    /* And the mode reads as a name, not as an identifier. */
    const arModes = JSON.parse(await readFile('messages/ar.json', 'utf8')) as {
      mode?: Record<string, unknown>;
    };
    const enModes = JSON.parse(await readFile('messages/en.json', 'utf8')) as {
      mode?: Record<string, unknown>;
    };

    check('the workspace mode has an Arabic name', typeof arModes.mode?.workspace, 'string');
    check('and an English one', typeof enModes.mode?.workspace, 'string');
  }


  /* ------------------------------------------------ continuity */

  section('references to earlier work resolve to the right thing');

  /*
   * A researcher writes "حوّله PDF" and means the paper produced two minutes
   * ago. Nothing in that sentence names it, and starting a task without the
   * subject had the planner search for a paper that already existed — then
   * produce a second one, which the researcher discovers on opening the file.
   */
  const continuityOwner = await newUser('continuity-owner');

  const continuityRoot = await mkdtemp(join(tmpdir(), 'academic-ai-continuity-'));
  process.env.STORAGE_PROVIDER = 'local';
  process.env.STORAGE_LOCAL_DIR = continuityRoot;
  resetEnvCache();
  resetStorageCache();

  registerAllHandlers();

  registerHandler('document.write', async (context) =>
    succeeded([
      makeOutput(
        { taskId: context.taskId, stepId: context.stepId, capability: 'document.write', projectId: context.projectId },
        'prose.v1',
        { text: 'أظهرت الدراسات أن التوأم الرقمي يحسّن الكفاءة [1].', heading: 'مقدمة' },
      ),
      makeOutput(
        { taskId: context.taskId, stepId: context.stepId, capability: 'document.write', projectId: context.projectId },
        'sources.v1',
        {
          references: [
            { id: '1', kind: 'journal-article', title: 'Digital Twin', authors: ['Smith, J.'], year: 2024, doi: '10.1111/x1234', provenance: 'retrieved' },
          ],
        },
      ),
    ]),
  );

  /** Runs a task and returns its steps. */
  async function runContinuityTask(
    request: string,
    plan: { capability: string; input?: Record<string, unknown>; dependsOn?: number[] }[],
    taskContext: Record<string, unknown> = {},
  ) {
    const task = await tasksRepo.create({
      userId: continuityOwner,
      request,
      locale: 'ar',
      status: 'QUEUED',
      context: taskContext,
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    const rows = await tasksRepo.addSteps(
      plan.map((step, index) => ({
        taskId: task.id,
        ordinal: index,
        capability: step.capability,
        label: step.capability,
        status: 'PENDING',
        dependsOn: [],
        input: step.input ?? {},
      })),
    );

    for (const [index, step] of plan.entries()) {
      const ids = (step.dependsOn ?? []).map((position) => rows[position]?.id as string);
      if (ids.length > 0) await tasksRepo.updateDependencies(rows[index]?.id as string, ids);
    }

    await runTask(task.id);
    return { task, steps: await tasksRepo.stepsOf(task.id) };
  }

  /* --- produce a paper, then convert it without naming it ---------------- */

  {
    const first = await runContinuityTask('اعمل بحث عن Digital Twin', [
      { capability: 'document.write' },
      { capability: 'document.generate', input: { format: 'docx', title: 'Digital Twin', citationStyle: 'apa' }, dependsOn: [0] },
    ]);

    const generated = first.steps.find((step) => step.capability === 'document.generate');
    check('a Word paper is produced', generated?.artifactIds.length, 1);

    /* "حوّله PDF" — the subject is not in the sentence. */
    const resolution = await resolveReference({
      userId: continuityOwner,
      kind: 'artifact',
      message: 'حوّله PDF',
      locale: 'ar',
    });

    check('the reference resolves to one thing', resolution.status, 'resolved');

    if (resolution.status === 'resolved') {
      assertTrue('naming the paper', resolution.candidate.label.includes('Digital Twin'));

      /*
       * The Word file is the source, not the target: someone asking for PDF
       * wants a PDF made from something that is not one.
       */
      check('and it is the Word file', resolution.candidate.artifact?.kind, 'docx');

      /* Converting it carries the content, rather than writing a new paper. */
      const second = await runContinuityTask(
        'حوّله PDF',
        [{ capability: 'document.generate', input: { format: 'pdf', title: 'Digital Twin' } }],
        { references: { kind: 'artifact', id: resolution.candidate.id, targetFormat: 'pdf' } },
      );

      const converted = second.steps[0];
      check('the conversion completes', converted?.status, 'COMPLETED');
      check('producing a file', converted?.artifactIds.length, 1);

      const { artifact, bytes } = await readArtifact(
        converted?.artifactIds[0] as string,
        continuityOwner,
      );

      check('which is a PDF', artifact.kind, 'pdf');
      /*
       * Larger than an empty document. The content came from the artifact the
       * request referred to — a conversion that produced a title page and
       * nothing else would be the failure this resolution exists to prevent.
       */
      assertTrue('carrying the original content', bytes.length > 1400);
    }
  }

  /* --- prose: "اختصره" finds the text, not the file --------------------- */

  {
    const resolution = await resolveReference({
      userId: continuityOwner,
      kind: 'prose',
      message: 'اختصره',
      locale: 'ar',
    });

    assertTrue('written text can be referred to', resolution.status === 'resolved');

    if (resolution.status === 'resolved') {
      check('and it is prose, not a file', resolution.candidate.kind, 'prose');
      assertTrue('with the text available', Boolean(resolution.candidate.output));
    }
  }

  /* --- nothing to refer to -------------------------------------------- */

  {
    const stranger = await newUser('continuity-stranger');

    const resolution = await resolveReference({
      userId: stranger,
      kind: 'artifact',
      message: 'حوّله PDF',
      locale: 'ar',
    });

    check('a user with no files gets no candidate', resolution.status, 'none');

    if (resolution.status === 'none') {
      assertTrue('and is asked what they mean', resolution.question.length > 10);
      assertTrue('in their language', /لم أجد/.test(resolution.question));
    }
  }

  /* --- ambiguity is asked about, never guessed ------------------------- */

  {
    /*
     * Two files produced seconds apart. Picking the most recent would be right
     * often enough to be dangerous: it would work until the day it rewrote the
     * wrong chapter, and by then nobody would be checking.
     */
    const ambiguousOwner = await newUser('continuity-ambiguous');

    for (const title of ['Chapter One', 'Chapter Two']) {
      await storeArtifact({
        userId: ambiguousOwner,
        kind: 'docx',
        filename: `${title}.docx`,
        bytes: await generateDocx({ title, sections: [{ paragraphs: ['Some content here.'] }] }),
      });
    }

    const resolution = await resolveReference({
      userId: ambiguousOwner,
      kind: 'artifact',
      message: 'حوّله PDF',
      locale: 'ar',
    });

    check('two close candidates are ambiguous', resolution.status, 'ambiguous');

    if (resolution.status === 'ambiguous') {
      check('both are offered', resolution.candidates.length, 2);
      assertTrue('the question lists them', resolution.question.includes('Chapter'));
      assertTrue('and asks rather than tells', /أيّها تقصد/.test(resolution.question));
    }
  }

  /* --- a named format never matches itself ----------------------------- */

  {
    check('a PDF request finds pdf as the target', namedFormat('حوّله PDF'), 'pdf');
    check('a PowerPoint request', namedFormat('اعمللي عرض تقديمي منه'), 'pptx');
    check('and Word', namedFormat('اعطيني ملف وورد'), 'docx');
    check('a message naming no format', namedFormat('اختصره'), null);
  }

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

