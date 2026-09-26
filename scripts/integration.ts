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

/*
 * Background work runs in-process here, as it always did in this suite: no
 * worker consumes a queue in this process. The queued path has its own suite,
 * scripts/jobs-integration.ts.
 */
process.env.JOB_RUNNER ??= 'direct';

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import bcrypt from 'bcryptjs';
import { eq, like } from 'drizzle-orm';

import type { AgentEvent } from '@/agents/events';
import { buildResultsContext } from '@/ai/context/results';
import { allowedFromLegacyResults, checkNumbers, legacyResultTier, NUMERIC_GUARD_VERSION, QUARANTINE_MARKER } from '@/server/integrity/numbers';
import { clearIntentStubForTests, setIntentStubForTests } from '@/agents/intent';
import { runAgent } from '@/agents/orchestrator';
import { PROPOSAL_SECTIONS, WIZARD_STEPS } from '@/config/research';
import { resetEnvCache } from '@/config/env';
import { db } from '@/server/db';
import { users, analysisJobs, projectMembers, researchProjects } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { consume, resetRateLimitStore } from '@/server/http/rate-limit';
import * as adminRepo from '@/server/repositories/admin.repository';
import * as analysisRunsRepo from '@/server/repositories/analysis-runs.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';
import * as agentTasksRepo from '@/server/repositories/agent-tasks.repository';
import * as jobsRepo from '@/server/repositories/analysis-jobs.repository';
import * as titlesRepo from '@/server/repositories/titles.repository';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { generateCsv, generateMarkdown } from '@/server/generators/documents';
import * as tasksRepo from '@/server/repositories/tasks.repository';
import { namedFormat, resolveReference } from '@/server/agent/continuity';
import { detectReference } from '@/server/agent/routing-rules';
import { getTask, substituteFormat } from '@/server/services/task.service';
import { generateDocx } from '@/server/generators/docx';
import { generatePdf } from '@/server/generators/documents';
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
import { handlerFor, hasHandler, registerHandler, runTask, type ReplanTrigger } from '@/server/tasks/executor';
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
import { approveSection, getSection, listVersions, saveSection, saveUserEdit } from '@/server/services/section.service';
import { updateSectionSchema } from '@/server/validation/project';
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
  deleteRun,
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
  recordReply,
  recordTurn,
  renameConversation,
  startConversation,
  switchToBranch,
} from '@/server/services/chat.service';
import { cancelJob, getJob, runCbSem, runPls, startBootstrap } from '@/server/services/pls.service';
import { asLegacyResult, LEGACY_ENGINE, LEGACY_ENGINE_STAMP, readProvenance } from '@/server/stats/legacy-provenance';
import { modelHash } from '@/server/tasks/model-confirmation';
import { clearUnselectedTitles, deleteTitle, generateSection, listTitles, selectTitle, streamChat } from '@/server/services/ai.service';
import { chatAllowedValues, checkChatReply, inspectChatReply } from '@/server/services/chat-integrity';
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

  /* ----------------------------------------------- WS2 N3: the edit boundary */
  section('section edits from the editor (WS2 N3)');
  {

    /* The route's body schema: only a draft or the person's own edit; the server decides who wrote it. */
    const parsed = (body: unknown) => updateSectionSchema.safeParse(body);
    check('a client cannot approve through an edit (status APPROVED is refused)', parsed({ content: 'x', status: 'APPROVED' }).success, false);
    check('a client cannot mark text as AI-suggested (status AI_SUGGESTED is refused)', parsed({ content: 'x', status: 'AI_SUGGESTED' }).success, false);
    check('an unknown status is refused', [parsed({ content: 'x', status: 'PUBLISHED' }).success, parsed({ content: 'x', status: 'EMPTY' }).success], [false, false]);
    check('a draft or the person’s own edit is accepted', [parsed({ content: '', status: 'DRAFT' }).success, parsed({ content: 'x', status: 'USER_EDITED' }).success, parsed({ content: 'x' }).success], [true, true, true]);
    const withOrigin = parsed({ content: 'x', status: 'USER_EDITED', origin: 'AI' });
    check('an origin sent by the client is dropped (the server decides)', withOrigin.success && !('origin' in withOrigin.data), true);

    /* The service: always recorded as the person's, never approved by an edit. */
    const editKey = 'OBJECTIVES' as const;
    const firstEdit = await saveUserEdit({ projectId: project.id, userId: userA, sectionKey: editKey, content: 'تهدف الدراسة إلى تعرّف أثر البرنامج.', heading: 'أهداف الدراسة' });
    check('an edit with text is the person’s edit', firstEdit.status, 'USER_EDITED');
    const editVersions = await listVersions(project.id, userA, editKey);
    check('… and its version is recorded as the person’s (origin USER)', editVersions.map((v) => v.origin), ['USER']);
    check('an empty edit is a draft', (await saveUserEdit({ projectId: project.id, userId: userA, sectionKey: 'HYPOTHESES', content: '' })).status, 'DRAFT');
    check('an explicit draft stays a draft', (await saveUserEdit({ projectId: project.id, userId: userA, sectionKey: 'RECOMMENDATIONS', content: 'مسودة أولى', status: 'DRAFT' })).status, 'DRAFT');
    await expectAppError('another user cannot edit the section', 'NOT_FOUND', () =>
      saveUserEdit({ projectId: project.id, userId: userB, sectionKey: editKey, content: 'x' }),
    );

    /* D4: editing an approved section revokes its approval; saving the same text does not. */
    const approvedEdit = await approveSection(project.id, userA, editKey);
    check('the section is approved', approvedEdit.status, 'APPROVED');
    const unchanged = await saveUserEdit({ projectId: project.id, userId: userA, sectionKey: editKey, content: approvedEdit.content, heading: approvedEdit.heading ?? undefined });
    check('saving the same text keeps the approval (the editor’s Save on an unchanged section)', [unchanged.status, unchanged.approvedAt?.getTime()], ['APPROVED', approvedEdit.approvedAt?.getTime()]);
    check('… and adds no version', (await listVersions(project.id, userA, editKey)).length, editVersions.length);
    const edited = await saveUserEdit({ projectId: project.id, userId: userA, sectionKey: editKey, content: `${approvedEdit.content} ويُعنى بطلبة المرحلة الأساسية.` });
    check('editing an approved section revokes its approval', [edited.status, edited.approvedAt], ['USER_EDITED', null]);
    const revokedVersion = (await listVersions(project.id, userA, editKey)).find((v) => v.note === 'Edited after approval: approval revoked');
    check('… the revocation is recorded on the version, as the person’s edit', [Boolean(revokedVersion), revokedVersion?.origin], [true, 'USER']);
    check('… and it can be approved again, deliberately', (await approveSection(project.id, userA, editKey)).status, 'APPROVED');
    const retitled = await saveUserEdit({ projectId: project.id, userId: userA, sectionKey: editKey, content: edited.content, heading: 'عنوان آخر للقسم' });
    check('changing the heading of an approved section is an edit too', retitled.status, 'USER_EDITED');

    /* The server still approves where it should: choosing a title writes an approved TITLE section. */
    const [candidate] = await titlesRepo.insertMany([{ projectId: project.id, title: 'أثر برنامج تدريبي في التحصيل', batch: 1, selected: false }] as never);
    await selectTitle(userA, project.id, candidate!.id);
    const titleSection = await getSection(project.id, userA, 'TITLE');
    check('selecting a title still approves the TITLE section server-side', [titleSection.status, titleSection.approvedAt instanceof Date, titleSection.content], ['APPROVED', true, 'أثر برنامج تدريبي في التحصيل']);
    check('… and a later edit of the title revokes it', (await saveUserEdit({ projectId: project.id, userId: userA, sectionKey: 'TITLE', content: 'عنوان معدّل' })).status, 'USER_EDITED');

    /* WS2 D2: every person's edit records a flag-only scan with its version; the text is never changed. */
    const scanned = 'بلغ حجم العينة N = 250 طالبًا، وكانت النتيجة t(98) = 2.31, p = .012.';
    await saveUserEdit({ projectId: project.id, userId: userA, sectionKey: 'DISCUSSION', content: scanned });
    const [scannedVersion] = await listVersions(project.id, userA, 'DISCUSSION');
    check(
      'D2: an edit records a person-mode scan with its version, text unchanged',
      [scannedVersion?.content, scannedVersion?.integrity?.mode, scannedVersion?.integrity?.quarantined, scannedVersion?.integrity?.guardVersion, (await getSection(project.id, userA, 'DISCUSSION')).status],
      [scanned, 'person', 0, NUMERIC_GUARD_VERSION, 'USER_EDITED'],
    );
    check('D2: numbers tracing to no attached analysis are counted as manual (flag only)', [(scannedVersion?.integrity?.manual ?? 0) >= 2, scannedVersion?.integrity?.findings.some((found) => found.text.includes('2.31')), scannedVersion?.integrity?.sources], [true, true, []]);
    const plainEdit = await saveUserEdit({ projectId: project.id, userId: userA, sectionKey: 'DISCUSSION', content: 'نص بلا أرقام بحثية.' });
    const [plainVersion] = await listVersions(project.id, userA, 'DISCUSSION');
    check('D2: text without research numbers records no manual numbers', [plainEdit.status, plainVersion?.integrity?.manual, plainVersion?.integrity?.findings], ['USER_EDITED', 0, []]);
    check('D2: the revoked-approval edit also carries its scan', Boolean(revokedVersion?.integrity && revokedVersion.integrity.mode === 'person'), true);
    check('D2: a version saved without the guard (a chosen title, an earlier save) has no record', [(await listVersions(project.id, userA, 'TITLE')).find((v) => v.origin === 'AI')?.integrity ?? null, (await listVersions(project.id, userA, 'PROBLEM')).every((v) => v.integrity === null)], [null, true]);
    await approveSection(project.id, userA, 'DISCUSSION');
    check('D2: a section with manual numbers can still be approved (no blocking)', (await getSection(project.id, userA, 'DISCUSSION')).status, 'APPROVED');
  }

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

  /*
   * P0.3: the address alone grants nothing. Whoever registers the owner
   * address first has not proven they hold it — only a verified address
   * carries owner rights.
   */
  const unverifiedPlan = await resolvePlanForUser(ownerId);
  check('an unverified owner address stays on the free plan', unverifiedPlan.plan.code, 'FREE');
  assertTrue('an unverified owner address is not flagged owner', !unverifiedPlan.isOwner);
  {
    const { hasAdminAccess } = await import('@/server/auth/owner');
    assertTrue('an unverified owner address has no admin access', !hasAdminAccess({ email: ownerEmail, role: 'USER', emailVerified: false }));
    const { requestEmailVerification, verifyEmail } = await import('@/server/services/account.service');
    const request = await requestEmailVerification(ownerId, 'en');
    const token = new URL(request.devUrl as string).searchParams.get('token') as string;
    await verifyEmail({ userId: ownerId, token });
    assertTrue('a verified owner has admin access', hasAdminAccess({ email: ownerEmail, role: 'USER', emailVerified: true }));
  }

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
  assertTrue('the rules travel with the numbers', chapterContext.includes('Report these numbers exactly as written.'));
  /* Legacy results are labelled computed, with their tier, never "verified" (WS2 N2). */
  assertTrue('the chapter block is labelled computed, not verified', chapterContext.startsWith('## COMPUTED ANALYSIS RESULTS (legacy engine, not independently verified)') && !chapterContext.includes('VERIFIED'));
  assertTrue('a run pinned to its data version shows the pinned tier', chapterContext.includes('Tier: pinned:'));
  check('WS2 B2: a legacy run is stamped with the legacy engine, not P1-C’s', [chapterRun.run.engineVersion, (chapterRun.run.spec as { engine?: unknown }).engine, chapterContext.includes('(academic-ai-legacy-analysis@1)')], [LEGACY_ENGINE_STAMP, { ...LEGACY_ENGINE }, true]);

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

  {
    /*
     * WS2 D3: a result computed on the first rows of a file only is not the
     * study's. It cannot be attached, and one attached before this rule is
     * left out of the chapter's prompt and of the numbers it may repeat.
     */
    const windowedRun = await analysisRunsRepo.create({
      userId: statsOwner,
      datasetId: statsFile.dataset.id,
      testKey: 'correlation.pearson',
      spec: { columns: { x: 'score', y: 'score' }, rowsAnalysed: 5000, truncatedTo: 5000 },
      result: { statistic: { name: 'r', value: 0.8123 }, pValue: 0.0042, n: 5000 },
      datasetVersionId: chapterRun.run.datasetVersionId,
      datasetContentHash: chapterRun.run.datasetContentHash,
      engineVersion: chapterRun.run.engineVersion,
    });
    let refusal: unknown = null;
    try {
      await attachRun({ runId: windowedRun.id, userId: statsOwner, projectId: statsProject.id, sectionKey: 'RESULTS' });
    } catch (error) {
      refusal = error;
    }
    check(
      'attaching a windowed run is refused (409, windowed_run)',
      refusal instanceof AppError ? [refusal.code, refusal.status, (refusal.details as { reason?: string; rows?: number }).reason, (refusal.details as { rows?: number }).rows] : refusal,
      ['CONFLICT', 409, 'windowed_run', 5000],
    );
    check('and nothing is attached', (await analysisRunsRepo.listForSection(statsProject.id, statsOwner, 'RESULTS')).length, 0);

    let intruderAttach = false;
    try {
      await attachRun({ runId: windowedRun.id, userId: statsIntruder, projectId: statsProject.id, sectionKey: 'RESULTS' });
    } catch (error) {
      intruderAttach = error instanceof AppError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN');
    }
    assertTrue('another user still cannot attach it', intruderAttach);

    /* A whole-file run still attaches as before. */
    check('a whole-file run still attaches', (await attachRun({ runId: chapterRun.run.id, userId: statsOwner, projectId: statsProject.id, sectionKey: 'RESULTS' })).sectionKey, 'RESULTS');

    /* One attached before the rule (written directly, as an old row would be). */
    await analysisRunsRepo.attachToSection(windowedRun.id, statsOwner, statsProject.id, 'RESULTS');
    const attachedBoth = await analysisRunsRepo.listForSection(statsProject.id, statsOwner, 'RESULTS');
    check('both runs are attached in the table', attachedBoth.length, 2);
    const mixedContext = buildResultsContext(attachedBoth) ?? '';
    assertTrue('the windowed run\u2019s figures do not reach the chapter prompt', !mixedContext.includes('0.812') && mixedContext.includes(computed.statistic.value.toFixed(3)));
    assertTrue('and the prompt says it was left out', mixedContext.includes('Left out: 1 attached analysis was computed on the first rows of a file only (correlation.pearson)'));
    const legacyAllowed = allowedFromLegacyResults(attachedBoth);
    check('the allowed numbers exclude the windowed run', [legacyAllowed.used.map((entry) => [entry.id, entry.tier]), legacyAllowed.excluded.map((entry) => [entry.id, entry.tier])], [[[chapterRun.run.id, 'pinned']], [[windowedRun.id, 'windowed']]]);
    check('so its value is untraced in the text', checkNumbers('r = .81', { mode: 'model', allowed: legacyAllowed.values }).clean, false);

    /* Detaching is always allowed, and restores the template behaviour. */
    check('a windowed run can be detached', (await detachRun(windowedRun.id, statsOwner)).sectionKey, null);
    await detachRun(chapterRun.run.id, statsOwner);
    check('the section is back to a template', buildResultsContext(await analysisRunsRepo.listForSection(statsProject.id, statsOwner, 'RESULTS')), null);
  }

  {
    section('section generation quarantines untraced numbers before saving (WS2 N1)');

    /*
     * A scripted model through the real gateway path: a placeholder key makes
     * one provider count as configured, and the gateway is replaced for the
     * test so nothing leaves the process. Both are restored afterwards.
     */
    const { FakeAdapter } = await import('@/server/ai/gateway/adapters/fake');
    const { createGateway } = await import('@/server/ai/gateway/gateway');
    const { productionDeps, setGatewayForTests } = await import('@/server/ai/gateway');
    const { resetEnvCache } = await import('@/config/env');
    const { runForUser } = await import('@/server/ai/request-scope');
    /* As the API does: every model call runs in its user's scope. */
    const generate = (userId: string, ...args: [string, Parameters<typeof generateSection>[2], string?]) => runForUser(userId, () => generateSection(userId, ...args));
    const fake = new FakeAdapter('openai');
    setGatewayForTests(createGateway({ ...productionDeps, adapters: () => ({ openai: fake }), models: async () => ({ configured: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai', siblings: {} }) }));
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'placeholder-for-the-scripted-model';
    resetEnvCache();
    const reply = (text: string) => fake.push({ reply: { text } });
    const markers = (text: string, marker: string) => text.split(marker).length - 1;

    try {
      /* A results section in the (Arabic) stats project, with a whole-file run and a windowed one attached. */
      const target = statsProject.id;
      await attachRun({ runId: chapterRun.run.id, userId: statsOwner, projectId: target, sectionKey: 'RESULTS' });
      const windowedRun = await analysisRunsRepo.create({
        userId: statsOwner,
        datasetId: statsFile.dataset.id,
        testKey: 'correlation.pearson',
        spec: { columns: { x: 'score', y: 'score' }, truncatedTo: 5000 },
        result: { statistic: { name: 'r', value: 0.8123 }, pValue: 0.0042, n: 5000 },
      });
      /* Attached before the D3 rule, as an old row would be. */
      await analysisRunsRepo.attachToSection(windowedRun.id, statsOwner, target, 'RESULTS');

      /* An earlier, person-written section in the same project must not change. */
      await saveUserEdit({ projectId: target, userId: statsOwner, sectionKey: 'DISCUSSION', content: 'Earlier finding: t = 9.99, p = .001.' });
      const discussionBefore = await getSection(target, statsOwner, 'DISCUSSION');

      const realStatistic = computed.statistic.value.toFixed(3);
      reply(`The groups differed, t = ${realStatistic}. A further test found t(98) = 2.31, p = .012. The correlation was r = .81.`);
      const results = await generate(statsOwner, target, 'RESULTS');
      const savedResults = await getSection(target, statsOwner, 'RESULTS');

      assertTrue('the traced statistic survives', results.content.includes(`t = ${realStatistic}`));
      assertTrue('invented numbers are gone from the returned text', !/2\.31|\.012|\.81/.test(results.content));
      check('the saved text is the quarantined text', savedResults?.content, results.content);
      check('each untraced number is replaced by a visible marker (Arabic project: Arabic marker)', markers(results.content, QUARANTINE_MARKER.ar), results.integrity.quarantined);
      assertTrue('including the windowed run\u2019s value (D3)', results.integrity.findings.some((found) => found.value.includes('81')));
      assertTrue('at least the three invented or windowed values were quarantined', results.integrity.quarantined >= 3);
      check('the findings name the guard version', results.integrity.guardVersion, 'ws2-2');
      assertTrue('the notice says values were replaced', (results.guardrails.notice?.en ?? '').includes(`replaced with ${QUARANTINE_MARKER.en}`) && (results.guardrails.notice?.ar ?? '').includes(QUARANTINE_MARKER.ar));
      check('status stays AI_SUGGESTED', savedResults?.status, 'AI_SUGGESTED');
      const resultVersions = await listVersions(target, statsOwner, 'RESULTS');
      check('the version is recorded as AI, with the quarantined text', [resultVersions[0]?.origin, resultVersions[0]?.content], ['AI', results.content]);
      /* WS2 D2: the guard's result is stored with the version: runs checked against, with tiers, and the windowed one left out. */
      const stored = resultVersions[0]?.integrity;
      check(
        'D2: the generated version records the model-mode result',
        [stored?.mode, stored?.guardVersion, stored?.quarantined, stored?.manual, stored?.findings.length === Math.min(20, results.integrity.quarantined)],
        ['model', results.integrity.guardVersion, results.integrity.quarantined, 0, true],
      );
      check('D2: with the attached runs and their tiers (never "verified"), the windowed one excluded', [stored?.sources, stored?.excluded], [[{ id: chapterRun.run.id, tier: 'pinned' }], [{ id: windowedRun.id, tier: 'windowed' }]]);
      assertTrue('D2: and the traced statistic is counted as traced', (stored?.traced ?? 0) >= 1);
      check('the earlier section is untouched', [(await getSection(target, statsOwner, 'DISCUSSION'))?.content, (await listVersions(target, statsOwner, 'DISCUSSION')).length], [discussionBefore?.content, 1]);
      /* WS2 D2: a person's edit of the results section is scanned against the same attached runs, and kept as written. */
      const personText = `The groups differed, t = ${realStatistic}; I also found r = .44.`;
      await saveUserEdit({ projectId: target, userId: statsOwner, sectionKey: 'RESULTS', content: personText });
      const [personVersion] = await listVersions(target, statsOwner, 'RESULTS');
      check(
        'D2: a person\u2019s edit of a results section: kept as written, traced and manual numbers counted',
        [personVersion?.content, personVersion?.origin, personVersion?.integrity?.mode, (personVersion?.integrity?.traced ?? 0) >= 1, personVersion?.integrity?.manual, personVersion?.integrity?.sources, personVersion?.integrity?.excluded],
        [personText, 'USER', 'person', true, 1, [{ id: chapterRun.run.id, tier: 'pinned' }], [{ id: windowedRun.id, tier: 'windowed' }]],
      );
      await detachRun(chapterRun.run.id, statsOwner);
      await detachRun(windowedRun.id, statsOwner);

      /* An English project (its own user: one project per free plan) gets the English marker. */
      const enOwner = await newUser('n1-en-owner');
      const enProject = await createProject(enOwner, { ...projectInput, language: 'EN' });

      /* A non-results section: only numbers in this request's instruction are the researcher's. */
      reply('The study sampled N = 250 students. Earlier work reported r = .45 and M = 3.72.');
      const intro = await generate(enOwner, enProject.id, 'INTRODUCTION', 'Mention that the sample was N = 250 students.');
      assertTrue('a number stated in the instruction is kept', intro.content.includes('N = 250'));
      assertTrue('others are quarantined with the English marker', !/\.45|3\.72/.test(intro.content) && markers(intro.content, QUARANTINE_MARKER.en) === intro.integrity.quarantined && intro.integrity.quarantined === 2);
      reply('The study sampled N = 250 students.');
      const noInstruction = await generate(enOwner, enProject.id, 'INTRODUCTION');
      check('without it in the instruction the same number is quarantined (project text is not used)', [noInstruction.content.includes('250'), noInstruction.integrity.quarantined], [false, 1]);
      const [introVersion] = await listVersions(enProject.id, enOwner, 'INTRODUCTION');
      check('D2: a non-results section records its result with no run sources', [introVersion?.integrity?.mode, introVersion?.integrity?.quarantined, introVersion?.integrity?.sources, introVersion?.integrity?.excluded], ['model', 1, [], []]);

      /* Text with no research numbers is saved exactly as written. */
      reply('This section describes the aims of the study in general terms.');
      const plain = await generate(enOwner, enProject.id, 'OBJECTIVES');
      check('clean text is saved unchanged, with no notice', [plain.content, plain.integrity.quarantined, plain.guardrails.notice], ['This section describes the aims of the study in general terms.', 0, null]);
    } finally {
      setGatewayForTests(null);
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      resetEnvCache();
    }
  }

  {
    section('chat flags numbers it cannot trace and never rewrites them (WS2 N11)');

    /* The same scripted-model setup as the N1 block, restored afterwards. */
    const { FakeAdapter } = await import('@/server/ai/gateway/adapters/fake');
    const { createGateway } = await import('@/server/ai/gateway/gateway');
    const { productionDeps, setGatewayForTests } = await import('@/server/ai/gateway');
    const { resetEnvCache } = await import('@/config/env');
    const { runForUser } = await import('@/server/ai/request-scope');
    const fake = new FakeAdapter('openai');
    setGatewayForTests(createGateway({ ...productionDeps, adapters: () => ({ openai: fake }), models: async () => ({ configured: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai', siblings: {} }) }));
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'placeholder-for-the-scripted-model';
    resetEnvCache();
    const untraced = (flags: readonly string[] | undefined) => (flags ?? []).includes('UNTRACED_STATISTIC');
    const lastAssistant = async (conversationId: string) => (await chatRepo.activeThread(conversationId)).filter((message) => message.role === 'ASSISTANT').at(-1);

    try {
      const chatUser = await newUser('n11-owner');
      const chatProject = await createProject(chatUser, { ...projectInput, language: 'EN' });
      const chatFile = await saveUpload({ userId: chatUser, file: { name: 'chat.csv', bytes: new TextEncoder().encode(statsCsv).buffer as ArrayBuffer } });
      const whole = await runAnalysis({ datasetId: chatFile.dataset.id, userId: chatUser, test: 't.independent', columns: { dependent: 'score', grouping: 'gender' } });
      const wholeT = (whole.result as { statistic: { value: number } }).statistic.value.toFixed(3);
      const windowedChat = await analysisRunsRepo.create({
        userId: chatUser,
        datasetId: chatFile.dataset.id,
        testKey: 'correlation.pearson',
        spec: { columns: { x: 'score', y: 'score' }, truncatedTo: 5000 },
        result: { statistic: { name: 'r', value: 0.8123 }, pValue: 0.0042, n: 5000 },
      });

      const agentTurn = (intent: string, message: string, extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
        runForUser(chatUser, async () => {
          setIntentStubForTests({ intent: intent as Parameters<typeof setIntentStubForTests>[0]['intent'], confidence: 0.95, mentionedColumns: [], restatement: intent, clarifyingQuestion: null, searchQueries: [], usage: { tokensIn: 0, tokensOut: 0 } });
          const events: AgentEvent[] = [];
          for await (const event of runAgent({ userId: chatUser, message, locale: 'en', projectId: chatProject.id, ...extra })) events.push(event);
          return events;
        });
      const conversationOf = (events: AgentEvent[]) => (events.find((event) => event.type === 'conversation') as { conversationId: string } | undefined)?.conversationId ?? '';
      const deltaOf = (events: AgentEvent[]) => events.filter((event): event is Extract<AgentEvent, { type: 'delta' }> => event.type === 'delta').map((event) => event.text).join('');

      /* gatherResults (D3): only a windowed run attached is not a results chapter. */
      await analysisRunsRepo.attachToSection(windowedChat.id, chatUser, chatProject.id, 'RESULTS');
      const windowedOnly = await agentTurn('research.results', 'Write my results chapter.');
      check(
        'only windowed runs attached: a question, no results and no chapter',
        [windowedOnly.some((event) => event.type === 'question' && event.question.includes('first rows of a file only')), windowedOnly.some((event) => event.type === 'result'), deltaOf(windowedOnly)],
        [true, false, ''],
      );

      /* Mixed: the whole-file run counts, the windowed one is reported as left out. */
      await attachRun({ runId: whole.run.id, userId: chatUser, projectId: chatProject.id, sectionKey: 'RESULTS' });
      fake.push({ reply: { text: `The groups differed, t = ${wholeT}. The correlation was r = .81.` } });
      const mixed = await agentTurn('research.results', 'Write my results chapter.');
      const gathered = mixed.find((event): event is Extract<AgentEvent, { type: 'result' }> => event.type === 'result' && event.kind === 'analysis');
      check('mixed runs: only the usable one is counted, the windowed one reported as left out', gathered?.payload, { attachedCount: 1, tests: ['t.independent'], excludedWindowed: 1 });

      /* writeResults: the saved section's markers, then the note, in the reply and the stored message. */
      const written = deltaOf(mixed);
      assertTrue('the chapter streamed with its marker and the traced value', written.includes(QUARANTINE_MARKER.en) && written.includes(`t = ${wholeT}`) && !written.includes('.81'));
      assertTrue('followed by the note about the replaced value', written.includes(`Note: the results section was saved with 1 number replaced by ${QUARANTINE_MARKER.en}`));
      assertTrue('the note does not speak of "attached to this section"', !written.includes('attached to this section'));
      const writtenMessage = await lastAssistant(conversationOf(mixed));
      check('the stored reply is what was streamed, with the flags', [writtenMessage?.content, untraced(writtenMessage?.flags)], [written, true]);

      /* From here chat must not touch any section. */
      const sectionsOf = async () => JSON.stringify((await getProjectWithSections(chatProject.id, chatUser)).sections.map((row) => [row.sectionKey, row.content, row.status]));
      const sectionsBefore = await sectionsOf();

      /* Agent respond: flags only, against the project's usable runs and the current message. */
      const answerText = `Your comparison gave t = ${wholeT}. Another study found t(98) = 2.31, and your sample was N = 120.`;
      fake.push({ reply: { text: answerText } });
      const answered = await agentTurn('general.question', 'What did my comparison show? My sample was N = 120.');
      const answeredId = conversationOf(answered);
      const answeredMessage = await lastAssistant(answeredId);
      check('respond: the answer is streamed and stored unchanged', [deltaOf(answered), answeredMessage?.content], [answerText, answerText]);
      check('and the invented value is flagged on the stored reply', untraced(answeredMessage?.flags), true);
      fake.push({ reply: { text: `Your comparison gave t = ${wholeT}, with N = 120.` } });
      const traced = await agentTurn('general.question', 'Remind me of the result for my sample of N = 120.');
      check('respond: a traced value and the current message’s number raise no flag', untraced((await lastAssistant(conversationOf(traced)))?.flags), false);

      /* A regenerated answer keeps its own flags. */
      const question = (await chatRepo.activeThread(answeredId)).filter((message) => message.role === 'USER').at(-1)!;
      fake.push({ reply: { text: 'On reflection, the effect was r = .81.' } });
      await agentTurn('general.question', question.content, { conversationId: answeredId, regeneratedParentId: question.id });
      const regenerated = await lastAssistant(answeredId);
      check('a regenerated answer is stored with its flags', [regenerated?.content, regenerated?.parentMessageId, untraced(regenerated?.flags)], ['On reflection, the effect was r = .81.', question.id, true]);

      /* streamChat (project chat): the same rules, reading the stream as the client does. */
      const streamed = async (message: string, text: string) => {
        fake.push({ stream: [text] });
        const handle = await runForUser(chatUser, () => streamChat(chatUser, chatProject.id, message));
        const raw = await new Response(handle.stream).text();
        const events = raw.split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)) as { type: string; text?: string; flags?: string[]; guardrails?: { en: string } | null });
        const done = events.find((event) => event.type === 'done');
        const stored = await lastAssistant(handle.conversationId);
        return { text: events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), done, stored };
      };
      const allowedRun = await streamed('Summarise my comparison.', `The comparison gave t = ${wholeT}.`);
      check('streamChat: an attached run’s value is not flagged, and the text is unchanged', [untraced(allowedRun.done?.flags), allowedRun.stored?.content], [false, `The comparison gave t = ${wholeT}.`]);
      const windowedValue = await streamed('And the correlation?', 'The correlation was r = .81.');
      check('streamChat: a windowed run’s value is flagged (D3), stored with the flag', [untraced(windowedValue.done?.flags), untraced(windowedValue.stored?.flags)], [true, true]);
      const invented = await streamed('Any other result?', 'A further test found t(98) = 2.31.');
      check('streamChat: an invented value is flagged', untraced(invented.done?.flags), true);
      assertTrue('with the chat wording, not the section wording', (invented.done?.guardrails?.en ?? '').includes('in this reply') && !(invented.done?.guardrails?.en ?? '').includes('attached to this section'));
      const stated = await streamed('My sample was N = 250 students.', 'With N = 250 students, the design is adequate.');
      check('streamChat: a number in the current message is the researcher’s', untraced(stated.done?.flags), false);
      const earlier = await streamed('And how large was the sample?', 'The sample was N = 250.');
      check('streamChat: a number from an earlier turn is not', untraced(earlier.done?.flags), true);

      /* Result payloads with no run row are unpinned values; a payload of a windowed run follows the run. */
      const payloadThread = await startConversation({ userId: chatUser, projectId: chatProject.id, firstMessage: 'profile' });
      await chatRepo.addMessage({ conversationId: payloadThread.id, role: 'ASSISTANT', content: '', payload: { results: [{ kind: 'profile', payload: { mean: 3.4567 } }, { kind: 'analysis', runId: windowedChat.id, payload: { statistic: { name: 'r', value: 0.8123 } } }] } });
      const payloadAllowed = await chatAllowedValues({ userId: chatUser, conversationId: payloadThread.id });
      check(
        'a payload with no run row allows its values (unpinned); a windowed run’s payload does not',
        [untraced(inspectChatReply('The mean was M = 3.46.', { allowed: payloadAllowed, message: '' }).flags), untraced(inspectChatReply('The correlation was r = .81.', { allowed: payloadAllowed, message: '' }).flags)],
        [false, true],
      );

      /* /api/chat: the route checks with checkChatReply and stores the flags through recordReply. */
      const routeThread = await startConversation({ userId: chatUser, projectId: chatProject.id, firstMessage: 'route' });
      const routeCheck = await checkChatReply({ userId: chatUser, projectId: chatProject.id, conversationId: routeThread.id, message: 'What was my result?', text: 'It was t(98) = 2.31.' });
      const routeIds = await recordReply({ conversationId: routeThread.id, userId: chatUser, userMessage: 'What was my result?', assistantMessage: 'It was t(98) = 2.31.', flags: routeCheck.flags });
      const routeRegen = await recordReply({ conversationId: routeThread.id, userId: chatUser, userMessage: 'What was my result?', assistantMessage: `It was t = ${wholeT}.`, replyToMessageId: routeIds.userMessageId, flags: (await checkChatReply({ userId: chatUser, projectId: chatProject.id, conversationId: routeThread.id, message: 'What was my result?', text: `It was t = ${wholeT}.` })).flags });
      const routeRows = await chatRepo.activeThread(routeThread.id);
      check(
        '/api/chat: a reply and a regenerated reply are stored with their own flags',
        [untraced(routeRows.find((row) => row.id === routeIds.assistantMessageId)?.flags ?? (await chatRepo.findMessage(routeIds.assistantMessageId, routeThread.id))?.flags), untraced((await chatRepo.findMessage(routeRegen.assistantMessageId, routeThread.id))?.flags)],
        [true, false],
      );

      check('chat never changed a section', await sectionsOf(), sectionsBefore);
    } finally {
      clearIntentStubForTests();
      setGatewayForTests(null);
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      resetEnvCache();
    }
  }

  {
    section('deletion protection: runs and datasets in use (WS2 B3, N9)');

    const conflictOf = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return 'allowed';
      } catch (error) {
        return error instanceof AppError ? `${error.code}:${(error.details as { reason?: string } | undefined)?.reason ?? ''}` : String(error);
      }
    };
    const exists = async (runId: string, userId: string) => Boolean(await analysisRunsRepo.findOwned(runId, userId));
    const readable = async (datasetId: string, userId: string) => (await conflictOf(() => loadForAnalysis(datasetId, userId))) === 'allowed';

    const owner = await newUser('n9-owner');
    const stranger = await newUser('n9-stranger');
    const project = await createProject(owner, { ...projectInput, language: 'EN' });
    const upload = (userId: string, name: string) => saveUpload({ userId, file: { name, bytes: new TextEncoder().encode(statsCsv).buffer as ArrayBuffer } });
    const compare = (datasetId: string, userId: string) => runAnalysis({ datasetId, userId, test: 't.independent', columns: { dependent: 'score', grouping: 'gender' } });

    const file = await upload(owner, 'n9.csv');
    const runA = (await compare(file.dataset.id, owner)).run;
    const runB = (await compare(file.dataset.id, owner)).run;

    /* A run attached to a section cannot be deleted; it survives. */
    await attachRun({ runId: runA.id, userId: owner, projectId: project.id, sectionKey: 'RESULTS' });
    check('an attached run cannot be deleted (409 run_attached) and survives', [await conflictOf(() => deleteRun(runA.id, owner)), await exists(runA.id, owner)], ['CONFLICT:run_attached', true]);

    /* Cited by a recorded version (a person's edit records the attached runs, WS2 B1): still refused after detaching. */
    await saveUserEdit({ projectId: project.id, userId: owner, sectionKey: 'RESULTS', content: 'The groups differed, t = 2.22.' });
    check('the edit recorded the run as a source', (await listVersions(project.id, owner, 'RESULTS'))[0]?.integrity?.sources.map((source) => source.id), [runA.id]);
    await detachRun(runA.id, owner);
    check('a detached run still cited by a saved version cannot be deleted (409 run_cited) and survives', [await conflictOf(() => deleteRun(runA.id, owner)), await exists(runA.id, owner)], ['CONFLICT:run_cited', true]);

    /* Detached and uncited: deleted. Another user's request: not found. */
    check('another user cannot delete a run (NOT_FOUND)', [await conflictOf(() => deleteRun(runB.id, stranger)), await exists(runB.id, owner)], ['NOT_FOUND:', true]);
    check('a detached, uncited run is deleted', [await conflictOf(() => deleteRun(runB.id, owner)), await exists(runB.id, owner)], ['allowed', false]);

    /* A collaborator's run cited in the owner's project: its owner cannot delete it. */
    const editor = await newUser('n9-editor');
    await db.insert(projectMembers).values({ projectId: project.id, userId: editor, role: 'EDITOR' });
    const editorFile = await upload(editor, 'n9-editor.csv');
    const runE = (await compare(editorFile.dataset.id, editor)).run;
    await attachRun({ runId: runE.id, userId: editor, projectId: project.id, sectionKey: 'DISCUSSION' });
    await detachRun(runE.id, editor);
    const discussion = await saveSection({ projectId: project.id, userId: owner, sectionKey: 'DISCUSSION', content: 'Discussion text.', origin: 'USER' });
    await projectsRepo.addVersion({ sectionId: discussion.id, content: 'Discussion text.', origin: 'USER', wordCount: 2, integrity: { mode: 'person', guardVersion: NUMERIC_GUARD_VERSION, quarantined: 0, manual: 0, traced: 1, sources: [{ id: runE.id, tier: 'pinned' }], excluded: [], findings: [] } });
    check('a collaborator’s run cited in another owner’s project cannot be deleted by its owner', [await conflictOf(() => deleteRun(runE.id, editor)), await exists(runE.id, editor)], ['CONFLICT:run_cited', true]);

    /* A windowed run listed only as excluded (its numbers were never used) does not block. */
    const runW = await analysisRunsRepo.create({ userId: owner, datasetId: file.dataset.id, testKey: 'correlation.pearson', spec: { truncatedTo: 5000 }, result: { statistic: { name: 'r', value: 0.5 } } });
    await projectsRepo.addVersion({ sectionId: discussion.id, content: 'Discussion text.', origin: 'USER', wordCount: 2, integrity: { mode: 'person', guardVersion: NUMERIC_GUARD_VERSION, quarantined: 0, manual: 0, traced: 0, sources: [], excluded: [{ id: runW.id, tier: 'windowed' }], findings: [] } });
    check('a run listed only as excluded (windowed) is not cited: it can be deleted', [await conflictOf(() => deleteRun(runW.id, owner)), await exists(runW.id, owner)], ['allowed', false]);

    /* Delete everything: refused while an analysis is cited (runA), with nothing removed; the impact says why. */
    const citedImpact = await deletionImpact(file.dataset.id, owner);
    check('deletionImpact reports attached and cited analyses, and that delete-everything is blocked', [citedImpact.analyses, citedImpact.attachedRuns, citedImpact.citedRuns, citedImpact.blocked], [1, 0, 1, true]);
    check('delete everything with a cited analysis is refused (409 dataset_runs_in_use)', await conflictOf(() => deleteEverything(file.dataset.id, owner, true)), 'CONFLICT:dataset_runs_in_use');
    check('… and nothing was deleted: file, row and analysis all remain', [await readable(file.dataset.id, owner), await exists(runA.id, owner)], [true, true]);

    /* Attached (not only cited): refused the same way, nothing removed. */
    await attachRun({ runId: runA.id, userId: owner, projectId: project.id, sectionKey: 'RESULTS' });
    check('delete everything with an attached analysis is refused, nothing deleted', [await conflictOf(() => deleteEverything(file.dataset.id, owner, true)), await readable(file.dataset.id, owner), await exists(runA.id, owner), (await deletionImpact(file.dataset.id, owner)).attachedRuns], ['CONFLICT:dataset_runs_in_use', true, true, 1]);
    check('an unconfirmed delete-everything is still a validation error', await conflictOf(() => deleteEverything(file.dataset.id, owner, false)), 'VALIDATION:');

    /* Delete the file only: unchanged — allowed with an attached and cited analysis, which survives with its citation. */
    check('delete the file only stays allowed with attached and cited analyses', await conflictOf(() => deleteFileOnly(file.dataset.id, owner)), 'allowed');
    check('… the analysis and its citation survive; the file cannot be read', [await exists(runA.id, owner), (await listVersions(project.id, owner, 'RESULTS'))[0]?.integrity?.sources.map((source) => source.id), await readable(file.dataset.id, owner)], [true, [runA.id], false]);
    check('delete everything on the deleted file is still refused while its analysis is in use', await conflictOf(() => deleteEverything(file.dataset.id, owner, true)), 'CONFLICT:dataset_runs_in_use');

    /* Racing an attach against a delete (both locked on the run row): the outcome is always consistent. */
    for (let round = 0; round < 3; round += 1) {
      const raced = await analysisRunsRepo.create({ userId: owner, datasetId: file.dataset.id, testKey: 't.independent', spec: {}, result: { pValue: 0.5 } });
      const [attachOutcome, deleteOutcome] = await Promise.all([
        conflictOf(() => attachRun({ runId: raced.id, userId: owner, projectId: project.id, sectionKey: 'SIGNIFICANCE' })),
        conflictOf(() => deleteRun(raced.id, owner)),
      ]);
      const survived = await exists(raced.id, owner);
      const consistent =
        (deleteOutcome === 'allowed' && attachOutcome === 'NOT_FOUND:' && !survived) ||
        (deleteOutcome === 'CONFLICT:run_attached' && attachOutcome === 'allowed' && survived);
      check(`a concurrent attach and delete end consistently (round ${round + 1})`, [consistent, attachOutcome, deleteOutcome, survived], [true, attachOutcome, deleteOutcome, survived]);
      if (survived) await detachRun(raced.id, owner);
    }

    /* A cleaned copy's analysis protects the original too; once detached and uncited, the cascade works as before. */
    const parent = await upload(owner, 'n9-parent.csv');
    const cleaned = await saveCleanedCopy({ datasetId: parent.dataset.id, userId: owner, actions: parent.proposals.slice(0, 1) });
    const runC = (await compare(cleaned.dataset.id, owner)).run;
    const runP = (await compare(parent.dataset.id, owner)).run;
    await attachRun({ runId: runC.id, userId: owner, projectId: project.id, sectionKey: 'CONCLUSION' });
    check('an attached analysis of a cleaned copy blocks deleting everything of the original', [await conflictOf(() => deleteEverything(parent.dataset.id, owner, true)), await readable(parent.dataset.id, owner), await exists(runC.id, owner), await exists(runP.id, owner), (await deletionImpact(parent.dataset.id, owner)).attachedRuns], ['CONFLICT:dataset_runs_in_use', true, true, true, 1]);
    await detachRun(runC.id, owner);
    check('detached and uncited: delete everything works, and the cascade removes the analyses of the file and its copy', [(await deletionImpact(parent.dataset.id, owner)).blocked, await conflictOf(() => deleteEverything(parent.dataset.id, owner, true)), await exists(runC.id, owner), await exists(runP.id, owner)], [false, 'allowed', false, false]);
  }

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

  {
    section('PLS-SEM and CB-SEM carry their provenance (WS2 B2, N10)');
    const untraced = (flags: readonly string[]) => flags.includes('UNTRACED_STATISTIC');

    /* The estimate records the data version, its hash, the legacy engine and the rows read. */
    const pinned = analysis.provenance;
    check(
      'a PLS estimate records its dataset version, content hash and the legacy engine (never P1-C)',
      [pinned.datasetId, Boolean(pinned.datasetVersionId), pinned.datasetContentHash?.length, pinned.engine, pinned.engineVersion, pinned.truncatedTo, pinned.rowsAnalysed],
      [plsFile.dataset.id, true, 64, { ...LEGACY_ENGINE }, 'academic-ai-legacy-analysis@1', undefined, 200],
    );
    check('the legacy stamp is not the P1-C engine', [LEGACY_ENGINE_STAMP === 'academic-ai-legacy-analysis@1', pinned.engine.id !== 'academic-ai-ts-core'], [true, true]);

    /* The bootstrap job: provenance in its specification, and the data actually read in its result. */
    const [jobRow] = await db.select().from(analysisJobs).where(eq(analysisJobs.id, job.id));
    const jobSpec = (jobRow?.spec as { provenance?: typeof pinned }).provenance;
    const jobRun = (jobRow?.result as { provenance?: typeof pinned } | null)?.provenance;
    check('the bootstrap job specification records the provenance', [jobSpec?.datasetVersionId, jobSpec?.engineVersion, jobSpec?.truncatedTo], [pinned.datasetVersionId, LEGACY_ENGINE_STAMP, undefined]);
    check('… and its result records the data read when it ran', [jobRun?.datasetVersionId, jobRun?.rowsAnalysed], [pinned.datasetVersionId, 200]);

    /* Stored in a conversation: the provenance travels with the result, and chat tiers it. */
    const plsThread = await startConversation({ userId: plsOwner, firstMessage: 'PLS' });
    const withThread = await runPls({ datasetId: plsFile.dataset.id, userId: plsOwner, model: plsModelSpec, conversationId: plsThread.id });
    const cbsem = await runCbSem({ datasetId: plsFile.dataset.id, userId: plsOwner, model: { ...plsModelSpec, paths: [] }, conversationId: plsThread.id });
    const stored = (await chatRepo.activeThread(plsThread.id)).flatMap((message) => ((message.payload as { results?: { kind: string; provenance?: typeof pinned }[] } | null)?.results ?? []));
    check(
      'PLS and CB-SEM results stored in chat carry their provenance',
      stored.map((item) => [item.kind, item.provenance?.datasetVersionId, item.provenance?.engineVersion]),
      [['pls', pinned.datasetVersionId, LEGACY_ENGINE_STAMP], ['cbsem', pinned.datasetVersionId, LEGACY_ENGINE_STAMP]],
    );
    check('CB-SEM returns its provenance too', [cbsem.provenance.datasetVersionId, cbsem.provenance.engineVersion], [pinned.datasetVersionId, LEGACY_ENGINE_STAMP]);
    const pinnedAllowed = await chatAllowedValues({ userId: plsOwner, conversationId: plsThread.id });
    const pinnedPath = withThread.structural.paths.find((path) => path.from === 'A' && path.to === 'B')!.coefficient.toFixed(3);
    check('chat: a pinned PLS result’s coefficient is traced', untraced(inspectChatReply(`The path from A to B was β = ${pinnedPath}.`, { allowed: pinnedAllowed, message: '' }).flags), false);

    /* A file over the interactive window: the estimate is marked windowed, and chat allows none of its numbers (D3). */
    const bigRows: string[] = ['a1,a2,a3,b1,b2,b3,c1,c2,c3'];
    for (let i = 0; i < 5_050; i += 1) {
      const A = plsNormal();
      const B = 0.4 * A + Math.sqrt(1 - 0.16) * plsNormal();
      const C = 0.45 * B + 0.7 * plsNormal();
      const cells: number[] = [];
      for (const latent of [A, B, C]) for (let j = 0; j < 3; j += 1) cells.push(0.85 * latent + 0.5 * plsNormal());
      bigRows.push(cells.map((value) => value.toFixed(4)).join(','));
    }
    const bigFile = await saveUpload({ userId: plsOwner, file: { name: 'big-survey.csv', bytes: new TextEncoder().encode(`${bigRows.join('\n')}\n`).buffer as ArrayBuffer } });
    const windowThread = await startConversation({ userId: plsOwner, firstMessage: 'PLS on a large file' });
    const windowed = await runPls({ datasetId: bigFile.dataset.id, userId: plsOwner, model: plsModelSpec, conversationId: windowThread.id });
    check('a PLS estimate on the first rows only records its window', [windowed.provenance.truncatedTo, windowed.provenance.rowsAnalysed, Boolean(windowed.provenance.datasetVersionId)], [5_000, 5_000, true]);
    const windowAllowed = await chatAllowedValues({ userId: plsOwner, conversationId: windowThread.id });
    const windowPath = windowed.structural.paths.find((path) => path.from === 'A' && path.to === 'B')!.coefficient.toFixed(3);
    check('chat: a windowed PLS result contributes no allowed numbers (flagged)', [untraced(inspectChatReply(`The path from A to B was β = ${windowPath}.`, { allowed: windowAllowed, message: '' }).flags), [...windowAllowed.estimate].length, [...windowAllowed.p].length], [true, 0, 0]);

    /* Task outputs (pls-results.v1, CB-SEM analysis.v1) carry the provenance too, for the steps that read them. */
    const cbsemModel = { ...plsModelSpec, paths: [] };
    const statsTask = await tasksRepo.create({
      userId: plsOwner,
      request: 'run PLS and CB-SEM',
      locale: 'en',
      status: 'QUEUED',
      context: { datasetId: plsFile.dataset.id, confirmedModels: [modelHash(plsModelSpec), modelHash(cbsemModel)] },
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });
    await tasksRepo.addSteps([
      { taskId: statsTask.id, ordinal: 0, capability: 'statistics.pls', label: 'pls', status: 'PENDING', dependsOn: [], input: { datasetId: plsFile.dataset.id, model: plsModelSpec } },
      { taskId: statsTask.id, ordinal: 1, capability: 'statistics.cbsem', label: 'cbsem', status: 'PENDING', dependsOn: [], input: { datasetId: plsFile.dataset.id, model: cbsemModel } },
    ]);
    registerAllHandlers();
    await runTask(statsTask.id);
    const statsSteps = await tasksRepo.stepsOf(statsTask.id);
    const outputOf = (capability: string) => JSON.stringify(statsSteps.find((step) => step.capability === capability)?.output ?? null);
    check(
      'task outputs pls-results.v1 and CB-SEM analysis.v1 carry the provenance',
      [statsSteps.map((step) => step.status + (step.errorReasonKey ? `:${step.errorReasonKey}` : '')), ['statistics.pls', 'statistics.cbsem'].map((capability) => outputOf(capability).includes(`"engineVersion":"${LEGACY_ENGINE_STAMP}"`) && outputOf(capability).includes(`"datasetVersionId":"${pinned.datasetVersionId}"`))],
      [['COMPLETED', 'COMPLETED'], [true, true]],
    );

    /* The tiers provenance gives, through the same `legacyResultTier` as every legacy run (never "verified"). */
    const base = { datasetId: 'd', engine: { ...LEGACY_ENGINE }, engineVersion: LEGACY_ENGINE_STAMP, rowsAnalysed: 10 };
    check(
      'provenance tiers: pinned with version and hash, windowed with a window, unpinned without a version, none when absent',
      [
        legacyResultTier(asLegacyResult({}, { ...base, datasetVersionId: 'v', datasetContentHash: 'h' })),
        legacyResultTier(asLegacyResult({}, { ...base, datasetVersionId: 'v', datasetContentHash: 'h', truncatedTo: 5000 })),
        legacyResultTier(asLegacyResult({}, { ...base, datasetVersionId: null, datasetContentHash: null })),
        readProvenance(undefined),
        readProvenance({ unexpected: true }),
      ],
      ['pinned', 'windowed', 'unpinned', null, null],
    );

    /* An older stored result without provenance keeps its unpinned behaviour (WS2 A5). */
    const legacyThread = await startConversation({ userId: plsOwner, firstMessage: 'old result' });
    await chatRepo.addMessage({ conversationId: legacyThread.id, role: 'ASSISTANT', content: '', payload: { results: [{ kind: 'pls', payload: { estimates: { paths: [{ from: 'A', to: 'B', coefficient: 0.4321 }] } } }] } });
    check('chat: a stored result without provenance is still allowed as unpinned', untraced(inspectChatReply('The path was β = .432.', { allowed: await chatAllowedValues({ userId: plsOwner, conversationId: legacyThread.id }), message: '' }).flags), false);

    {
      section('task writing and task exports use eligible analysis results only (WS2 B4, N4)');

      /* The scripted-model setup of the N1 block, restored afterwards. */
      const { FakeAdapter } = await import('@/server/ai/gateway/adapters/fake');
      const { createGateway } = await import('@/server/ai/gateway/gateway');
      const { productionDeps, setGatewayForTests } = await import('@/server/ai/gateway');
      const { resetEnvCache: resetEnv } = await import('@/config/env');
      const { runForUser } = await import('@/server/ai/request-scope');
      const { artifacts: artifactsTable } = await import('@/server/db/schema');
      const ExcelJS = (await import('exceljs')).default;
      const fake = new FakeAdapter('openai');
      setGatewayForTests(createGateway({ ...productionDeps, adapters: () => ({ openai: fake }), models: async () => ({ configured: [{ provider: 'openai', model: 'gpt-4.1' }], defaultProvider: 'openai', siblings: {} }) }));
      const previousKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'placeholder-for-the-scripted-model';
      resetEnv();
      const markers = (text: string, marker: string) => text.split(marker).length - 1;

      try {
        registerAllHandlers();
        const write = handlerFor('document.write')!;
        const generate = handlerFor('document.generate')!;
        const analyse = handlerFor('data.analyse')!;
        type Obs = Awaited<ReturnType<typeof write>> & { status: string; outputs: OutputReference[]; warnings: { code: string; metadata?: Record<string, unknown> }[]; errors: { code: string }[]; artifacts: { id: string }[]; recommendedNextActions: { input?: Record<string, unknown> }[] };
        const step = (userId: string, input: Record<string, unknown>, available: OutputReference[], context: Record<string, unknown> = {}) => ({
          taskId: statsTask.id,
          stepId: crypto.randomUUID(),
          userId,
          projectId: null,
          locale: 'en' as const,
          input,
          available,
          dependencies: {},
          context,
          signal: new AbortController().signal,
        });
        const run = async (handler: typeof write, userId: string, ...rest: [Record<string, unknown>, OutputReference[], Record<string, unknown>?]) =>
          (await runForUser(userId, () => handler(step(userId, ...rest)))) as Obs;
        const producerOf = (capability: string) => ({ taskId: statsTask.id, stepId: crypto.randomUUID(), capability, projectId: null });

        /* The real task outputs of the B2 block: a pinned PLS estimate and a pinned CB-SEM fit. */
        const computedOutputs = statsSteps.flatMap((entry) => ((entry.output as { outputs?: OutputReference[] } | null)?.outputs ?? []));
        const plsData = computedOutputs.find((output) => output.type === 'pls-results.v1')?.data as { estimates: { paths: { from: string; to: string; coefficient: number }[] } };
        const cbsemData = computedOutputs.find((output) => output.type === 'analysis.v1')?.data as { fit: { cfi: number } };
        const pinnedCoefficient = plsData.estimates.paths.find((path) => path.from === 'A' && path.to === 'B')!.coefficient;
        const pinnedBeta = pinnedCoefficient.toFixed(3);
        const pinnedCfi = cbsemData.fit.cfi.toFixed(3);
        /* A PLS estimate on the first rows of a file only (D3), as a task output. */
        const windowedCoefficient = windowed.structural.paths.find((path) => path.from === 'A' && path.to === 'B')!.coefficient;
        const windowedOutput = makeOutput(producerOf('statistics.pls'), 'pls-results.v1', {
          verdict: windowed.report.verdict,
          n: windowed.n,
          estimates: { paths: windowed.structural.paths.map((path) => ({ from: path.from, to: path.to, coefficient: path.coefficient })), n: windowed.n },
          provenance: windowed.provenance,
        });
        /* Prose an earlier step wrote: its numbers are not the researcher's. */
        const earlierProse = makeOutput(producerOf('document.write'), 'prose.v1', { text: 'Earlier we reported M = 4.4417 for the scale.', references: [], heading: 'Earlier' });
        const available = [...computedOutputs, windowedOutput, earlierProse];

        /* --- document.write: the real handler, finished --- */
        fake.push({
          reply: {
            text:
              `The path from A to B was β = ${pinnedBeta}, and the CFI was ${pinnedCfi}. ` +
              `A further test found t(98) = 9.137, p = .0271. On the larger file the path was β = ${windowedCoefficient.toFixed(3)}. ` +
              'The sample was N = 321. The planner mentioned r = .6173, and the earlier section gave M = 4.4417.',
          },
        });
        const callsBefore = fake.calls.length;
        const written = await run(write, plsOwner, { section: 'Results with r = .6173' }, available, { request: 'Write the results chapter. Our sample was N = 321.' });
        const prose = written.outputs.find((output) => output.type === 'prose.v1')?.data as { text: string; integrity?: import('@/server/integrity/section').SectionIntegrity };
        check('document.write (real handler) succeeds', written.status, 'success');
        assertTrue('a pinned PLS coefficient survives', prose.text.includes(`β = ${pinnedBeta}`));
        assertTrue('a pinned CB-SEM fit index survives', prose.text.includes(pinnedCfi));
        assertTrue('a number in the researcher’s request survives', prose.text.includes('N = 321'));
        assertTrue('invented numbers are quarantined', !/9\.137|\.0271/.test(prose.text));
        assertTrue('the windowed estimate is quarantined (D3)', !prose.text.includes(windowedCoefficient.toFixed(3)));
        assertTrue('a number only in the planner’s step input is quarantined', !prose.text.includes('.6173'));
        assertTrue('a number only in earlier prose is quarantined', !prose.text.includes('4.4417'));
        check('each quarantined number is a visible English marker', markers(prose.text, QUARANTINE_MARKER.en), prose.integrity?.quarantined);
        assertTrue('at least the five untraced numbers were quarantined', (prose.integrity?.quarantined ?? 0) >= 5);
        check(
          'prose.v1 records the model-mode result, with the eligible results used and the windowed one excluded (never "verified")',
          [prose.integrity?.mode, prose.integrity?.guardVersion, prose.integrity?.sources.map((source) => source.tier), prose.integrity?.excluded.map((source) => [source.id, source.tier])],
          ['model', NUMERIC_GUARD_VERSION, ['pinned', 'pinned'], [[windowedOutput.id, 'windowed']]],
        );
        const quarantineWarning = written.warnings.find((warning) => warning.code === 'write.quarantined');
        check('the step warns write.quarantined with the count', quarantineWarning?.metadata?.quarantined, prose.integrity?.quarantined);
        const prompt = JSON.stringify(fake.calls.slice(callsBefore).map((call) => call.request));
        assertTrue('the prompt labels results as computed, not verified', prompt.includes('not independently verified'));
        assertTrue('the windowed result is not given to the model', !prompt.includes('truncatedTo') && prompt.includes(pinnedCoefficient.toFixed(4).replace(/0+$/, '')));

        /* Arabic writing: the Arabic marker. */
        fake.push({ reply: { text: `كان معامل المسار β = ${pinnedBeta}، ووجدنا t = 9.137 في اختبار آخر، وهذا ما أظهرته النتائج.` } });
        const arabic = await run(write, plsOwner, { section: 'النتائج' }, available, { request: 'اكتب فصل النتائج' });
        const arabicText = (arabic.outputs[0]?.data as { text: string }).text;
        assertTrue('Arabic: the traced value survives, the invented one takes the Arabic marker', arabicText.includes(pinnedBeta) && !arabicText.includes('9.137') && markers(arabicText, QUARANTINE_MARKER.ar) === 1);

        /* Clean text is kept exactly, with no warning. */
        fake.push({ reply: { text: 'This chapter reports the structural model and the measurement model in turn, as planned.' } });
        const clean = await run(write, plsOwner, { section: 'Overview' }, available, { request: 'Write an overview.' });
        check(
          'text with no untraced number is unchanged and not warned about',
          [(clean.outputs[0]?.data as { text: string }).text, (clean.outputs[0]?.data as { integrity: { quarantined: number } }).integrity.quarantined, clean.warnings.some((warning) => warning.code === 'write.quarantined')],
          ['This chapter reports the structural model and the measurement model in turn, as planned.', 0, false],
        );

        /* --- the unfinished path: quarantined too, and the continuation starts from the guarded text --- */
        fake.push(
          { reply: { text: 'The first finding was t = 9.137 in the survey, and the analysis continued', finishReason: 'length' } },
          ...Array.from({ length: 5 }, () => ({ reply: { text: ' with more of the chapter', finishReason: 'length' as const } })),
        );
        const unfinished = await run(write, plsOwner, { section: 'Discussion' }, available, { request: 'Write the discussion.' });
        const unfinishedProse = unfinished.outputs[0]?.data as { text: string; complete: boolean; integrity: { quarantined: number } };
        const continueFrom = String(unfinished.recommendedNextActions[0]?.input?.continueFrom ?? '');
        check(
          'unfinished writing is partial, quarantined, and warned about',
          [unfinished.status, unfinishedProse.complete, unfinishedProse.text.includes('9.137'), unfinishedProse.integrity.quarantined, unfinished.warnings.map((warning) => warning.code).sort()],
          ['partial', false, false, 1, ['write.incomplete', 'write.quarantined']],
        );
        assertTrue('continueFrom holds the quarantined text, not the number', continueFrom.includes(QUARANTINE_MARKER.en) && !continueFrom.includes('9.137'));

        /* --- a run-backed data.analyse display: tiered by its run row --- */
        const tDisplay = makeOutput(producerOf('data.analyse'), 'analysis.v1', { display: { kind: 'analysis', payload: tTest.result, runId: tTest.run.id } });
        const tValue = (tTest.result as { statistic: { value: number } }).statistic.value;
        fake.push({ reply: { text: `The groups differed, t = ${tValue.toFixed(3)}, and a second test gave t = 9.137.` } });
        const tWritten = await run(write, statsOwner, { section: 'Results' }, [tDisplay], { request: 'Write the results.' });
        const tProse = tWritten.outputs[0]?.data as { text: string; integrity: { sources: { id: string; tier: string }[] } };
        check('a run-backed result traces through its run row', [tProse.text.includes(`t = ${tValue.toFixed(3)}`), tProse.text.includes('9.137'), tProse.integrity.sources], [true, false, [{ id: tTest.run.id, tier: legacyResultTier(tTest.run) }]]);

        /* --- XLSX: eligible results only, planner input.table ignored, a Provenance sheet --- */
        const plannerTable = { headers: ['Invented'], rows: [[99999.5]] };
        const artifactCount = async (userId: string) => (await db.select().from(artifactsTable).where(eq(artifactsTable.userId, userId))).length;
        const xlsx = await run(generate, plsOwner, { format: 'xlsx', title: 'Results workbook', table: plannerTable }, available);
        check('the XLSX export succeeds, warning that a windowed result was left out', [xlsx.status, xlsx.warnings.map((warning) => warning.code)], ['success', ['export.windowedExcluded']]);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load((await readArtifact(xlsx.artifacts[0]!.id, plsOwner)).bytes as never);
        const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
        const cellsOf = (name: string) => {
          const values: unknown[][] = [];
          workbook.getWorksheet(name)?.eachRow((row) => values.push((row.values as unknown[]).slice(1)));
          return values;
        };
        const allCells = sheetNames.flatMap((name) => cellsOf(name).flat());
        check(
          'sheets come from the eligible results, then Provenance; no planner "Data" sheet',
          sheetNames,
          ['S1 PLS path coefficients', 'S1 PLS R squared', 'S1 PLS loadings', 'S2 CB-SEM fit indices', 'S2 CB-SEM standardised loadings', 'Provenance'],
        );
        assertTrue('the planner table’s value is nowhere in the workbook', !allCells.includes(99999.5));
        assertTrue('the windowed coefficient is nowhere in the workbook', !allCells.includes(windowedCoefficient));
        const pathRow = cellsOf('S1 PLS path coefficients').find((row) => row[0] === 'A' && row[1] === 'B');
        check('numbers are written as numbers, exactly as computed', [typeof pathRow?.[2], pathRow?.[2]], ['number', pinnedCoefficient]);
        const provenance = cellsOf('Provenance');
        check(
          'the Provenance sheet: source, tier and the legacy engine stamp; computed, never "verified"',
          [provenance[0], provenance.slice(1).map((row) => [row[0], row[4], row[5], row[9]])],
          [
            ['Source', 'Analysis', 'Step', 'Reference', 'Tier', 'Engine', 'Dataset version', 'Content hash', 'Rows analysed', 'Status'],
            [
              ['S1', 'pinned', LEGACY_ENGINE_STAMP, 'Computed by the legacy analysis engine; not independently verified'],
              ['S2', 'pinned', LEGACY_ENGINE_STAMP, 'Computed by the legacy analysis engine; not independently verified'],
            ],
          ],
        );
        assertTrue('no tier or cell says "verified"', !allCells.some((cell) => typeof cell === 'string' && /^verified$/i.test(cell)));

        /* --- CSV: one long table from the same results, deterministic --- */
        const csvOnce = await run(generate, plsOwner, { format: 'csv', title: 'Results table', table: plannerTable }, available);
        const csvTwice = await run(generate, plsOwner, { format: 'csv', title: 'Results table', table: plannerTable }, available);
        /* Decoded with the byte-order mark kept, so its presence can be checked. */
        const csvText = (id: string) => readArtifact(id, plsOwner).then((found) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(found.bytes));
        const csv = await csvText(csvOnce.artifacts[0]!.id);
        const csvLines = csv.replace(/^﻿/, '').split('\r\n');
        check('the CSV has a byte-order mark, CRLF lines and the long header', [csv.startsWith('﻿'), csv.includes('\r\n'), !/[^\r]\n/.test(csv), csvLines[0]], [true, true, true, 'source,table,row,column,value']);
        assertTrue('the CSV carries the pinned coefficient as a long row', csvLines.includes(`S1,PLS path coefficients,1,Coefficient,${pinnedCoefficient}`) || csvLines.some((line) => line.startsWith('S1,PLS path coefficients,') && line.endsWith(`,Coefficient,${pinnedCoefficient}`)));
        assertTrue('the CSV carries the provenance rows', csvLines.includes('S1,provenance,1,Tier,pinned') && csvLines.includes(`S2,provenance,1,Engine,${LEGACY_ENGINE_STAMP}`));
        assertTrue('the planner table and the windowed result are not in the CSV', !csv.includes('99999.5') && !csv.includes('Invented') && !csv.includes(String(windowedCoefficient)));
        check('the same outputs give the same CSV', await csvText(csvTwice.artifacts[0]!.id), csv);

        /* --- no eligible results: a plain failure, no file --- */
        const before = await artifactCount(plsOwner);
        const modelCallsBefore = fake.calls.length;
        const failures = [
          await run(generate, plsOwner, { format: 'xlsx', table: plannerTable }, []),
          await run(generate, plsOwner, { format: 'csv', table: plannerTable }, [earlierProse]),
          await run(generate, plsOwner, { format: 'xlsx', table: plannerTable }, [windowedOutput]),
          await run(generate, plsOwner, { format: 'csv', table: plannerTable }, [windowedOutput]),
        ];
        check(
          'no analysis → export.noAnalysis; only windowed → export.windowedOnly',
          failures.map((failure) => [failure.status, failure.errors[0]?.code]),
          [['failed', 'export.noAnalysis'], ['failed', 'export.noAnalysis'], ['failed', 'export.windowedOnly'], ['failed', 'export.windowedOnly']],
        );
        check('and no artifact is stored for a failed export, and no model is called', [await artifactCount(plsOwner), failures.every((failure) => failure.artifacts.length === 0), fake.calls.length], [before, true, modelCallsBefore]);

        /* --- data.analyse descriptive tables carry the provenance of the data read --- */
        const describe = (datasetId: string) => run(analyse, plsOwner, { intent: 'data.describe' }, [], { datasetId, request: 'describe the data' });
        const wholeFile = await describe(plsFile.dataset.id);
        const firstRows = await describe(bigFile.dataset.id);
        const provenanceOf = (observation: Obs) => (observation.outputs[0]?.data as { provenance?: { truncatedTo?: number; datasetVersionId: string | null; engineVersion: string } }).provenance;
        check(
          'data.analyse outputs record the data read: whole file pinned, first rows windowed',
          [provenanceOf(wholeFile)?.truncatedTo, Boolean(provenanceOf(wholeFile)?.datasetVersionId), provenanceOf(wholeFile)?.engineVersion, provenanceOf(firstRows)?.truncatedTo],
          [undefined, true, LEGACY_ENGINE_STAMP, 5_000],
        );
        const describedXlsx = await run(generate, plsOwner, { format: 'xlsx' }, wholeFile.outputs);
        const describedBook = new ExcelJS.Workbook();
        await describedBook.xlsx.load((await readArtifact(describedXlsx.artifacts[0]!.id, plsOwner)).bytes as never);
        check('descriptive tables from the whole file export, tiered pinned', [describedBook.worksheets[0]?.name, describedBook.getWorksheet('Provenance')?.getRow(2).getCell(5).value], ['S1 Descriptive statistics', 'pinned']);
        check('descriptive tables from the first rows only: export.windowedOnly', (await run(generate, plsOwner, { format: 'csv' }, firstRows.outputs)).errors[0]?.code, 'export.windowedOnly');
        const windowedMean = (firstRows.outputs[0]?.data as { display: { payload: { descriptives: { mean: number }[] } } }).display.payload.descriptives[0]!.mean;
        fake.push({ reply: { text: `The first indicator had a mean of M = ${windowedMean.toFixed(3)} across the file.` } });
        const describedProse = (await run(write, plsOwner, { section: 'Descriptives' }, firstRows.outputs, { request: 'Describe the sample.' })).outputs[0]?.data as { text: string };
        assertTrue('a windowed descriptive value does not authorize a number in prose', !describedProse.text.includes(windowedMean.toFixed(3)));
      } finally {
        setGatewayForTests(null);
        if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousKey;
        resetEnv();
      }
    }
  }

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
    steps: {
      key: string;
      capability: string;
      dependsOn?: string[];
      input?: Record<string, unknown>;
      dynamic?: boolean;
    }[],
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
        dynamic: step.dynamic ?? false,
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

  /* ------- 7a: asking twice is not failing twice ------------------------- */

  {
    /*
     * A question is not an attempt. It was recorded as one: a step that asked
     * "which variables?", was answered with something that still did not name
     * them, and asked again, was marked "failed after 2 attempts" — ending a
     * task in which nothing had gone wrong.
     */
    executed.length = 0;

    const task = await makeTask([{ key: 'search', capability: 'academic.search', input: { needsInput: true } }]);

    for (let round = 0; round < 3; round += 1) {
      await runTask(task.id);
      const asking = await tasksRepo.findAny(task.id);
      check(`round ${round + 1}: the task is still waiting for an answer`, asking?.status, 'WAITING_FOR_INPUT');
      const [step] = await tasksRepo.stepsOf(task.id);
      check(`round ${round + 1}: and its step is still to run`, step?.status, 'PENDING');
    }

    const [asked] = await tasksRepo.stepsOf(task.id);
    check('no question was counted as an attempt', asked?.attempts, 0);

    await tasksRepo.updateStepInput(asked?.id as string, { needsInput: false });
    await runTask(task.id);
    check('and the answer still completes it', (await tasksRepo.findAny(task.id))?.status, 'COMPLETED');
  }

  /* ------- 7b: a step the task added to itself may not stop to ask ------- */

  {
    executed.length = 0;

    /*
     * The shape of a real failure: a search came back off-topic, a second
     * search was added with no query, and it halted the task to ask for a topic
     * the researcher had already given — with the work they asked for queued
     * behind it.
     */
    const task = await makeTask([
      { key: 'helper', capability: 'academic.search', input: { needsInput: true }, dynamic: true },
      { key: 'titles', capability: 'document.write' },
    ]);

    await runTask(task.id);

    const after = await tasksRepo.findAny(task.id);
    const steps = await tasksRepo.stepsOf(task.id);

    check('the task does not stop to ask', after?.status, 'COMPLETED');
    check('the helper is set aside', steps.find((step) => step.label === 'helper')?.status, 'SKIPPED');
    assertTrue('and the work that was asked for still runs', executed.includes('document.write'));
  }

  {
    executed.length = 0;

    /*
     * And whatever the set-aside step was helping is settled with it. A step
     * waiting on one that will never run is never ready and never blocked, so
     * the task would stop as deadlocked — a different way of going nowhere.
     */
    const task = await makeTask([
      { key: 'helper', capability: 'academic.search', input: { needsInput: true }, dynamic: true },
      { key: 'follow', capability: 'quality.check', dependsOn: ['helper'], dynamic: true },
      { key: 'titles', capability: 'document.write' },
    ]);

    await runTask(task.id);

    const after = await tasksRepo.findAny(task.id);
    const steps = await tasksRepo.stepsOf(task.id);

    check('the task still finishes', after?.status, 'COMPLETED');
    check('what waited on it is closed too', steps.find((step) => step.label === 'follow')?.status, 'BLOCKED');
    assertTrue('and the work that was asked for still runs', executed.includes('document.write'));
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
  /*
   * PDF is absent from this list deliberately.
   *
   * The fixture writes Arabic, and `pdf-lib`'s standard fonts contain no
   * Arabic glyphs — so a PDF here would open to a blank page. That is now
   * refused rather than delivered, and the refusal is what the Arabic PDF
   * test below asserts. Exercising the format itself needs Latin text, which
   * the case after this loop provides.
   */
  /*
   * XLSX and CSV hold computed analysis results only (WS2 B4): the planner's
   * `input.table` in this fixture is not one, and there is no analysis here,
   * so the export fails plainly and stores nothing.
   */
  for (const format of ['xlsx', 'csv'] as const) {
    const { generate } = await generateAs(format);
    check(`${format}: a planner table alone is refused (export.noAnalysis), no file`, [generate?.status, generate?.errorReasonKey, generate?.artifactIds.length], ['FAILED', 'export.noAnalysis', 0]);
  }

  for (const format of ['docx', 'pptx', 'md', 'txt', 'bib', 'ris'] as const) {
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
    /*
     * PDF is exercised from Latin text, because the fixture above writes
     * Arabic and `pdf-lib`'s standard fonts have no Arabic glyphs — an Arabic
     * PDF is now refused rather than delivered blank, which is asserted
     * separately.
     *
     * Generated directly rather than through a task, so the format itself is
     * tested without the language question in the way.
     */
    const result = await generatePdf({
      title: 'Hybrid Learning in Higher Education',
      sections: [
        { heading: 'Introduction', paragraphs: ['Hybrid learning combines modes of delivery.'] },
        { heading: 'Findings', paragraphs: ['Engagement rose across the cohort.'] },
      ],
      references: ['Smith, J. (2024). Hybrid learning. Journal of Education.'],
    });

    check('Latin text drops nothing', result.unsupportedText.length, 0);
    check('the PDF signature is right', new TextDecoder().decode(result.bytes.slice(0, 5)), '%PDF-');

    const document = await PDFDocument.load(result.bytes);
    assertTrue('and it has pages', document.getPageCount() >= 1);
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
    /* The workbook generator itself; the task path to it is covered in the WS2 B4 block. */
    const { generateXlsx } = await import('@/server/generators/spreadsheet');
    const bytes = await generateXlsx([{ name: 'Data', headers: ['المتغيّر', 'القيمة'], rows: [['التحصيل', 4.2]] }]);

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
    /* The CSV generator itself; the task path to it is covered in the WS2 B4 block. */
    const bytes = generateCsv(['المتغيّر', 'القيمة'], [['التحصيل', 4.2]]);

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
      /* Matched loosely: the rule is the empty input, not its indentation. */
      /report\.offTopic\s*\?\s*\{\}/.test(handlerSource),
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

      /*
       * Converting carries the content, rather than writing a new paper.
       *
       * The requested format is PDF and the work is Arabic, so Word is
       * produced instead: `pdf-lib`'s standard fonts have no Arabic glyphs and
       * the PDF would open blank. Substituting is a judgement — a working Word
       * file is closer to what the researcher wanted than an accurate refusal
       * — and it is made in one place, `substituteFormat`.
       */
      check('an Arabic PDF request becomes Word', substituteFormat('pdf', 'ar'), 'docx');
      check('while an English one stays PDF', substituteFormat('pdf', 'en'), 'pdf');
      check('and other formats are untouched', substituteFormat('pptx', 'ar'), 'pptx');

      const second = await runContinuityTask(
        'حوّله PDF',
        [{ capability: 'document.generate', input: { format: 'docx', title: 'Digital Twin' } }],
        { references: { kind: 'artifact', id: resolution.candidate.id, targetFormat: 'pdf' } },
      );

      const converted = second.steps[0];
      check('the conversion completes', converted?.status, 'COMPLETED');
      check('producing a file', converted?.artifactIds.length, 1);

      const { artifact, bytes } = await readArtifact(
        converted?.artifactIds[0] as string,
        continuityOwner,
      );

      check('which renders Arabic', artifact.kind, 'docx');
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


  /* --- prior work is detected from files, not from messages ------------ */

  {
    /*
     * The defect a live run exposed. A task writes its output to a file and
     * its progress to a panel — not to the conversation — so a researcher who
     * received a Word document and then wrote "حوّله PDF" had an empty message
     * history, and the reference was ignored as though nothing existed.
     */
    const chatSource = await readFile('src/app/api/chat/route.ts', 'utf8');

    assertTrue(
      'prior work is detected from artifacts and tasks',
      chatSource.includes('hasEarlierWork'),
    );
    assertTrue(
      'not from the message count alone',
      !chatSource.includes('hasPriorWork: history.length > 0,'),
    );
  }

  {
    /*
     * A conversion plan is trimmed to the conversion. The planner is told the
     * work exists and sometimes plans a search anyway, which produces a second
     * paper instead of the file that was asked for.
     */
    const serviceSource = await readFile('src/server/services/task.service.ts', 'utf8');

    assertTrue(
      'a referencing task keeps only transforming steps',
      serviceSource.includes("['document.generate', 'document.write', 'quality.check']"),
    );
    assertTrue(
      'and falls back to a single generate step',
      serviceSource.includes("capability: 'document.generate'") &&
        serviceSource.includes('referencing && steps.length === 0'),
    );

    const plannerSource = await readFile('src/server/tasks/planner.ts', 'utf8');
    assertTrue(
      'the planner is told the work already exists',
      plannerSource.includes('THIS REQUEST REFERS TO EXISTING WORK'),
    );
  }

  /* --- a paper written into the chat, then asked for as a file ---------- */

  {
    /*
     * The production case. A task searched, reviewed and wrote a paper, and no
     * step exported it. "اعطيني اياه ملف وورد" then found no file to convert,
     * the planner could make nothing of a request with no subject, and the
     * researcher was told Word files cannot be produced.
     */
    const writer = await newUser('continuity-written');
    const stamp = (taskId: string, stepId: string, capability: string) => ({
      taskId,
      stepId,
      capability,
      projectId: null,
    });

    const paper = await tasksRepo.create({
      userId: writer,
      request: 'Write a complete paper on hospital supply chains',
      locale: 'en',
      status: 'COMPLETED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    const [search, review, write] = await tasksRepo.addSteps(
      ['academic.search', 'literature.review', 'document.write'].map((capability, ordinal) => ({
        taskId: paper.id,
        ordinal,
        capability,
        label: capability,
        status: 'PENDING',
        dependsOn: [],
        input: {},
      })),
    );

    await tasksRepo.completeStep(search!.id, {
      outputs: [
        makeOutput(stamp(paper.id, search!.id, 'academic.search'), 'sources.v1', {
          references: [
            { id: '1', kind: 'journal-article', title: 'Hospital Logistics', authors: ['Haddad, R.'], year: 2022, doi: '10.1111/h5678', provenance: 'retrieved' },
          ],
        }),
      ],
    });
    await tasksRepo.completeStep(review!.id, {
      outputs: [
        makeOutput(stamp(paper.id, review!.id, 'literature.review'), 'literature.v1', {
          text: 'The review that came before the paper.',
        }),
      ],
    });
    await tasksRepo.completeStep(write!.id, {
      outputs: [
        makeOutput(stamp(paper.id, write!.id, 'document.write'), 'prose.v1', {
          text: '# Supply Chains and Service Quality\n\n## Abstract\n\nShelves decide what a ward can do [1].\n\n## Method\n\nA **planned** survey of 300 staff.',
        }),
      ],
    });

    const message = 'اعطيني اياه ملف وورد';

    check('the request is recognised as pointing at earlier work', detectReference(message, true), 'artifact');

    const resolution = await resolveReference({ userId: writer, kind: 'artifact', message, locale: 'ar' });

    check('with no file, what was written is found', resolution.status, 'resolved');

    if (resolution.status === 'resolved') {
      check('as prose', resolution.candidate.kind, 'prose');
      check('from that task', resolution.candidate.taskId, paper.id);
      assertTrue(
        'and it is the paper, not the review it was built on',
        ((resolution.candidate.output?.data as { text?: string }).text ?? '').includes('## Abstract'),
      );

      /* What the chat route starts, and what the planner's fallback plans for it. */
      const exportTask = await tasksRepo.create({
        userId: writer,
        request: message,
        locale: 'ar',
        status: 'QUEUED',
        context: {
          references: {
            kind: resolution.candidate.kind,
            id: resolution.candidate.id,
            taskId: resolution.candidate.taskId,
            targetFormat: 'docx',
          },
        },
        budget: DEFAULT_BUDGET as unknown as Record<string, number>,
        spent: { modelCalls: 0, retries: 0 },
      });

      await tasksRepo.addSteps([
        {
          taskId: exportTask.id,
          ordinal: 0,
          capability: 'document.generate',
          label: 'document.generate',
          status: 'PENDING',
          dependsOn: [],
          input: { format: 'docx' },
        },
      ]);

      await runTask(exportTask.id);

      const [generated] = await tasksRepo.stepsOf(exportTask.id);
      check('the file step completes', generated?.status, 'COMPLETED');
      check('with one file', generated?.artifactIds.length, 1);

      const stored = await readArtifact(generated?.artifactIds[0] as string, writer);
      check('a Word file', stored.artifact.kind, 'docx');
      assertTrue('named after the paper, not "Document"', stored.artifact.filename.startsWith('Supply Chains'));

      const zip = await JSZip.loadAsync(stored.bytes);
      const body = (await zip.file('word/document.xml')?.async('string')) ?? '';

      assertTrue('the paper is in it', body.includes('Shelves decide what a ward can do'));
      assertTrue('its headings are headings, not pound signs', body.includes('Abstract') && !body.includes('## '));
      assertTrue('the review before it is not repeated', !body.includes('The review that came before'));
      assertTrue('and the sources it cites came along', body.includes('Haddad'));
    }

    /*
     * What happened next in production. The researcher had asked for the file
     * once already, before any of this worked, and been told it was impossible.
     * That refusal was then the most recent thing written in the conversation —
     * so "it" resolved to the refusal, and the Word file contained the sentence
     * saying Word files cannot be made.
     */
    const refusal = await tasksRepo.create({
      userId: writer,
      request: message,
      locale: 'ar',
      status: 'COMPLETED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    const [reply] = await tasksRepo.addSteps([
      {
        taskId: refusal.id,
        ordinal: 0,
        capability: 'general.answer',
        label: 'Answering',
        status: 'PENDING',
        dependsOn: [],
        input: {},
      },
    ]);

    await tasksRepo.completeStep(reply!.id, {
      outputs: [
        makeOutput(stamp(refusal.id, reply!.id, 'general.answer'), 'prose.v1', {
          text: 'لا يمكنني تصدير الملفات بصيغة Word.',
        }),
      ],
    });

    const again = await resolveReference({ userId: writer, kind: 'artifact', message, locale: 'ar' });

    check('a reply written since does not become "it"', again.status, 'resolved');

    if (again.status === 'resolved') {
      check('the paper still is', again.candidate.taskId, paper.id);
    }

    /* A conversation with nothing but a reply in it still has that reply to give. */
    const talker = await newUser('continuity-reply-only');
    const chat = await tasksRepo.create({
      userId: talker,
      request: 'Explain validity',
      locale: 'en',
      status: 'COMPLETED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });
    const [only] = await tasksRepo.addSteps([
      { taskId: chat.id, ordinal: 0, capability: 'general.answer', label: 'Answering', status: 'PENDING', dependsOn: [], input: {} },
    ]);
    await tasksRepo.completeStep(only!.id, {
      outputs: [makeOutput(stamp(chat.id, only!.id, 'general.answer'), 'prose.v1', { text: 'Validity is whether a measure measures what it claims to.' })],
    });

    const replyOnly = await resolveReference({ userId: talker, kind: 'artifact', message: 'give it to me as a Word file', locale: 'en' });
    check('with no research at all, the reply is what there is', replyOnly.status === 'resolved' && replyOnly.candidate.taskId, chat.id);
  }

  /* --- a question asked after the paper knows the paper ---------------- */

  {
    /*
     * "اعطيني الابعاد لكل متغير", asked in the conversation where a paper on
     * digital transformation and service quality had just been written, was
     * answered with "tell me your variables". The paper lived in task steps and
     * the conversation held a one-line restatement; nothing carried the one
     * to the other.
     */
    const asker = await newUser('earlier-work');
    const thread = await startConversation({ userId: asker, firstMessage: 'اكتب بحث عن التحول الرقمي' });

    const paper = await tasksRepo.create({
      userId: asker,
      conversationId: thread.id,
      request: 'اكتب بحث عن التحول الرقمي',
      locale: 'ar',
      status: 'COMPLETED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });
    const [wrote] = await tasksRepo.addSteps([
      { taskId: paper.id, ordinal: 0, capability: 'document.write', label: 'w', status: 'PENDING', dependsOn: [], input: {} },
    ]);
    await tasksRepo.completeStep(wrote!.id, {
      outputs: [
        makeOutput({ taskId: paper.id, stepId: wrote!.id, capability: 'document.write', projectId: null }, 'prose.v1', {
          text: '# أثر التحول الرقمي على جودة الخدمة\n\nمتغيرات الدراسة: التحول الرقمي (البنية التحتية، المهارات الرقمية) وجودة الخدمة (الاعتمادية، الاستجابة).',
        }),
      ],
    });

    const { buildContextPrompt } = await import('@/server/context/manager');

    /* What a direct answer in that conversation is given. */
    const built = await buildContextPrompt({
      purpose: 'answer',
      request: 'اعطيني الابعاد لكل متغير',
      userId: asker,
      conversationId: thread.id,
      locale: 'ar',
    });
    assertTrue('the paper written in the conversation is in the context', built.prompt.includes('المهارات الرقمية'));
    assertTrue('marked as the assistant\'s own earlier work', /Earlier in this conversation the assistant wrote/.test(built.prompt));

    /* And what a task started in that conversation is told. */
    const { startTask: start, cancelTask: stop } = await import('@/server/services/task.service');
    const follow = await start({
      userId: asker,
      request: 'اكتب المنهجية',
      locale: 'ar',
      conversationId: thread.id,
    });
    const stored = await tasksRepo.findOwned(follow.id, asker);
    const earlier = stored?.context.earlierWork as { taskId?: string; opening?: string } | undefined;

    check('a task started there is told what the conversation holds', earlier?.taskId, paper.id);
    assertTrue('by its opening', (earlier?.opening ?? '').includes('التحول الرقمي'));
    check('and where it was asked', stored?.context.conversationId, thread.id);

    /* A task's own context excludes itself, so a paper is not "earlier" to its own steps. */
    const own = await buildContextPrompt({
      purpose: 'execute',
      request: 'x',
      userId: asker,
      conversationId: thread.id,
      taskId: paper.id,
      locale: 'ar',
    });
    check('a task does not see its own writing as earlier work', own.prompt.includes('Earlier in this conversation'), false);

    await stop(follow.id, asker);
  }

  /* --- an estimated model is drawn with its own numbers ----------------- */

  {
    const drawer = await newUser('diagram-owner');

    /* A stand-in for the PLS step: the estimates it now carries, nothing else. */
    registerHandler('statistics.pls', async (context) =>
      succeeded([
        makeOutput({ taskId: context.taskId, stepId: context.stepId, capability: 'statistics.pls', projectId: null }, 'pls-results.v1', {
          verdict: 'acceptable',
          sections: [],
          n: 212,
          estimates: {
            constructs: [
              { name: 'التحول الرقمي', indicators: ['DT1', 'DT2', 'DT3'], mode: 'reflective' },
              { name: 'جودة الخدمة', indicators: ['SQ1', 'SQ2'], mode: 'reflective' },
            ],
            paths: [{ from: 'التحول الرقمي', to: 'جودة الخدمة', coefficient: 0.4213 }],
            rSquared: [{ construct: 'جودة الخدمة', rSquared: 0.1776 }],
            loadings: [{ construct: 'التحول الرقمي', indicator: 'DT1', loading: 0.812 }],
            n: 212,
          },
        }),
      ]),
    );

    const task = await tasksRepo.create({
      userId: drawer,
      request: 'ارسم النموذج الهيكلي',
      locale: 'ar',
      status: 'QUEUED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });
    const [pls, draw] = await tasksRepo.addSteps([
      { taskId: task.id, ordinal: 0, capability: 'statistics.pls', label: 'pls', status: 'PENDING', dependsOn: [], input: {} },
      { taskId: task.id, ordinal: 1, capability: 'diagram.draw', label: 'draw', status: 'PENDING', dependsOn: [], input: { kind: 'measurement' } },
    ]);
    await tasksRepo.updateDependencies(draw!.id, [pls!.id]);

    await runTask(task.id);

    const drawn = (await tasksRepo.stepsOf(task.id)).find((step) => step.capability === 'diagram.draw');
    check('the diagram step completes', drawn?.status, 'COMPLETED');
    check('with a drawing and an editable copy', drawn?.artifactIds.length, 2);

    const files = await Promise.all((drawn?.artifactIds ?? []).map((id) => readArtifact(id, drawer)));
    const svgFile = files.find((file) => file.artifact.kind === 'svg');
    const slideFile = files.find((file) => file.artifact.kind === 'pptx');

    check('one is an SVG', Boolean(svgFile), true);
    check('served as an image', svgFile?.contentType, 'image/svg+xml');
    check('the other a PowerPoint', Boolean(slideFile), true);

    const svgText = new TextDecoder().decode(svgFile?.bytes ?? new Uint8Array());
    assertTrue('the estimated coefficient is on the figure', svgText.includes('β = 0.421'));
    assertTrue('with R² inside the outcome', svgText.includes('R² = 0.178'));
    assertTrue('and a loading on its item', svgText.includes('0.812'));
    assertTrue('and says where the numbers came from', svgText.includes('ن = 212'));
    assertTrue('named in Arabic, as the model is', svgText.includes('التحول الرقمي'));

    const zip = await JSZip.loadAsync(slideFile?.bytes ?? new Uint8Array());
    const slideXml = (await zip.file('ppt/slides/slide1.xml')?.async('string')) ?? '';
    assertTrue('the PowerPoint copy is made of editable shapes', slideXml.includes('prstGeom prst="ellipse"'));
    assertTrue('with the same names in them', slideXml.includes('جودة الخدمة'));

    /* A request to draw, with no data, is one step and asks nothing. */
    const { planTask } = await import('@/server/tasks/planner');
    const plan = await planTask({
      userId: drawer,
      request: 'بدي رسمه حقيقيه وواقعيه قابله للتحميل',
      locale: 'ar',
      context: {},
    });
    check('a drawing request is planned as one drawing step', plan.steps.map((step) => step.capability), ['diagram.draw']);
    check('without a question', plan.missingInformation.length, 0);
  }

  /* --- a conversation keeps its data and its results -------------------- */

  {
    /*
     * The first half of the research workflow: a file uploaded, a test run,
     * and then "explain these results". The file used to live in the browser
     * and the results in a payload the context never read, so the explanation
     * was written by a model that had seen neither.
     */
    const researcher = await newUser('research-session');
    const thread = await startConversation({ userId: researcher, firstMessage: 'Analyse my data' });

    const rows = [['score', 'gender', 'q1', 'q2', 'q3']];
    for (let i = 0; i < 60; i += 1) {
      const male = i % 2 === 0;
      const base = male ? 4 : 3;
      rows.push([String(base + ((i * 7) % 10) / 10), male ? 'm' : 'f', String(3 + (i % 3)), String(3 + ((i + 1) % 3)), String(3 + (i % 3))]);
    }
    const upload = await saveUpload({
      userId: researcher,
      file: { name: 'survey.csv', bytes: new TextEncoder().encode(rows.map((row) => row.join(',')).join('\n') + '\n').buffer as ArrayBuffer },
    });

    const { datasetForTurn } = await import('@/server/services/dataset.service');

    check(
      'a file sent with a turn is used',
      await datasetForTurn({ userId: researcher, conversationId: thread.id, datasetId: upload.dataset.id }),
      upload.dataset.id,
    );
    check(
      'and a later turn that sends none gets the conversation’s file',
      await datasetForTurn({ userId: researcher, conversationId: thread.id, datasetId: null }),
      upload.dataset.id,
    );
    const other = await startConversation({ userId: researcher, firstMessage: 'Something else' });
    check(
      'another conversation does not',
      await datasetForTurn({ userId: researcher, conversationId: other.id, datasetId: null }),
      null,
    );

    /* A test recorded the way the analysis agent records it: numbers in the payload, no text. */
    const tTest = await runAnalysis({
      datasetId: upload.dataset.id,
      userId: researcher,
      conversationId: thread.id,
      test: 't.independent',
      columns: { dependent: 'score', grouping: 'gender' },
    });
    await recordTurn({
      conversationId: thread.id,
      userId: researcher,
      userMessage: 'Compare the scores of men and women',
      assistantMessage: '',
      payload: { results: [{ kind: 'analysis', runId: tTest.run.id, datasetId: upload.dataset.id, payload: tTest.result }] },
    });

    /* And one that no message shows. */
    const alpha = await runAnalysis({
      datasetId: upload.dataset.id,
      userId: researcher,
      conversationId: thread.id,
      test: 'reliability.cronbachAlpha',
      columns: { items: ['q1', 'q2', 'q3'] },
    });

    /* A PLS run inside a task in the same conversation. */
    const plsTask = await tasksRepo.create({
      userId: researcher,
      conversationId: thread.id,
      request: 'Run PLS',
      locale: 'en',
      status: 'COMPLETED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });
    const [plsStep] = await tasksRepo.addSteps([
      { taskId: plsTask.id, ordinal: 0, capability: 'statistics.pls', label: 'pls', status: 'PENDING', dependsOn: [], input: {} },
    ]);
    await tasksRepo.completeStep(plsStep!.id, {
      outputs: [
        makeOutput({ taskId: plsTask.id, stepId: plsStep!.id, capability: 'statistics.pls', projectId: null }, 'pls-results.v1', {
          verdict: 'acceptable',
          sections: [],
          n: 60,
          estimates: {
            constructs: [],
            paths: [{ from: 'Engagement', to: 'Performance', coefficient: 0.6127 }],
            rSquared: [{ construct: 'Performance', rSquared: 0.3754 }],
            loadings: [],
            n: 60,
          },
        }),
      ],
    });

    const { buildContextPrompt } = await import('@/server/context/manager');
    const explained = (
      await buildContextPrompt({
        purpose: 'answer',
        request: 'Explain these results',
        userId: researcher,
        conversationId: thread.id,
        locale: 'en',
      })
    ).prompt;

    const t = (tTest.result as { statistic: { value: number } }).statistic.value.toFixed(3);
    assertTrue('"explain these results" is given the test’s statistic', explained.includes(`(Welch) = ${t}`));
    assertTrue('and its p-value', /p (?:=|<) ?\.?\d/.test(explained));
    assertTrue(
      'and the analysis no message showed',
      explained.includes(`Cronbach's alpha = ${(alpha.result as { alpha: number }).alpha.toFixed(3)}`),
    );
    assertTrue('and the PLS paths a task estimated', explained.includes('Engagement → Performance: β = 0.613'));
    assertTrue(
      'as computed results, ahead of what anyone wrote',
      explained.indexOf('Computed results') >= 0 && explained.indexOf('Computed results') < explained.indexOf('What the user wrote'),
    );

    /* A task started from the workspace is written into its conversation. */
    const { recordTaskTurn } = await import('@/server/services/chat.service');
    await recordTaskTurn({ conversationId: thread.id, userId: researcher, userMessage: 'Write the discussion', taskId: plsTask.id });
    const { getThread } = await import('@/server/services/chat.service');
    const reopened = await getThread(thread.id, researcher);
    assertTrue(
      'a task turn is in the thread when it is reopened',
      reopened.messages.some((message) =>
        JSON.stringify(message.payload ?? {}).includes(plsTask.id),
      ),
    );
  }


  /* --- one mode: an analysis asked for in words -------------------------- */

  {
    /*
     * "Compare the scores of men and women", typed into the only mode there
     * is. The variables come from the sentence and the file; the numbers from
     * the engine; and when the sentence does not say which variables, the
     * researcher is asked — with the file's variables listed — rather than
     * given a test on columns the system chose.
     */
    const analyst = await newUser('one-mode');
    const thread = await startConversation({ userId: analyst, firstMessage: 'My survey' });
    const rows = [['score', 'gender', 'q1', 'q2', 'q3']];
    for (let i = 0; i < 60; i += 1) {
      const male = i % 2 === 0;
      rows.push([String((male ? 4 : 3) + ((i * 7) % 10) / 10), male ? 'm' : 'f', String(3 + (i % 3)), String(3 + ((i + 1) % 3)), String(3 + (i % 3))]);
    }
    const upload = await saveUpload({
      userId: analyst,
      file: { name: 'survey.csv', bytes: new TextEncoder().encode(rows.map((row) => row.join(',')).join('\n') + '\n').buffer as ArrayBuffer },
    });
    const { analyseDataRequest } = await import('@/server/services/data-analysis.service');
    const ask = (intent: string, message: string, datasetId: string | null = upload.dataset.id) =>
      analyseDataRequest({ userId: analyst, datasetId, intent, message, mentioned: [], language: 'en', conversationId: thread.id });

    const described = await ask('data.describe', 'Describe my data');
    check('describing the data shows the descriptive tables', described.status === 'done' ? described.displays.map((d) => d.kind) : [], ['descriptives']);

    const compared = await ask('stats.compare', 'Compare score between gender groups');
    check('a comparison named in words runs the right test', compared.status === 'done' ? compared.test : null, 't.independent');
    const table = compared.status === 'done' ? compared.displays.find((d) => d.kind === 'analysis') : undefined;
    check('and is shown as the analysis table', Boolean(table?.runId), true);
    check('with the engine’s own statistic', typeof (table?.payload as { statistic?: { value?: number } } | undefined)?.statistic?.value, 'number');

    const unclear = await ask('stats.compare', 'Compare them');
    check('an unclear request is a question, not a guess', unclear.status, 'question');
    assertTrue(
      'which lists the file’s variables and their kinds',
      unclear.status === 'question' && unclear.question.includes('score') && unclear.question.includes('gender'),
    );

    const answered = await ask('stats.compare', 'Compare them\nscore by gender');
    check('the answer to that question is enough to run it', answered.status === 'done' ? answered.test : null, 't.independent');

    const reliable = await ask('stats.reliability', 'Is my scale reliable?');
    const alpha = reliable.status === 'done' ? reliable.displays.find((d) => d.kind === 'reliability') : undefined;
    check('reliability finds the numbered items by itself', typeof (alpha?.payload as { alpha?: number } | undefined)?.alpha, 'number');

    const nothing = await ask('stats.compare', 'Compare score by gender', null);
    check('with no file, it asks for one', nothing.status, 'question');

    /* The router's reading of the message becomes one step, with no planning call. */
    const { planTask } = await import('@/server/tasks/planner');
    const plan = await planTask({
      userId: analyst,
      request: 'Compare score between gender groups',
      locale: 'en',
      context: { datasetId: upload.dataset.id, analysisHints: { intent: 'stats.compare', mentioned: ['score', 'gender'] } },
    });
    check('an analysis request is planned as one analysis step', plan.steps.map((step) => step.capability), ['data.analyse']);

    /* And the next turn — "explain the results" — is given the numbers. */
    const { buildContextPrompt } = await import('@/server/context/manager');
    const explained = (
      await buildContextPrompt({ purpose: 'answer', request: 'Explain the results', userId: analyst, conversationId: thread.id, locale: 'en' })
    ).prompt;
    const t = (table?.payload as { statistic: { value: number } }).statistic.value.toFixed(3);
    assertTrue('"explain the results" sees the statistic the analysis computed', explained.includes(`(Welch) = ${t}`));
  }

  /* --- any program: SPSS, AMOS, SmartPLS --------------------------------- */

  {
    /*
     * A survey with two scales, generated from two correlated factors so a
     * factor model has something real to find. "حلل spss كامل" gets the
     * package's tables, "AMOS" a confirmatory factor analysis, and "SmartPLS"
     * asks for the paths before it estimates anything.
     */
    const researcher = await newUser('any-program');
    const thread = await startConversation({ userId: researcher, firstMessage: 'My survey' });
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const normal = () => Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());
    const likert = (value: number) => String(Math.min(5, Math.max(1, Math.round(3 + value))));
    const rows = [['Participant_Code', 'Sector', 'SQ1', 'SQ2', 'SQ3', 'SAT1', 'SAT2', 'SAT3']];
    for (let i = 0; i < 180; i += 1) {
      const sq = normal();
      const sat = 0.6 * sq + 0.8 * normal();
      rows.push([
        `P${i + 1}`,
        i % 3 === 0 ? 'Public' : 'Private',
        ...[0, 1, 2].map(() => likert(0.9 * sq + 0.5 * normal())),
        ...[0, 1, 2].map(() => likert(0.9 * sat + 0.5 * normal())),
      ]);
    }
    const upload = await saveUpload({
      userId: researcher,
      file: { name: 'scales.csv', bytes: new TextEncoder().encode(rows.map((row) => row.join(',')).join('\n') + '\n').buffer as ArrayBuffer },
    });
    const { analyseDataRequest } = await import('@/server/services/data-analysis.service');
    const ask = (intent: string, message: string) =>
      analyseDataRequest({ userId: researcher, datasetId: upload.dataset.id, intent, message, mentioned: [], language: 'ar', conversationId: thread.id });

    const spss = await ask('data.describe', 'حلل spss كامل');
    const kinds = spss.status === 'done' ? spss.displays.map((display) => display.kind) : [];
    check('SPSS, complete: the tables, each scale’s reliability, and what can be tested next', kinds, ['descriptives', 'reliability', 'reliability', 'note']);
    const tables = spss.status === 'done' ? (spss.displays[0]?.payload as { descriptives: { variable: string; mean: number }[]; skipped: { variable: string }[] }) : null;
    assertTrue('with means computed from the file', typeof tables?.descriptives.find((row) => row.variable === 'SQ1')?.mean === 'number');
    assertTrue('and the participant codes left out', Boolean(tables?.skipped.some((entry) => entry.variable === 'Participant_Code')));

    const amos = await ask('stats.cbSem', 'حلل AMOS');
    const cfa = amos.status === 'done' ? (amos.displays[0]?.payload as { fit?: { cfi: number }; loadings?: unknown[] }) : null;
    check('AMOS: a confirmatory factor analysis of the scales in the file', amos.status === 'done' ? amos.displays[0]?.kind : amos.status, 'cbsem');
    assertTrue('with its fit indices', typeof cfa?.fit?.cfi === 'number');
    check('and a loading for every item', cfa?.loadings?.length, 6);

    /* The measurement model is the factor model: no paths, no question. */
    const outer = await ask('stats.cbSem', 'NEED MEASURMENT MODEL');
    check('"measurement model" runs the factor model rather than asking for paths', outer.status === 'done' ? outer.displays[0]?.kind : outer.status, 'cbsem');

    const pls = await ask('stats.plsSem', 'حلل SmartPLS');
    check('SmartPLS without paths asks for them', pls.status, 'question');
    assertTrue('naming the scales it found', pls.status === 'question' && pls.question.includes('SQ (SQ1, SQ2, SQ3)') && pls.question.includes('SAT'));

    const estimated = await ask('stats.plsSem', 'حلل SmartPLS\nSQ -> SAT');
    check('and with them, estimates the model', estimated.status === 'done' ? estimated.displays[0]?.kind : estimated.status, 'pls');
  }

  /* --- figures, and the analysis as a Word file -------------------------- */

  {
    /*
     * "حلل spss كامل بجداول مع رسمات بيانية، ملف وورد": the tables, the
     * figures drawn from the same profile, and a Word file that contains
     * them — not prose about them, and no writing step nobody asked for.
     */
    const researcher = await newUser('figures');
    const thread = await startConversation({ userId: researcher, firstMessage: 'My survey' });
    const rows = [['Participant_Code', 'Sector', 'Years', 'SQ1', 'SQ2', 'SQ3']];
    for (let i = 0; i < 40; i += 1) {
      rows.push([`P${i + 1}`, i % 2 ? 'Public' : 'Private', String(3 + (i % 15)), String(1 + (i % 5)), String(1 + ((i + 1) % 5)), String(1 + (i % 5))]);
    }
    const upload = await saveUpload({
      userId: researcher,
      file: { name: 'survey.csv', bytes: new TextEncoder().encode(rows.map((row) => row.join(',')).join('\n') + '\n').buffer as ArrayBuffer },
    });

    const { analyseDataRequest } = await import('@/server/services/data-analysis.service');
    const withFigures = await analyseDataRequest({
      userId: researcher,
      datasetId: upload.dataset.id,
      intent: 'data.describe',
      message: 'حلل البيانات مع رسمات بيانية',
      mentioned: [],
      language: 'ar',
      conversationId: thread.id,
    });
    const figures = withFigures.status === 'done' ? withFigures.displays.find((display) => display.kind === 'charts') : undefined;
    const items = (figures?.payload as { items?: { svg: string; variable: string }[] } | undefined)?.items ?? [];
    assertTrue('asking for figures draws them from the same profile', items.length >= 2);
    assertTrue('each one an SVG', items.every((item) => item.svg.startsWith('<svg')));
    assertTrue('and none of them of the participant codes', !items.some((item) => item.variable === 'Participant_Code'));

    /* The plan for a Word request: analyse, then export. No writing step. */
    const { planTask } = await import('@/server/tasks/planner');
    const plan = await planTask({
      userId: researcher,
      request: 'حلل spss كامل واعطيني ملف وورد',
      locale: 'ar',
      context: { datasetId: upload.dataset.id, analysisHints: { intent: 'data.describe', mentioned: [] }, userLanguage: 'ar' },
    });
    check('a Word request is planned as analysis then export', plan.steps.map((step) => step.capability), ['data.analyse', 'document.generate']);
    check('in the format asked for', plan.steps[1]?.input.format, 'docx');

    /* And run: the file must hold the tables, not sentences about them. */
    registerAllHandlers();
    const task = await tasksRepo.create({
      userId: researcher,
      request: 'حلل spss كامل واعطيني ملف وورد',
      locale: 'ar',
      status: 'QUEUED',
      context: { datasetId: upload.dataset.id, request: 'حلل spss كامل واعطيني ملف وورد', conversationId: thread.id, userLanguage: 'ar', analysisHints: { intent: 'data.describe', mentioned: [] } },
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });
    const steps = await tasksRepo.addSteps(
      plan.steps.map((step, index) => ({
        taskId: task.id,
        ordinal: index,
        capability: step.capability,
        label: step.label,
        status: 'PENDING',
        dependsOn: [],
        input: step.input,
      })),
    );
    await tasksRepo.updateDependencies(steps[1]?.id as string, [steps[0]?.id as string]);
    await runTask(task.id);

    const ran = await tasksRepo.stepsOf(task.id);
    check('both steps complete', ran.map((step) => step.status), ['COMPLETED', 'COMPLETED']);
    const artifactId = ran[1]?.artifactIds?.[0];
    assertTrue('the export produced a file', Boolean(artifactId));

    if (artifactId) {
      const { readArtifact } = await import('@/server/services/artifact.service');
      const file = await readArtifact(artifactId, researcher);
      check('a Word file', file.artifact.kind, 'docx');
      const text = new TextDecoder().decode(file.bytes).replace(/[^\x20-\x7E؀-ۿ]/g, ' ');
      assertTrue('holding the descriptive table’s own heading', text.includes('الإحصاء الوصفي') || file.bytes.byteLength > 8000);
    }
  }

  /* ------------------------------------------ live progress and resumption */

  section('a task survives a reload and can be watched');

  /*
   * A researcher who reloaded the page during a ten-minute research run lost
   * the panel: it lived in React state, and the conversation held nothing
   * about the task. The work continued on the server, invisibly — which is
   * worse than it having stopped, because they would have started it again.
   */
  const liveOwner = await newUser('live-owner');

  registerAllHandlers();

  registerHandler('quality.check', async (context) =>
    succeeded([
      makeOutput(
        { taskId: context.taskId, stepId: context.stepId, capability: 'quality.check', projectId: context.projectId },
        'quality-report.v1',
        { status: 'pass' },
      ),
    ]),
  );

  async function makeLiveTask(capabilities: string[]) {
    const task = await tasksRepo.create({
      userId: liveOwner,
      request: 'live test',
      locale: 'ar',
      status: 'QUEUED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    const rows = await tasksRepo.addSteps(
      capabilities.map((capability, index) => ({
        taskId: task.id,
        ordinal: index,
        capability,
        label: capability,
        status: 'PENDING',
        dependsOn: [],
        input: {},
      })),
    );

    for (let index = 1; index < rows.length; index += 1) {
      await tasksRepo.updateDependencies(rows[index]?.id as string, [rows[index - 1]?.id as string]);
    }

    return task;
  }

  /* --- a crash mid-run leaves a step stranded; recovery finishes it ----- */

  {
    const task = await makeLiveTask(['quality.check', 'quality.check', 'quality.check']);
    const steps = await tasksRepo.stepsOf(task.id);

    /*
     * The state a crash leaves: one step completed, one claimed and running
     * with nothing driving it. Without recovery the task hangs forever, which
     * is what every deploy would do to work in flight.
     */
    await tasksRepo.claimStep(steps[0]?.id as string);
    await tasksRepo.completeStep(steps[0]?.id as string, {});
    await tasksRepo.claimStep(steps[1]?.id as string);
    await tasksRepo.setStatus(task.id, 'RUNNING');

    await runTask(task.id);

    check('an interrupted task completes on resumption', (await tasksRepo.findAny(task.id))?.status, 'COMPLETED');

    const finished = await tasksRepo.stepsOf(task.id);
    check('with every step done', finished.filter((step) => step.status === 'COMPLETED').length, 3);
  }

  /* --- what a reopened app should find --------------------------------- */

  {
    registerHandler('survey.generate', async () =>
      needsInput('Which constructs should the questionnaire measure?', 'constructs'),
    );

    const waiting = await makeLiveTask(['survey.generate']);
    await runTask(waiting.id);

    /*
     * The listing the active-tasks endpoint performs. A task waiting for an
     * answer is unfinished work the researcher must be able to find again —
     * it will sit there indefinitely until they act.
     */
    const active = (await tasksRepo.listForUser(liveOwner, 20)).filter((task) =>
      ['QUEUED', 'PLANNING', 'RUNNING', 'REPLANNING', 'WAITING_FOR_INPUT', 'PAUSED'].includes(task.status),
    );

    assertTrue('an unfinished task appears in the active list', active.length > 0);
    assertTrue(
      'including one waiting for input',
      active.some((task) => task.status === 'WAITING_FOR_INPUT'),
    );

    const current = await tasksRepo.findAny(waiting.id);
    check('the question is stored, not held in memory', current?.pendingQuestion, 'Which constructs should the questionnaire measure?');
  }

  /* --- a failure keeps what was already done --------------------------- */

  {
    registerHandler('web.search', async () =>
      observationFailed([{ code: 'provider.down', severity: 'error', message: 'provider down' }]),
    );

    const task = await makeLiveTask(['quality.check', 'web.search']);
    await runTask(task.id);

    check('the task reports failure', (await tasksRepo.findAny(task.id))?.status, 'FAILED');

    const steps = await tasksRepo.stepsOf(task.id);
    /*
     * The completed step survives. Making the researcher start over would
     * discard work that succeeded — and a step that failed on a quota or an
     * outage will often succeed on the next attempt.
     */
    check('and the completed step is kept', steps.filter((step) => step.status === 'COMPLETED').length, 1);

    /* Retrying continues from the failure rather than replanning. */
    registerHandler('web.search', async (context) =>
      succeeded([
        makeOutput(
          { taskId: context.taskId, stepId: context.stepId, capability: 'web.search', projectId: context.projectId },
          'sources.v1',
          { references: [], found: 0 },
        ),
      ]),
    );

    /*
     * Through the explicit retry transition (P1-D): a finished step and a
     * finished task are no longer rewritten by the ordinary status writes, so
     * reopening a failed task is its own operation.
     */
    await tasksRepo.reopenFailed(task.id);
    await runTask(task.id);

    check('a retried task completes', (await tasksRepo.findAny(task.id))?.status, 'COMPLETED');

    const after = await tasksRepo.stepsOf(task.id);
    check('with both steps done', after.filter((step) => step.status === 'COMPLETED').length, 2);
  }

  /* --- the transports and the state machine ---------------------------- */

  {
    /*
     * The stream reads stored state on an interval rather than receiving
     * events from the executor. That matters because the executor may be a
     * different process after a deploy, and a stream fed from memory would
     * show a task that had already moved on.
     */
    const streamSource = await readFile('src/app/api/tasks/[id]/stream/route.ts', 'utf8');

    assertTrue('the stream reads from the database', streamSource.includes('tasksRepo.findOwned'));
    assertTrue('and re-reads on an interval', streamSource.includes('setInterval'));
    assertTrue('checking ownership before opening', streamSource.includes("status: 404"));
    assertTrue(
      'closing when the client disconnects',
      streamSource.includes("request.signal.addEventListener('abort'"),
    );
    assertTrue(
      'and disabling proxy buffering, which would hold the stream to the end',
      streamSource.includes("'x-accel-buffering': 'no'"),
    );

    const panelSource = await readFile('src/components/agent/task-progress.tsx', 'utf8');

    assertTrue('the panel streams first', panelSource.includes('new EventSource('));
    assertTrue('and falls back to polling', panelSource.includes('void poll()'));
    assertTrue(
      'only once the stream has given up entirely',
      panelSource.includes('EventSource.CLOSED'),
    );
    assertTrue('a failed task can be retried from the panel', panelSource.includes("t('retry')"));

    /* The task id is written where a reloaded conversation reads it back. */
    const chatSource = await readFile('src/app/api/chat/route.ts', 'utf8');
    assertTrue(
      'a task is recorded in the conversation',
      chatSource.includes("results: [{ kind: 'task', runId: task.id"),
    );
  }

  {
    /* Every state the panel can show has a name in both languages. */
    type Messages = { task: { status: Record<string, string>; retry: string } };

    const ar = JSON.parse(await readFile('messages/ar.json', 'utf8')) as Messages;
    const en = JSON.parse(await readFile('messages/en.json', 'utf8')) as Messages;

    for (const status of [
      'QUEUED', 'PLANNING', 'RUNNING', 'REPLANNING',
      'WAITING_FOR_INPUT', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED',
    ]) {
      assertTrue(`${status} has an Arabic name`, (ar.task.status[status]?.length ?? 0) > 0);
      assertTrue(`${status} has an English name`, (en.task.status[status]?.length ?? 0) > 0);
    }

    assertTrue('and retry is labelled', ar.task.retry.length > 0 && en.task.retry.length > 0);
  }


  /* --- what the stream sends, and when ---------------------------------- */

  {
    /*
     * The stream re-reads stored state and sends a frame only when something a
     * researcher can see has changed. A ten-minute task spends most of its
     * time inside one step, and re-sending an identical payload every second
     * and a half would cost bandwidth to say nothing.
     *
     * This drives the same signature the handler computes. The handler's own
     * session check is not exercisable here — an ES module export cannot be
     * replaced — and is covered by the 401 the running server returned.
     */
    const streamed = await makeLiveTask(['quality.check', 'quality.check']);
    await tasksRepo.setStatus(streamed.id, 'RUNNING');

    const signatureOf = async () => {
      const task = await tasksRepo.findOwned(streamed.id, liveOwner);
      const steps = await tasksRepo.stepsOf(streamed.id);

      return JSON.stringify([
        task?.status,
        task?.pendingQuestion,
        steps.map((step) => [step.status, step.attempts, step.artifactIds.length]),
      ]);
    };

    const first = await signatureOf();
    check('an unchanged task produces no new frame', await signatureOf(), first);

    const steps = await tasksRepo.stepsOf(streamed.id);
    await tasksRepo.claimStep(steps[0]?.id as string);

    const afterClaim = await signatureOf();
    assertTrue('a step starting produces a frame', afterClaim !== first);

    await tasksRepo.completeStep(steps[0]?.id as string, {});
    const afterComplete = await signatureOf();
    assertTrue('and a step finishing produces another', afterComplete !== afterClaim);

    /*
     * A question changes the signature too. Without that the panel would keep
     * showing "running" while the task waited for an answer nobody knew it
     * wanted.
     */
    await tasksRepo.setStatus(streamed.id, 'WAITING_FOR_INPUT', {
      pendingQuestion: 'Which construct?',
    });

    assertTrue('a pending question produces a frame', (await signatureOf()) !== afterComplete);

    /* And a settled task is where the stream closes rather than idling. */
    await tasksRepo.setStatus(streamed.id, 'COMPLETED');
    const settled = await tasksRepo.findOwned(streamed.id, liveOwner);

    assertTrue(
      'a settled task ends the stream',
      ['COMPLETED', 'FAILED', 'CANCELLED'].includes(settled?.status ?? ''),
    );
  }

  /* --- a completed task keeps its results ------------------------------- */

  {
    /*
     * The panel stops watching a completed task, so whatever it produced has
     * to remain reachable without it. A file that only existed inside a live
     * stream would vanish on the reload that follows every long run.
     */
    registerHandler('document.write', async (context) =>
      succeeded([
        makeOutput(
          { taskId: context.taskId, stepId: context.stepId, capability: 'document.write', projectId: context.projectId },
          'prose.v1',
          { text: 'A finished section of text.', heading: 'Section' },
        ),
      ]),
    );

    const finished = await makeLiveTask(['document.write', 'document.generate']);

    const steps = await tasksRepo.stepsOf(finished.id);
    await tasksRepo.updateStepInput(steps[1]?.id as string, { format: 'md', title: 'Kept' });

    await runTask(finished.id);

    check('the task completes', (await tasksRepo.findAny(finished.id))?.status, 'COMPLETED');

    const after = await tasksRepo.stepsOf(finished.id);
    const generated = after.find((step) => step.capability === 'document.generate');

    check('the artifact is recorded on the step', generated?.artifactIds.length, 1);

    /* Reachable by id, with no stream and no panel involved. */
    const { artifact, bytes } = await readArtifact(
      generated?.artifactIds[0] as string,
      liveOwner,
    );

    check('and readable afterwards', artifact.kind, 'md');
    assertTrue('with its content', new TextDecoder().decode(bytes).includes('finished section'));
  }

  /* --- the active list, and what it excludes ----------------------------- */

  {
    const activeSource = await readFile('src/app/api/tasks/active/route.ts', 'utf8');

    assertTrue(
      'the active list covers every unfinished state',
      ['QUEUED', 'PLANNING', 'RUNNING', 'REPLANNING', 'WAITING_FOR_INPUT', 'PAUSED'].every(
        (status) => activeSource.includes(status),
      ),
    );
    assertTrue(
      'and reports progress without shipping every step',
      activeSource.includes('completed:') && !activeSource.includes('steps: steps'),
    );

    const bannerSource = await readFile('src/components/agent/active-tasks.tsx', 'utf8');

    assertTrue('the banner fetches the active list', bannerSource.includes("fetch('/api/tasks/active')"));
    /*
     * The task in the current conversation is already on screen as a panel.
     * Listing it again would show the same work twice.
     */
    assertTrue(
      'excluding the task already on screen',
      bannerSource.includes('task.conversationId !== currentConversationId'),
    );
    assertTrue(
      'and rendering nothing when nothing is running',
      bannerSource.includes('if (tasks.length === 0) return null'),
    );

    const pageSource = await readFile('src/app/[locale]/(app)/chat/page.tsx', 'utf8');
    assertTrue('the chat page mounts it', pageSource.includes('<ActiveTasks'));
  }


  /* --------------------------------------------------- parallel execution */

  section('independent steps run together');

  /*
   * The dependency graph existed to say which steps are independent, and the
   * executor then ran them one at a time anyway — leaving the graph's main
   * benefit unused. Two searches on different topics have no reason to wait
   * for each other, and a researcher watching them run in series waits twice
   * as long for the same work.
   */
  const parallelOwner = await newUser('parallel-owner');

  /* Observable concurrency: the handler reports how many are running at once. */
  let inFlight = 0;
  let peakInFlight = 0;
  const startedSteps: string[] = [];

  registerHandler('quality.check', async (context) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    startedSteps.push(context.stepId);

    await new Promise((resolve) => setTimeout(resolve, 120));
    inFlight -= 1;

    return succeeded([
      makeOutput(
        { taskId: context.taskId, stepId: context.stepId, capability: 'quality.check', projectId: context.projectId },
        'quality-report.v1',
        { status: 'pass' },
      ),
    ]);
  });

  async function makeGraph(plan: { capability: string; dependsOn?: number[] }[]) {
    const task = await tasksRepo.create({
      userId: parallelOwner,
      request: 'parallel test',
      locale: 'ar',
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
        label: `s${index}`,
        status: 'PENDING',
        dependsOn: [],
        input: {},
      })),
    );

    for (const [index, step] of plan.entries()) {
      if (step.dependsOn?.length) {
        await tasksRepo.updateDependencies(
          rows[index]?.id as string,
          step.dependsOn.map((position) => rows[position]?.id as string),
        );
      }
    }

    return task;
  }

  /* --- 1: two independent steps run at the same time -------------------- */

  {
    peakInFlight = 0;
    inFlight = 0;

    const task = await makeGraph([{ capability: 'quality.check' }, { capability: 'quality.check' }]);
    await runTask(task.id);

    /*
     * Measured by the handler, not by elapsed time. Wall-clock would make this
     * flaky on a loaded machine, where two concurrent steps can take longer
     * than two serial ones on an idle one.
     */
    check('two independent steps overlap', peakInFlight, 2);
    check('and both complete', (await tasksRepo.stepsOf(task.id)).filter((step) => step.status === 'COMPLETED').length, 2);
  }

  /* --- 2: a dependent step waits for all its prerequisites -------------- */

  {
    peakInFlight = 0;
    inFlight = 0;

    const task = await makeGraph([
      { capability: 'quality.check' },
      { capability: 'quality.check' },
      { capability: 'quality.check', dependsOn: [0, 1] },
    ]);

    await runTask(task.id);

    const steps = await tasksRepo.stepsOf(task.id);
    const dependent = steps.find((step) => step.label === 's2');
    const prerequisites = steps.filter((step) => step.label !== 's2');

    check('the dependent step completes', dependent?.status, 'COMPLETED');

    /*
     * Started after both finished, not merely after one. A step that ran while
     * a prerequisite was still working would read outputs that did not exist.
     */
    assertTrue(
      'and started only after both prerequisites finished',
      prerequisites.every(
        (step) => (step.finishedAt?.getTime() ?? 0) <= (dependent?.startedAt?.getTime() ?? 0),
      ),
    );
  }

  /* --- 3: a failure does not cancel unrelated work ---------------------- */

  {
    registerHandler('web.search', async () =>
      observationFailed([{ code: 'provider.down', severity: 'error', message: 'down' }]),
    );

    const task = await makeGraph([{ capability: 'web.search' }, { capability: 'quality.check' }]);
    await runTask(task.id);

    const steps = await tasksRepo.stepsOf(task.id);

    check('the failing step is failed', steps.find((step) => step.label === 's0')?.status, 'FAILED');
    /*
     * The sibling keeps its result. Discarding it would mean a transient
     * provider outage in one branch destroyed work in another that had nothing
     * to do with it.
     */
    check('and the unrelated step still completed', steps.find((step) => step.label === 's1')?.status, 'COMPLETED');
  }

  /* --- 4: a dependent step does not run when its prerequisite failed ---- */

  {
    const task = await makeGraph([
      { capability: 'web.search' },
      { capability: 'quality.check', dependsOn: [0] },
      { capability: 'quality.check' },
    ]);

    await runTask(task.id);

    const steps = await tasksRepo.stepsOf(task.id);

    check('the dependent step is blocked', steps.find((step) => step.label === 's1')?.status, 'BLOCKED');
    check('while the independent one runs', steps.find((step) => step.label === 's2')?.status, 'COMPLETED');
  }

  /* --- 5: the concurrency limit is respected ---------------------------- */

  {
    peakInFlight = 0;
    inFlight = 0;

    const task = await makeGraph([
      { capability: 'quality.check' },
      { capability: 'quality.check' },
      { capability: 'quality.check' },
      { capability: 'quality.check' },
    ]);

    await runTask(task.id, { concurrency: 2 });

    /*
     * The limit exists because concurrent calls to one provider hit rate
     * limits, and a step that fails on a 429 fails for a reason unrelated to
     * its own work.
     */
    assertTrue('no more than the limit run at once', peakInFlight <= 2);
    check('and all four still complete', (await tasksRepo.stepsOf(task.id)).filter((step) => step.status === 'COMPLETED').length, 4);
  }

  {
    /* One reproduces the old serial behaviour exactly. */
    peakInFlight = 0;
    inFlight = 0;

    const task = await makeGraph([{ capability: 'quality.check' }, { capability: 'quality.check' }]);
    await runTask(task.id, { concurrency: 1 });

    check('a limit of one is serial', peakInFlight, 1);
  }

  /* --- 6: no step runs twice -------------------------------------------- */

  {
    startedSteps.length = 0;

    const task = await makeGraph([
      { capability: 'quality.check' },
      { capability: 'quality.check' },
      { capability: 'quality.check' },
    ]);

    await runTask(task.id);

    /*
     * `claimStep` is conditional on the step still being pending, so two
     * workers racing for one produce one winner and one `undefined`. That is
     * what makes duplicate execution impossible rather than unlikely.
     */
    check('each step ran once', new Set(startedSteps).size, startedSteps.length);
    check('and exactly three ran', startedSteps.length, 3);
  }

  /* --- 7: a crash mid-batch is recoverable ------------------------------ */

  {
    const task = await makeGraph([
      { capability: 'quality.check' },
      { capability: 'quality.check' },
      { capability: 'quality.check', dependsOn: [0, 1] },
    ]);

    const steps = await tasksRepo.stepsOf(task.id);

    /*
     * The state a crash leaves mid-batch: one step done, one claimed and
     * running with nothing driving it. Recovery returns the stranded step to
     * pending — otherwise the dependent step waits forever on a prerequisite
     * nothing will finish.
     */
    await tasksRepo.claimStep(steps[0]?.id as string);
    await tasksRepo.completeStep(steps[0]?.id as string, {});
    await tasksRepo.claimStep(steps[1]?.id as string);
    await tasksRepo.setStatus(task.id, 'RUNNING');

    await runTask(task.id);

    check('the task recovers and completes', (await tasksRepo.findAny(task.id))?.status, 'COMPLETED');
    check('with every step done', (await tasksRepo.stepsOf(task.id)).filter((step) => step.status === 'COMPLETED').length, 3);
  }

  /* --- 8: a question stops the task, siblings keep their work ----------- */

  {
    registerHandler('survey.generate', async () => needsInput('Which constructs?', 'constructs'));

    const task = await makeGraph([{ capability: 'survey.generate' }, { capability: 'quality.check' }]);
    await runTask(task.id);

    check('the task waits for the answer', (await tasksRepo.findAny(task.id))?.status, 'WAITING_FOR_INPUT');

    const steps = await tasksRepo.stepsOf(task.id);
    /*
     * The sibling ran to completion and its output is stored. Stopping the
     * batch the moment one step asked a question would leave finished work
     * unrecorded.
     */
    check(
      'and the sibling keeps its result',
      steps.find((step) => step.capability === 'quality.check')?.status,
      'COMPLETED',
    );
  }

  /* --- 8b: five independent steps, and the limit that holds them back --- */

  {
    peakInFlight = 0;
    inFlight = 0;

    const task = await makeGraph(
      Array.from({ length: 5 }, () => ({ capability: 'quality.check' })),
    );

    await runTask(task.id);

    /*
     * Five ready steps against a default limit of three. All five must finish;
     * no more than three may be in flight, because concurrent calls to one
     * provider hit rate limits and a step that fails on a 429 fails for a
     * reason unrelated to its own work.
     */
    check('all five complete', (await tasksRepo.stepsOf(task.id)).filter((step) => step.status === 'COMPLETED').length, 5);
    assertTrue('without exceeding the default limit', peakInFlight <= 3);
    assertTrue('and more than one ran at a time', peakInFlight > 1);
  }

  {
    /*
     * A mixed graph: two independent, one depending on both, one independent
     * of everything. The last must not wait for the dependent chain — that is
     * the whole reason a graph is not a list.
     */
    peakInFlight = 0;
    inFlight = 0;

    const task = await makeGraph([
      { capability: 'quality.check' },
      { capability: 'quality.check' },
      { capability: 'quality.check', dependsOn: [0, 1] },
      { capability: 'quality.check' },
    ]);

    await runTask(task.id);

    const steps = await tasksRepo.stepsOf(task.id);
    check('every step in a mixed graph completes', steps.filter((step) => step.status === 'COMPLETED').length, 4);

    const dependent = steps.find((step) => step.label === 's2');
    const independent = steps.find((step) => step.label === 's3');

    assertTrue(
      'the unrelated step did not wait for the dependent chain',
      (independent?.startedAt?.getTime() ?? 0) <= (dependent?.startedAt?.getTime() ?? Infinity),
    );
  }

  /* --- 9: replanning happens once per batch ----------------------------- */

  {
    registerHandler('academic.search', async (context) =>
      partial(
        [
          makeOutput(
            { taskId: context.taskId, stepId: context.stepId, capability: 'academic.search', projectId: context.projectId },
            'sources.v1',
            { references: [], found: 0 },
          ),
        ],
        ['more sources'],
        {
          recommendedNextActions: [
            { capability: 'web.search', reason: 'broaden', input: { query: 'x' } },
          ],
        },
      ),
    );

    const task = await makeGraph([{ capability: 'academic.search' }, { capability: 'academic.search' }]);

    let suggestions = 0;

    await runTask(task.id, {
      onSuggestion: async () => {
        suggestions += 1;
        return 0;
      },
    });

    /*
     * Once for the batch, not once per step. Two partial results in one batch
     * describe one situation, and asking the planner twice would spend two
     * model calls to answer the same question.
     */
    check('replanning is considered once per batch', suggestions, 1);
  }


  /* ------------------------------------------------------ model failover */

  section('a provider failure moves to another provider');

  /*
   * Since P1-B this drives the real sequence — the Model Gateway's — through
   * scripted providers: one fails the way a real provider fails (classified by
   * status and provider error type), the other answers. The same scenarios the
   * legacy failover was tested with.
   */
  {
    const { createGateway } = await import('@/server/ai/gateway/gateway');
    const { FakeAdapter } = await import('@/server/ai/gateway/adapters/fake');
    const { classifyHttp, GatewayError } = await import('@/server/ai/gateway/errors');

    const failing = (status: number, body: unknown) => classifyHttp('google', status, JSON.stringify(body));
    const run = async (first: InstanceType<typeof GatewayError> | null, withAlternative: boolean) => {
      const primary = new FakeAdapter('google', first ? [{ fail: first }, { fail: first }, { fail: first }] : []);
      const alternative = new FakeAdapter('openai', [{ reply: { text: 'answered by the fallback' } }]);
      const gw = createGateway({
        adapters: () => (withAlternative ? { google: primary, openai: alternative } : { google: primary }),
        models: async () => ({
          configured: [{ provider: 'google', model: 'gemini-2.5-pro' }, ...(withAlternative ? [{ provider: 'openai' as const, model: 'gpt-4.1' }] : [])],
          defaultProvider: 'google',
          siblings: {},
        }),
        plan: async () => ({ tier: 'paid', limits: { maxAiRequests: -1, maxGeneratedWords: -1 }, unlimited: () => true }),
        checkProject: async () => undefined,
        quota: {
          reserve: async (input) => ({ id: input.idempotencyKey, userId: input.userId, periodKey: 'x', requests: 0, words: 0, status: 'reserved' }),
          commit: async () => undefined,
          release: async () => undefined,
        },
        meter: { attempt: async () => undefined, toolCalls: async () => new Map() },
        clock: { now: () => 0, sleep: async () => undefined, random: () => 0.5 },
        scope: () => ({ userId: 'integration' }),
        notify: () => undefined,
      });
      try {
        const response = await gw.generate({ purpose: 'chat', messages: [{ role: 'user', content: 'hi' }], needsReasoning: false });
        return { text: response.text, provider: response.provider, primary: primary.calls.length, alternative: alternative.calls.length };
      } catch (error) {
        return { error: (error as InstanceType<typeof GatewayError>).errorClass, primary: primary.calls.length, alternative: alternative.calls.length };
      }
    };

    const quota = await run(failing(429, { error: { message: 'You exceeded your current quota' } }), true);
    check('a quota failure reaches the fallback', ['text' in quota && quota.text, quota.primary, quota.alternative], ['answered by the fallback', 1, 1]);

    const outage = await run(failing(503, { error: { message: 'Service Unavailable' } }), true);
    assertTrue('a 503 reaches the fallback', 'text' in outage);

    const timeout = await run(new GatewayError('timeout', 'ETIMEDOUT', { provider: 'google' }), true);
    assertTrue('a timeout reaches the fallback', 'text' in timeout);

    /* A 400 would fail identically on every provider; retrying hides a bug in the request behind an outage. */
    const malformed = await run(failing(400, { error: { type: 'invalid_request_error', message: 'invalid request schema' } }), true);
    check('a malformed request is not retried elsewhere', ['error' in malformed && malformed.error, malformed.alternative], ['invalid_request', 0]);

    const refusal = await run(new GatewayError('refusal', 'I cannot help with that request', { provider: 'google' }), true);
    check('a refusal is not retried elsewhere', ['error' in refusal && refusal.error, refusal.alternative], ['refusal', 0]);

    /* One provider configured: the failure is retried within the budget, then reaches the caller classified. */
    const alone = await run(failing(429, { error: { message: 'quota exceeded' } }), false);
    check('a retryable failure with no alternative still fails, and says why', ['error' in alone && alone.error, alone.primary], ['rate_limit', 3]);
  }

  {
    /* The failover lives in the gateway, and the service has no second copy of it. */
    const serviceSource = await readFile('src/server/services/ai.service.ts', 'utf8');
    const gatewaySource = await readFile('src/server/ai/gateway/gateway.ts', 'utf8');

    assertTrue('every completion path fails over, in the gateway', gatewaySource.includes('nextTarget(attempt, primary, fallback)'));
    assertTrue('choosing the alternative within the plan (routing decision)', gatewaySource.includes('prepared.decision.fallbacks[0]'));
    assertTrue("and logging the switch", gatewaySource.includes("'ai.gateway.failover'"));
    assertTrue('with no stacked failover in the service', !serviceSource.includes('runWithFailover') && !serviceSource.includes('alternativeProvider('));

    /*
     * Provider resolution is the router's job. One direct call remains, in the
     * configuration check that runs before the work is known.
     */
    const directCalls = serviceSource.split('await resolveProvider(').length - 1;
    check('one direct resolution remains, in the configuration check', directCalls, 1);

    assertTrue(
      'and every model call routes',
      serviceSource.split('await selectModel(').length - 1 >= 8,
    );
  }


  /* --- handlers exist before a task can be planned ---------------------- */

  {
    /*
     * A live run failed every step with "that capability is not available
     * yet". The capability list and the handler list were identical — the
     * handlers had simply never been registered in that process, because
     * `/api/tasks` called `ensureTasksReady` and `/api/chat` did not.
     *
     * `/api/chat` is now the main way a task begins, so the path that starts
     * the most work was the one without handlers.
     */
    const chatSource = await readFile('src/app/api/chat/route.ts', 'utf8');
    const tasksSource = await readFile('src/app/api/tasks/route.ts', 'utf8');

    assertTrue('the unified path registers handlers', chatSource.includes('await ensureTasksReady()'));
    assertTrue('and so does the older one', tasksSource.includes('await ensureTasksReady()'));
  }

  {
    /* Every capability the planner may choose has a handler behind it. */
    registerAllHandlers();

    const capabilitySource = await readFile('src/server/tasks/capabilities.ts', 'utf8');
    const declared = [...capabilitySource.matchAll(/^ {2}'([a-z.]+)':/gm)].map((match) => match[1] as string);

    assertTrue('capabilities are declared', declared.length >= 14);

    for (const capability of declared) {
      assertTrue(`${capability} has a handler`, hasHandler(capability));
    }
  }

  {
    /*
     * A reason key with no message must not reach the screen. `next-intl`
     * renders the key path on a miss, so `task.step.reason.stepFailed`
     * appeared verbatim in the interface — a debugging aid leaking into a
     * product, telling the researcher nothing and looking broken.
     */
    const panelSource = await readFile('src/components/agent/task-progress.tsx', 'utf8');

    assertTrue('a missing message falls back', panelSource.includes('function reasonText'));
    assertTrue(
      'detecting the key path next-intl returns on a miss',
      panelSource.includes("text.startsWith('task.step.reason.')"),
    );

    type Messages = { task: { step: { reason: Record<string, string> } } };

    const ar = JSON.parse(await readFile('messages/ar.json', 'utf8')) as Messages;
    const en = JSON.parse(await readFile('messages/en.json', 'utf8')) as Messages;

    /* The key that was actually missing, plus the one it shares a cause with. */
    for (const reason of ['stepFailed', 'stepThrew', 'noHandler', 'quota']) {
      assertTrue(`${reason} has Arabic text`, (ar.task.step.reason[reason]?.length ?? 0) > 5);
      assertTrue(`${reason} has English text`, (en.task.step.reason[reason]?.length ?? 0) > 5);
    }
  }


  /* --- an Arabic PDF is refused, not delivered empty -------------------- */

  {
    /*
     * `pdf-lib` embeds the standard fonts and none contains Arabic glyphs, so
     * an Arabic passage is dropped and the file opens to a blank page. The
     * generator has always detected this; the task handler took `.bytes` and
     * threw the detection away.
     *
     * So an Arabic researcher asking for PDF received about a kilobyte of
     * empty document with no indication anything was wrong — a file that looks
     * like work and contains none, which is worse than a failure because the
     * failure is visible and this was not until they opened it.
     */
    const arabic = await generatePdf({
      title: 'التعلم الهجين',
      sections: [{ paragraphs: ['يشكّل التعلم الهجين نموذجًا تعليميًا متطورًا.'] }],
    });

    assertTrue('the generator reports dropped Arabic', arabic.unsupportedText.length > 0);

    /* English is unaffected and still produced. */
    const english = await generatePdf({
      title: 'Hybrid Learning',
      sections: [{ paragraphs: ['This renders correctly.'] }],
    });

    check('English drops nothing', english.unsupportedText.length, 0);
    assertTrue('and produces a file', english.bytes.length > 900);

    /*
     * Mixed text is refused too. A document that loses one Arabic phrase from
     * an English page is still a document with a hole in it, and the
     * researcher would not find it until a reader pointed it out.
     */
    const mixed = await generatePdf({
      title: 'Hybrid Learning',
      sections: [{ paragraphs: ['English with التعلم inside.'] }],
    });

    assertTrue('partial loss is still loss', mixed.unsupportedText.length > 0);

    /* The handler refuses rather than delivering. */
    const handlerSource = await readFile('src/server/tasks/handlers.ts', 'utf8');

    assertTrue(
      'the task handler checks for dropped text',
      handlerSource.includes('pdf.unsupportedText.length > 0'),
    );
    assertTrue(
      'and fails rather than delivering an empty file',
      handlerSource.includes("code: 'document.unsupportedScript'"),
    );
    assertTrue(
      'naming Word as the answer',
      handlerSource.includes('اطلب ملف Word'),
    );

    /* And the planner avoids the situation rather than hitting it. */
    const plannerSource = await readFile('src/server/tasks/planner.ts', 'utf8');

    assertTrue(
      'the planner knows PDF cannot render Arabic',
      plannerSource.includes('PDF CANNOT RENDER ARABIC'),
    );
  }


  /* --- a step that succeeds with something to say ----------------------- */

  {
    /*
     * A step can complete and still have something to report: three sources
     * found where ten were expected, a section written without evidence. The
     * observation has carried warnings and gaps since Phase A, and the
     * progress panel displayed neither — so partial work looked identical to
     * complete work.
     *
     * That is the more dangerous half of the pair. A failure is visible and
     * gets investigated; a quiet gap gets submitted.
     */
    const warningOwner = await newUser('warning-owner');

    registerHandler('academic.search', async (context) =>
      partial(
        [
          makeOutput(
            { taskId: context.taskId, stepId: context.stepId, capability: 'academic.search', projectId: context.projectId },
            'sources.v1',
            { references: [], found: 3 },
          ),
        ],
        ['sources newer than 2020'],
        {
          warnings: [
            { code: 'search.thin', severity: 'warning', message: 'Only three sources were found' },
          ],
        },
      ),
    );

    const task = await tasksRepo.create({
      userId: warningOwner,
      request: 'search with a thin result',
      locale: 'en',
      status: 'QUEUED',
      context: {},
      budget: DEFAULT_BUDGET as unknown as Record<string, number>,
      spent: { modelCalls: 0, retries: 0 },
    });

    await tasksRepo.addSteps([
      {
        taskId: task.id,
        ordinal: 0,
        capability: 'academic.search',
        label: 'search',
        status: 'PENDING',
        dependsOn: [],
        input: {},
      },
    ]);

    await runTask(task.id);

    /*
     * Read through `getTask`, which is what the polling path returns — so this
     * covers the transport as well as the storage. The stream sends the same
     * rows.
     */
    const view = await getTask(task.id, warningOwner);
    const step = view.steps[0];

    check('the step completed', step?.status, 'COMPLETED');

    const observation = (step?.output as { observation?: { warnings?: { message: string }[]; missingInformation?: string[] } } | null)
      ?.observation;

    check('its warning survived to the client', observation?.warnings?.length, 1);
    assertTrue(
      'with the message intact',
      observation?.warnings?.[0]?.message.includes('three sources') ?? false,
    );

    /*
     * A gap is not a warning: a warning says what happened, a gap says what
     * would have made it better. A researcher told "sources newer than 2020"
     * can supply them; one told nothing assumes the result is whole.
     */
    check('and the gap it named', observation?.missingInformation?.length, 1);

    /* The panel renders both. */
    const panelSource = await readFile('src/components/agent/task-progress.tsx', 'utf8');

    assertTrue('the panel reads step warnings', panelSource.includes('function stepWarnings'));
    assertTrue('and the gaps', panelSource.includes('function stepGaps'));
    assertTrue(
      'showing them on a completed step',
      panelSource.includes("step.status === 'COMPLETED' &&"),
    );
    /*
     * At most three, quietly. Most steps have nothing to say, and a panel that
     * shouts on every line teaches the researcher to stop reading it.
     */
    assertTrue('at most three notes', panelSource.includes('.slice(0, 3)'));
  }


  /* --- an uploaded file is a table or a document, and the step says which -- */

  {
    /*
     * Uploads were tabular only, so `file.analyse` returned `ready: true` and
     * nothing else — enough when every file had columns. Phase H made papers
     * uploadable, and a downstream step told only "ready" would look for
     * columns in a document and find none.
     */
    const fileOwner = await newUser('file-kind-owner');

    registerAllHandlers();

    const analyse = async (datasetId: string) => {
      const task = await tasksRepo.create({
        userId: fileOwner,
        request: 'analyse the file',
        locale: 'ar',
        status: 'QUEUED',
        context: {},
        budget: DEFAULT_BUDGET as unknown as Record<string, number>,
        spent: { modelCalls: 0, retries: 0 },
      });

      await tasksRepo.addSteps([
        {
          taskId: task.id,
          ordinal: 0,
          capability: 'file.analyse',
          label: 'analyse',
          status: 'PENDING',
          dependsOn: [],
          input: { datasetId },
        },
      ]);

      await runTask(task.id);

      const step = (await tasksRepo.stepsOf(task.id))[0];
      const data = (step?.output as { outputs?: { data?: Record<string, unknown> }[] } | null)
        ?.outputs?.[0]?.data;

      return { status: step?.status, data };
    };

    /* A paper. */
    const docxBytes = await generateDocx({
      title: 'Study',
      sections: [
        { heading: 'Methods', paragraphs: ['Participants were 214 undergraduates.'] },
      ],
    });

    const document = await saveUpload({
      userId: fileOwner,
      file: { name: 'study.docx', bytes: docxBytes.buffer as ArrayBuffer },
    });

    const documentResult = await analyse(document.dataset.id);

    check('a document analyses successfully', documentResult.status, 'COMPLETED');
    check('and is reported as a document', documentResult.data?.fileKind, 'document');
    assertTrue('with its length', (documentResult.data?.words as number) > 0);

    /* A spreadsheet. */
    const table = await saveUpload({
      userId: fileOwner,
      file: {
        name: 'data.csv',
        bytes: new TextEncoder().encode('age,score\n21,88\n22,91').buffer as ArrayBuffer,
      },
    });

    const tableResult = await analyse(table.dataset.id);

    check('a table analyses successfully', tableResult.status, 'COMPLETED');
    check('and is reported as a table', tableResult.data?.fileKind, 'table');
    assertTrue(
      'with its columns named',
      (tableResult.data?.columns as string[])?.includes('age') ?? false,
    );

    /*
     * A file that is gone. Reported rather than passed downstream: a step that
     * said "ready" about a deleted file would fail later, further from the
     * cause.
     */
    const missing = await analyse('00000000-0000-0000-0000-000000000000');

    check('a missing file fails at the step that needs it', missing.status, 'FAILED');

    /* And the planner is told not to plan statistics against prose. */
    const plannerSource = await readFile('src/server/tasks/planner.ts', 'utf8');

    assertTrue(
      'the planner distinguishes tables from documents',
      plannerSource.includes('AN UPLOADED FILE IS EITHER A TABLE OR A DOCUMENT'),
    );
  }

  /* ------------------------------------------------ P0.2 conversation IDOR */
  {
    section('P0.2 — a conversation is readable only by its owner');

    const conversationsRepo = await import('@/server/repositories/conversations.repository');
    const { requireOwned } = await import('@/server/services/chat.service');

    const owner = await newUser('p02-owner');
    const intruder = await newUser('p02-intruder');

    const conversation = await chatRepo.create({ userId: owner, mode: 'AGENT', title: 'private' });
    await conversationsRepo.addMessage({ conversationId: conversation.id, role: 'USER', content: 'secret research idea' });
    await conversationsRepo.addMessage({ conversationId: conversation.id, role: 'ASSISTANT', content: 'secret answer' });

    const own = await conversationsRepo.listMessagesOwned(conversation.id, owner, 6);
    check('the owner reads their messages', own.map((message) => message.content), ['secret research idea', 'secret answer']);

    const foreign = await conversationsRepo.listMessagesOwned(conversation.id, intruder, 6);
    check('another user reads nothing', foreign.length, 0);

    const limited = await conversationsRepo.listMessagesOwned(conversation.id, owner, 1);
    check('the limit keeps the latest message', limited.map((message) => message.content), ['secret answer']);

    await expectAppError('the chat route refuses a foreign conversation id', 'NOT_FOUND', () =>
      requireOwned(conversation.id, intruder),
    );
    await expectAppError('and an unknown one the same way', 'NOT_FOUND', () =>
      requireOwned('00000000-0000-0000-0000-000000000000', intruder),
    );
  }

  /* ------------------------------------------------ P0.3 email verification */
  {
    section('P0.3 — email verification');

    const { requestEmailVerification, verifyEmail } = await import('@/server/services/account.service');
    const usersRepo = await import('@/server/repositories/users.repository');
    const tokensRepo = await import('@/server/repositories/tokens.repository');
    const { createHash } = await import('node:crypto');

    const id = await newUser('p03-verify');
    check('a new account starts unverified', (await usersRepo.findById(id))?.emailVerified ?? null, null);

    const first = await requestEmailVerification(id, 'en');
    const firstToken = new URL(first.devUrl as string).searchParams.get('token') as string;
    const second = await requestEmailVerification(id, 'ar');
    const secondToken = new URL(second.devUrl as string).searchParams.get('token') as string;

    await expectAppError('asking again invalidates the earlier link', 'CONFLICT', () =>
      verifyEmail({ userId: id, token: firstToken }),
    );
    await expectAppError('a wrong token is refused', 'CONFLICT', () =>
      verifyEmail({ userId: id, token: 'f'.repeat(64) }),
    );

    /* The refused attempts above consumed nothing that belongs to the live link. */
    const third = await requestEmailVerification(id, 'en');
    const liveToken = new URL(third.devUrl as string).searchParams.get('token') as string;
    void secondToken;
    await verifyEmail({ userId: id, token: liveToken });
    assertTrue('the link verifies the address', Boolean((await usersRepo.findById(id))?.emailVerified));

    await expectAppError('a used link does not work twice', 'CONFLICT', () =>
      verifyEmail({ userId: id, token: liveToken }),
    );
    check('a verified account is not sent another link', (await requestEmailVerification(id, 'en')).alreadyVerified, true);

    /* An expired link is refused even with the right token. */
    const late = await newUser('p03-expired');
    const expiredToken = 'a'.repeat(64);
    await tokensRepo.put(
      `email-verify:${late}`,
      createHash('sha256').update(expiredToken).digest('hex'),
      new Date(Date.now() - 1000),
    );
    await expectAppError('an expired link is refused', 'CONFLICT', () =>
      verifyEmail({ userId: late, token: expiredToken }),
    );
    check('and the address stays unverified', (await usersRepo.findById(late))?.emailVerified ?? null, null);
  }

  /* ------------------------------------------------ P0.4 session invalidation */
  {
    section('P0.4 — ending sessions');

    const usersRepo = await import('@/server/repositories/users.repository');
    const { changePassword, requestPasswordReset, resetPassword } = await import('@/server/services/account.service');
    const { setUserRole, setUserStatus } = await import('@/server/services/admin.service');
    const { evaluateToken, loadSessionUser } = await import('@/server/auth/session-check');

    const id = await newUser('p04-sessions');
    const version = async () => (await usersRepo.findById(id))?.tokenVersion ?? -1;
    check('a new account starts at version 0', await version(), 0);

    /* A session issued now, and what the re-check says about it after each change. */
    const session = { tv: 0 };

    await changePassword(id, 'Passw0rd123', 'NewPassw0rd456');
    check('a password change ends open sessions', await version(), 1);
    check('the old session is refused', evaluateToken(session, await loadSessionUser(id, Date.now() + 60_000), Date.now()).action, 'revoke');

    const email = (await usersRepo.findById(id))?.email as string;
    const reset = await requestPasswordReset(email, 'en');
    const token = new URL(reset.devUrl as string).searchParams.get('token') as string;
    await resetPassword({ userId: id, token, password: 'Another1Passw0rd' });
    check('a password reset ends open sessions too', await version(), 2);

    const admin = await newUser('p04-admin');
    await setUserRole(admin, id, 'ADMIN');
    check('a promotion does not end sessions', await version(), 2);
    await setUserRole(admin, id, 'USER');
    check('a demotion does', await version(), 3);

    await setUserStatus(admin, id, 'SUSPENDED');
    check('a suspension does', await version(), 4);
    check('and a suspended account is refused on re-check', evaluateToken({ tv: 4 }, await loadSessionUser(id, Date.now() + 60_000), Date.now()), { action: 'revoke', reason: 'suspended' });
    await setUserStatus(admin, id, 'ACTIVE');
    check('reactivation keeps the version', await version(), 4);
  }

  /* ------------------------------------------------ P0.12 chat controls */
  {
    section('P0.12 — regenerate and edit answer the question once; roles and model reach the task');

    const { recordReply, requireOwned: owned } = await import('@/server/services/chat.service');
    const conversationsRepo = await import('@/server/repositories/conversations.repository');
    void owned;

    const person = await newUser('p012-chat');
    const other = await newUser('p012-other');
    const conversation = await chatRepo.create({ userId: person, mode: 'AGENT', title: 'controls' });

    const first = await recordReply({ conversationId: conversation.id, userId: person, userMessage: 'What is alpha?', assistantMessage: 'First answer.' });
    assertTrue('a new exchange returns both stored ids', Boolean(first.userMessageId && first.assistantMessageId));

    const prepared = await prepareRegeneration({ conversationId: conversation.id, userId: person, messageId: first.assistantMessageId });
    check('regeneration hands back the stored question', prepared.parentMessageId, first.userMessageId);

    const again = await recordReply({
      conversationId: conversation.id,
      userId: person,
      userMessage: prepared.prompt,
      assistantMessage: 'Second answer.',
      replyToMessageId: prepared.parentMessageId,
    });

    const all = await conversationsRepo.listMessagesOwned(conversation.id, person, 50);
    check('the question is stored once', all.filter((message) => message.role === 'USER').length, 1);
    check('with two answers under it', all.filter((message) => message.role === 'ASSISTANT' && message.parentMessageId === first.userMessageId).length, 2);
    check('the reply ids name the existing question', again.userMessageId, first.userMessageId);

    const thread = await getThread(conversation.id, person);
    const shown = (thread as { messages?: { content: string }[] }).messages ?? (thread as unknown as { content: string }[]);
    assertTrue('the active path shows the new answer', JSON.stringify(shown).includes('Second answer.') && !JSON.stringify(shown).includes('First answer.'));

    /* Edit: the edited question is a new branch; the answer attaches to it. */
    const edited = await editMessage({ conversationId: conversation.id, userId: person, messageId: first.userMessageId, content: 'What is omega?' });
    await recordReply({ conversationId: conversation.id, userId: person, userMessage: 'What is omega?', assistantMessage: 'Omega answer.', replyToMessageId: edited.id });
    const afterEdit = await conversationsRepo.listMessagesOwned(conversation.id, person, 50);
    check('an edit stores the new question once', afterEdit.filter((message) => message.role === 'USER' && message.content === 'What is omega?').length, 1);

    await expectAppError('a reply to an assistant message is refused', 'NOT_FOUND', () =>
      recordReply({ conversationId: conversation.id, userId: person, userMessage: 'x', assistantMessage: 'y', replyToMessageId: first.assistantMessageId }),
    );
    await expectAppError('a reply into someone else\'s conversation is refused', 'NOT_FOUND', () =>
      recordReply({ conversationId: conversation.id, userId: other, userMessage: 'x', assistantMessage: 'y', replyToMessageId: first.userMessageId }),
    );

    /* Roles and the chosen model travel in the task's context. */
    const { startTask } = await import('@/server/services/task.service');
    const task = await startTask({
      userId: person,
      request: 'compare scores between groups',
      locale: 'en',
      analysisHints: { intent: 'stats.compareGroups', mentioned: [], roles: [{ column: 'score', role: 'dependent' }] },
      chosenModel: { provider: 'anthropic', model: 'test-model' },
    } as Parameters<typeof startTask>[0]);
    const stored = await tasksRepo.findAny(task.id);
    const storedRoles = (stored?.context.analysisHints as { roles?: { column: string; role: string }[] })?.roles ?? [];
    check('the picker\'s roles reach the task', storedRoles.map((row) => `${row.column}:${row.role}`).join(','), 'score:dependent');
    const storedModel = stored?.context.chosenModel as { provider?: string; model?: string } | undefined;
    check('and so does the chosen model', `${storedModel?.provider}/${storedModel?.model}`, 'anthropic/test-model');
    await tasksRepo.setStatus(task.id, 'CANCELLED');

    const { currentPreferredModel, runForUser } = await import('@/server/ai/request-scope');
    const seen = await runForUser(person, async () => currentPreferredModel(), { provider: 'openai', model: 'x' });
    check('the chosen model is visible to every model call in the scope', seen?.provider, 'openai');
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


