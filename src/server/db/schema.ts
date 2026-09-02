/**
 * Database schema — PostgreSQL via Drizzle ORM.
 *
 * Design notes that are easy to miss when reading top to bottom:
 * - `researchSections` holds the *content* of a project; `researchProjects` holds only
 *   its identity and settings. That split is what makes "go back to any step and edit it"
 *   and "resume from where you left off" possible.
 * - `sectionKey` and `toolKey` are typed varchars rather than PG enums on purpose: new
 *   sections and tools ship without a database migration.
 * - Every plan limit lives in `subscriptionPlans` / `planFeatures`. Nothing is hard-coded.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { AdapterAccountType } from 'next-auth/adapters';

import type { SectionKey, ToolKey } from '@/config/research';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull();

const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

/* -------------------------------------------------------------------------- */
/*                                    Enums                                   */
/* -------------------------------------------------------------------------- */

export const userRoleEnum = pgEnum('user_role', ['USER', 'ADMIN']);
export const userStatusEnum = pgEnum('user_status', ['ACTIVE', 'SUSPENDED']);
export const localeEnum = pgEnum('locale', ['ar', 'en']);
export const themeEnum = pgEnum('theme', ['LIGHT', 'DARK', 'SYSTEM']);

export const degreeEnum = pgEnum('degree', ['BACHELOR', 'MASTER', 'PHD', 'PAPER']);
export const projectLanguageEnum = pgEnum('project_language', ['AR', 'EN']);
export const researchTypeEnum = pgEnum('research_type', [
  'QUANTITATIVE',
  'QUALITATIVE',
  'MIXED_METHODS',
  'REVIEW_PAPER',
  'EXPERIMENTAL',
]);
export const docTypeEnum = pgEnum('doc_type', ['PAPER', 'PROPOSAL', 'THESIS']);

export const sectionStatusEnum = pgEnum('section_status', [
  'EMPTY',
  'DRAFT',
  'AI_SUGGESTED',
  'USER_EDITED',
  'APPROVED',
]);
export const versionOriginEnum = pgEnum('version_origin', ['AI', 'USER']);

export const conversationScopeEnum = pgEnum('conversation_scope', ['PROJECT', 'SECTION', 'TOOL']);
export const messageRoleEnum = pgEnum('message_role', ['USER', 'ASSISTANT', 'SYSTEM']);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
  'CANCELED',
]);
export const paymentStatusEnum = pgEnum('payment_status', [
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
]);
export const usageMetricEnum = pgEnum('usage_metric', [
  'AI_REQUEST',
  'GENERATED_WORD',
  'PROJECT',
  'TOOL_RUN',
  'EXPORT',
]);
export const verificationStatusEnum = pgEnum('verification_status', [
  'UNVERIFIED',
  'USER_CONFIRMED',
]);
export const citationStyleEnum = pgEnum('citation_style', ['APA7', 'HARVARD', 'MLA', 'CHICAGO']);

/* -------------------------------------------------------------------------- */
/*                          Auth.js required tables                           */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: id(),
    name: text('name'),
    email: text('email').notNull(),
    emailVerified: timestamp('email_verified', { withTimezone: true, mode: 'date' }),
    image: text('image'),
    passwordHash: text('password_hash'),
    role: userRoleEnum('role').default('USER').notNull(),
    status: userStatusEnum('status').default('ACTIVE').notNull(),
    locale: localeEnum('locale').default('ar').notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

export const accounts = pgTable(
  'accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<AdapterAccountType>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerAccountId] }),
    index('accounts_user_id_idx').on(table.userId),
  ],
);

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);

/* -------------------------------------------------------------------------- */
/*                                User settings                               */
/* -------------------------------------------------------------------------- */

export const userSettings = pgTable(
  'user_settings',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    theme: themeEnum('theme').default('SYSTEM').notNull(),
    preferredLocale: localeEnum('preferred_locale').default('ar').notNull(),
    citationStyle: citationStyleEnum('citation_style').default('APA7').notNull(),
    defaultAcademicField: text('default_academic_field'),
    emailNotifications: boolean('email_notifications').default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('user_settings_user_id_unique').on(table.userId)],
);

/* -------------------------------------------------------------------------- */
/*                           Plans & subscriptions                            */
/* -------------------------------------------------------------------------- */

export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    id: id(),
    code: varchar('code', { length: 32 }).notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    descriptionEn: text('description_en'),
    descriptionAr: text('description_ar'),
    priceCents: integer('price_cents').default(0).notNull(),
    currency: varchar('currency', { length: 8 }).default('USD').notNull(),
    billingInterval: varchar('billing_interval', { length: 16 }).default('month').notNull(),
    /** -1 means unlimited. Read through `resolveLimit()`, never inline. */
    maxProjects: integer('max_projects').default(1).notNull(),
    maxAiRequests: integer('max_ai_requests').default(20).notNull(),
    maxGeneratedWords: integer('max_generated_words').default(5000).notNull(),
    maxExports: integer('max_exports').default(0).notNull(),
    toolAccess: jsonb('tool_access').$type<Record<string, boolean>>().default({}).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    externalPriceId: text('external_price_id'),
    /**
     * Agent tasks allowed per month. Deliberately nullable: phase two measures
     * task usage without enforcing it, and the limits are set from real numbers
     * rather than guesses once there are some. Null means "not enforced".
     */
    maxAiTasks: integer('max_ai_tasks'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('subscription_plans_code_unique').on(table.code)],
);

export const planFeatures = pgTable(
  'plan_features',
  {
    id: id(),
    planId: text('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'cascade' }),
    featureKey: varchar('feature_key', { length: 64 }).notNull(),
    labelEn: text('label_en').notNull(),
    labelAr: text('label_ar').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    limitValue: integer('limit_value'),
    sortOrder: integer('sort_order').default(0).notNull(),
  },
  (table) => [uniqueIndex('plan_features_plan_key_unique').on(table.planId, table.featureKey)],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'restrict' }),
    status: subscriptionStatusEnum('status').default('ACTIVE').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'date' }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false).notNull(),
    canceledAt: timestamp('canceled_at', { withTimezone: true, mode: 'date' }),
    provider: varchar('provider', { length: 32 }).default('manual').notNull(),
    externalCustomerId: text('external_customer_id'),
    externalSubscriptionId: text('external_subscription_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('subscriptions_user_id_unique').on(table.userId),
    index('subscriptions_status_idx').on(table.status),
  ],
);

/* -------------------------------------------------------------------------- */
/*                                  Payments                                  */
/* -------------------------------------------------------------------------- */

/**
 * An append-only ledger of every money movement the gateway told us about.
 *
 * Separate from `subscriptions` on purpose: a subscription has one current
 * state, while billing history must survive plan changes, cancellation, and
 * even the deletion of the subscription row. `externalPaymentId` is unique so a
 * webhook redelivery — which PayPal does routinely — cannot double-count
 * revenue.
 */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subscriptionId: text('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    planCode: varchar('plan_code', { length: 32 }),
    provider: varchar('provider', { length: 32 }).notNull(),
    status: paymentStatusEnum('status').notNull(),
    /** Minor units, matching `subscriptionPlans.priceCents`. */
    amountCents: integer('amount_cents').default(0).notNull(),
    // Same width as `subscriptionPlans.currency`: a narrower column here would
    // throw a Postgres 22001 inside the webhook handler, which the gateway sees
    // as a failure and retries for days.
    currency: varchar('currency', { length: 8 }).default('USD').notNull(),
    externalPaymentId: text('external_payment_id'),
    externalSubscriptionId: text('external_subscription_id'),
    /** The gateway's event id, kept so a redelivery is recognisable in support. */
    externalEventId: text('external_event_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('payments_external_payment_id_unique').on(table.externalPaymentId),
    index('payments_user_id_idx').on(table.userId),
    index('payments_occurred_at_idx').on(table.occurredAt),
    index('payments_status_idx').on(table.status),
  ],
);

/* -------------------------------------------------------------------------- */
/*                              Usage tracking                                */
/* -------------------------------------------------------------------------- */

export const usageTracking = pgTable(
  'usage_tracking',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id'),
    /** `YYYY-MM` — the aggregation key for "what is left this month". */
    periodKey: varchar('period_key', { length: 7 }).notNull(),
    metric: usageMetricEnum('metric').notNull(),
    toolKey: varchar('tool_key', { length: 64 }).$type<ToolKey | null>(),
    amount: integer('amount').default(1).notNull(),
    tokensIn: integer('tokens_in').default(0).notNull(),
    tokensOut: integer('tokens_out').default(0).notNull(),
    costMicroUsd: integer('cost_micro_usd').default(0).notNull(),
    provider: varchar('provider', { length: 32 }),
    model: varchar('model', { length: 64 }),
    createdAt: createdAt(),
  },
  (table) => [
    index('usage_tracking_period_idx').on(table.userId, table.periodKey, table.metric),
    index('usage_tracking_created_idx').on(table.createdAt),
  ],
);

/* -------------------------------------------------------------------------- */
/*                             Research projects                              */
/* -------------------------------------------------------------------------- */

export const researchProjects = pgTable(
  'research_projects',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    academicField: text('academic_field').notNull(),
    specialization: text('specialization'),
    degree: degreeEnum('degree').notNull(),
    language: projectLanguageEnum('language').default('AR').notNull(),
    researchType: researchTypeEnum('research_type').notNull(),
    keywords: text('keywords')
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    problemArea: text('problem_area'),
    docType: docTypeEnum('doc_type').default('PAPER').notNull(),
    progressPercent: integer('progress_percent').default(0).notNull(),
    totalWords: integer('total_words').default(0).notNull(),
    isArchived: boolean('is_archived').default(false).notNull(),
    lastEditedAt: timestamp('last_edited_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('research_projects_user_idx').on(table.userId, table.lastEditedAt),
    index('research_projects_archived_idx').on(table.isArchived),
  ],
);

export const researchSections = pgTable(
  'research_sections',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => researchProjects.id, { onDelete: 'cascade' }),
    sectionKey: varchar('section_key', { length: 64 }).$type<SectionKey>().notNull(),
    orderIndex: integer('order_index').default(0).notNull(),
    heading: text('heading'),
    content: text('content').default('').notNull(),
    status: sectionStatusEnum('status').default('EMPTY').notNull(),
    wordCount: integer('word_count').default(0).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('research_sections_project_key_unique').on(table.projectId, table.sectionKey),
    index('research_sections_project_order_idx').on(table.projectId, table.orderIndex),
  ],
);

export const sectionVersions = pgTable(
  'section_versions',
  {
    id: id(),
    sectionId: text('section_id')
      .notNull()
      .references(() => researchSections.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    origin: versionOriginEnum('origin').notNull(),
    wordCount: integer('word_count').default(0).notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (table) => [index('section_versions_section_idx').on(table.sectionId, table.createdAt)],
);

export const titleCandidates = pgTable(
  'title_candidates',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => researchProjects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    rationale: text('rationale'),
    researchProblem: text('research_problem'),
    variables: text('variables')
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    fitScore: integer('fit_score').default(0).notNull(),
    innovationScore: integer('innovation_score').default(0).notNull(),
    selected: boolean('selected').default(false).notNull(),
    batch: integer('batch').default(1).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('title_candidates_project_idx').on(table.projectId, table.batch)],
);

export const projectNotes = pgTable(
  'project_notes',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => researchProjects.id, { onDelete: 'cascade' }),
    title: text('title'),
    body: text('body').default('').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('project_notes_project_idx').on(table.projectId)],
);

export const references = pgTable(
  'references',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => researchProjects.id, { onDelete: 'cascade' }),
    rawText: text('raw_text').notNull(),
    authors: text('authors'),
    title: text('title'),
    year: integer('year'),
    source: text('source'),
    publisher: text('publisher'),
    doi: text('doi'),
    url: text('url'),
    /**
     * Always starts UNVERIFIED. Only an explicit human action may promote it —
     * the AI layer is never allowed to write USER_CONFIRMED.
     */
    verification: verificationStatusEnum('verification').default('UNVERIFIED').notNull(),
    style: citationStyleEnum('style').default('APA7').notNull(),
    formatted: text('formatted'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('references_project_idx').on(table.projectId)],
);

/* -------------------------------------------------------------------------- */
/*                             AI conversations                               */
/* -------------------------------------------------------------------------- */

export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /*
     * Detached rather than destroyed when a project is deleted.
     *
     * This cascaded, alone among the tables that reference a project — datasets,
     * analysis runs and agent tasks all detach. A conversation can hold an
     * analysis that took minutes to produce and a discussion the researcher
     * relies on, and deleting the container it happened to sit in is not a
     * decision to delete that.
     *
     * The inconsistency was almost certainly unintended: nothing distinguishes
     * a conversation from a dataset here except that one was written with a
     * different default.
     */
    projectId: text('project_id').references(() => researchProjects.id, { onDelete: 'set null' }),
    title: text('title'),
    scope: conversationScopeEnum('scope').default('PROJECT').notNull(),
    sectionKey: varchar('section_key', { length: 64 }).$type<SectionKey | null>(),
    toolKey: varchar('tool_key', { length: 64 }).$type<ToolKey | null>(),
    /**
     * How the conversation is driven: the existing section and tool chats, or
     * the agent. A typed varchar rather than a new value on `conversation_scope`
     * — altering a PG enum is the riskiest thing a migration can do, and this
     * vocabulary will keep growing.
     */
    mode: varchar('mode', { length: 32 }).$type<'CHAT' | 'AGENT' | null>(),
    /**
     * When the last message arrived.
     *
     * Derived from the messages and stored anyway, because the sidebar orders
     * conversations by recency on every page load. Computing it as a join
     * against `ai_messages` would mean aggregating the whole message table to
     * render a list of twenty titles — the classic query that is fine with a
     * hundred conversations and unusable with ten thousand.
     */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' }),
    /**
     * Soft delete.
     *
     * "Delete this conversation" hides it and keeps the messages, for the same
     * reason deleting a dataset keeps its analyses: a researcher who deletes a
     * thread and then realises the answer mattered should not have lost it, and
     * an accidental click should not be irreversible. A permanent purge is a
     * separate, deliberate action.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('ai_conversations_project_idx').on(table.projectId, table.updatedAt),
    index('ai_conversations_user_idx').on(table.userId),
    /* The sidebar query: this user's live conversations, newest first. */
    index('ai_conversations_recent_idx').on(table.userId, table.lastMessageAt),
  ],
);

export const aiMessages = pgTable(
  'ai_messages',
  {
    id: id(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    provider: varchar('provider', { length: 32 }),
    model: varchar('model', { length: 64 }),
    tokensIn: integer('tokens_in').default(0).notNull(),
    tokensOut: integer('tokens_out').default(0).notNull(),
    /** Guardrail findings attached to this message (unverified citations, etc.). */
    flags: jsonb('flags').$type<string[]>().default([]).notNull(),
    /**
     * Structured content attached to a message — an analysis result, a plan, a
     * table. Stored rather than rendered into the text so that reopening a
     * conversation redraws the real table instead of a paragraph describing one.
     */
    payload: jsonb('payload').$type<Record<string, unknown> | null>(),
    /**
     * The message this one replies to. Null for the first message in a thread.
     *
     * This turns the conversation from a list into a tree, and the tree is what
     * makes editing and regeneration work properly rather than destructively.
     *
     * Editing a message does not overwrite it. A new message is created with
     * the same parent, so the parent now has two children and one of them is
     * marked active. The conversation the user sees is the active path from the
     * root to the newest leaf; the other branch still exists and can be
     * returned to.
     *
     * Built now rather than later on purpose. Adding branching on top of a flat
     * list means backfilling every existing message and rewriting every query
     * that reads a conversation. Adding it now costs three nullable columns.
     */
    parentMessageId: text('parent_message_id'),
    /**
     * Whether this message is on the path currently being shown.
     *
     * With no branches every message is active and this changes nothing. With
     * branches, exactly one child of any parent is active at a time, and
     * switching branches is an update to this column rather than a deletion.
     */
    isActive: boolean('is_active').default(true).notNull(),
    /** Set when a user rewrote their message, so the interface can mark it. */
    editedAt: timestamp('edited_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    index('ai_messages_conversation_idx').on(table.conversationId, table.createdAt),
    /* Walking the tree: the children of a message, and the active path. */
    index('ai_messages_parent_idx').on(table.parentMessageId),
    index('ai_messages_active_idx').on(table.conversationId, table.isActive, table.createdAt),
  ],
);

/* -------------------------------------------------------------------------- */
/*                                  Datasets                                  */
/* -------------------------------------------------------------------------- */

/**
 * An uploaded data file, or a cleaned derivation of one.
 *
 * The bytes never live here. Only the description does: where the file is, how
 * big it is, and the profile computed from it. A twelve-megabyte spreadsheet in
 * a jsonb column would make every query that touches this table slow, and the
 * rows are needed only when an analysis runs.
 *
 * Original and cleaned are separate rows linked by `parentDatasetId`, so the
 * researcher's own data is never overwritten by the tool's tidying of it.
 */
export const datasets = pgTable(
  'datasets',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** A file may belong to no project — one uploaded straight into a chat. */
    projectId: text('project_id').references(() => researchProjects.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id').references(() => aiConversations.id, {
      onDelete: 'set null',
    }),
    /** ORIGINAL is written once and never modified. CLEANED derives from it. */
    kind: varchar('kind', { length: 16 }).$type<'ORIGINAL' | 'CLEANED'>().default('ORIGINAL').notNull(),
    /**
     * The original a cleaned copy came from.
     *
     * Cascading is the point rather than an incidental choice: "delete
     * everything" must take the cleaned derivations with it. Without the
     * constraint, removing an original leaves its tidied copies behind as
     * orphans pointing at an id that no longer exists — files the user believes
     * they deleted, still on disk, still holding their data.
     */
    parentDatasetId: text('parent_dataset_id').references((): AnyPgColumn => datasets.id, {
      onDelete: 'cascade',
    }),
    originalName: text('original_name').notNull(),
    /** Path in the storage provider. Never a URL, never public. */
    storageKey: text('storage_key').notNull(),
    mimeType: varchar('mime_type', { length: 128 }),
    byteSize: integer('byte_size').default(0).notNull(),
    /** SHA-256 of the stored bytes, to detect corruption and duplicate uploads. */
    checksum: varchar('checksum', { length: 64 }),
    rowCount: integer('row_count').default(0).notNull(),
    columnCount: integer('column_count').default(0).notNull(),
    /** Set when the file was longer than the interactive analysis window. */
    truncatedTo: integer('truncated_to'),
    /** The `DatasetProfile` computed at upload: column types, scales, issues. */
    profile: jsonb('profile').$type<Record<string, unknown>>(),
    /**
     * Soft delete. "Delete the file" removes the bytes and sets this; the
     * analyses computed from it survive, because a number already cited in a
     * thesis should not vanish when its source file is tidied away. "Delete
     * everything" removes the row and cascades to the runs.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('datasets_user_idx').on(table.userId, table.createdAt),
    index('datasets_project_idx').on(table.projectId),
    index('datasets_parent_idx').on(table.parentDatasetId),
  ],
);

/**
 * One statistical analysis, with everything needed to reproduce and cite it.
 *
 * `testKey` is a typed varchar rather than a PG enum, for the same reason
 * `sectionKey` and `toolKey` are: adding a test must not require a migration,
 * and this vocabulary will grow through every remaining phase.
 *
 * `projectId` and `sectionKey` are how a result finds its way into a thesis
 * chapter later. They stay null for an analysis run in a chat that was never
 * attached to a project.
 */
export const analysisRuns = pgTable(
  'analysis_runs',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => researchProjects.id, { onDelete: 'set null' }),
    /** The section this result belongs to, once the researcher attaches it. */
    sectionKey: varchar('section_key', { length: 64 }).$type<SectionKey | null>(),
    conversationId: text('conversation_id').references(() => aiConversations.id, {
      onDelete: 'set null',
    }),
    /** 't.independent', 'anova.oneWay', 'regression.ols', … */
    testKey: varchar('test_key', { length: 64 }).notNull(),
    /** Which columns, in which roles, with which options — enough to re-run it. */
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
    /** The full `InferentialResult`: statistic, p, effect, assumptions, warnings. */
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('analysis_runs_user_idx').on(table.userId, table.createdAt),
    index('analysis_runs_dataset_idx').on(table.datasetId),
    index('analysis_runs_project_idx').on(table.projectId, table.sectionKey),
  ],
);

/**
 * One agent task, from the user's request to its completion.
 *
 * This exists so that a request which internally makes eight model calls is
 * counted as one thing, which is how the user experiences it. Phase two records
 * these and enforces nothing: the weights and quotas are set later from real
 * measurements rather than from a guess made before anyone had used the feature.
 *
 * A separate table rather than a new value on the `usage_metric` enum. Altering
 * a PostgreSQL enum is the riskiest operation a migration can perform, and a
 * task carries structure — stages, timings, a declared ceiling — that a usage
 * row has nowhere to put.
 */
/**
 * Long-running analyses that outlive the request that started them.
 *
 * Bootstrapping a PLS model means running the estimation five thousand times.
 * That takes a minute or more, and an HTTP request will not survive it — so the
 * request records a job, returns its id, and the work continues afterwards
 * while the client polls.
 *
 * Separate from `agent_tasks`, which measures what the agent did for metering
 * and never carries a payload. This carries the result, and the two answer
 * different questions: one is "what did this cost", the other is "is it ready".
 *
 * The honest limitation, recorded here because it shapes the design: on the
 * current hosting the work runs inside the web process. A redeploy mid-run
 * loses it, which is why `startedAt` exists — anything still RUNNING at boot
 * is marked failed rather than left claiming to be in progress forever.
 */
export const analysisJobs = pgTable(
  'analysis_jobs',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    datasetId: text('dataset_id').references(() => datasets.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => researchProjects.id, { onDelete: 'set null' }),
    /** 'pls.bootstrap' for now; the table is general on purpose. */
    kind: varchar('kind', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 })
      .$type<'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'>()
      .default('QUEUED')
      .notNull(),
    /** 0–100, so the interface can show something moving rather than a spinner. */
    progress: integer('progress').default(0).notNull(),
    /** What it is doing now — 'estimating', 'resampling', 'summarising'. */
    stage: varchar('stage', { length: 32 }),
    /** The model specification and options, so a job can be re-run or explained. */
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    /** A reason key, resolved to a sentence when it is shown. */
    errorReasonKey: varchar('error_reason_key', { length: 128 }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('analysis_jobs_user_idx').on(table.userId, table.createdAt),
    /* Finding work to resume, and finding jobs orphaned by a restart. */
    index('analysis_jobs_status_idx').on(table.status, table.startedAt),
  ],
);

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => aiConversations.id, {
      onDelete: 'set null',
    }),
    projectId: text('project_id').references(() => researchProjects.id, { onDelete: 'set null' }),
    /** 'analysis.run', 'data.clean', 'research.plan', … */
    kind: varchar('kind', { length: 64 }).notNull(),
    /** The classified intent, kept to measure how often classification is right. */
    intent: varchar('intent', { length: 64 }),
    status: varchar('status', { length: 16 })
      .$type<'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'>()
      .default('RUNNING')
      .notNull(),
    /** `YYYY-MM`, matching the aggregation key `usage_tracking` already uses. */
    periodKey: varchar('period_key', { length: 7 }).notNull(),
    /** What the task was declared it could cost, and what it actually cost. */
    declaredUnits: integer('declared_units').default(0).notNull(),
    chargedUnits: integer('charged_units').default(0).notNull(),
    /** Internals, for setting fair weights later. */
    stagesPlanned: integer('stages_planned').default(0).notNull(),
    stagesCompleted: integer('stages_completed').default(0).notNull(),
    aiRequestCount: integer('ai_request_count').default(0).notNull(),
    tokensIn: integer('tokens_in').default(0).notNull(),
    tokensOut: integer('tokens_out').default(0).notNull(),
    costMicroUsd: integer('cost_micro_usd').default(0).notNull(),
    generatedWords: integer('generated_words').default(0).notNull(),
    datasetRows: integer('dataset_rows'),
    durationMs: integer('duration_ms'),
    /** Per-stage timings and any failure reason. */
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    startedAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('agent_tasks_user_period_idx').on(table.userId, table.periodKey),
    index('agent_tasks_started_idx').on(table.startedAt),
    index('agent_tasks_conversation_idx').on(table.conversationId),
  ],
);

/* -------------------------------------------------------------------------- */
/*                              App settings                                  */
/* -------------------------------------------------------------------------- */

/** Single-row key/value store the admin dashboard writes to (AI provider, model, …). */
export const appSettings = pgTable('app_settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

/* -------------------------------------------------------------------------- */
/*                                 Relations                                  */
/* -------------------------------------------------------------------------- */

export const paymentsRelations = relations(payments, ({ one }) => ({
  user: one(users, { fields: [payments.userId], references: [users.id] }),
  subscription: one(subscriptions, {
    fields: [payments.subscriptionId],
    references: [subscriptions.id],
  }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  settings: one(userSettings, { fields: [users.id], references: [userSettings.userId] }),
  subscription: one(subscriptions, { fields: [users.id], references: [subscriptions.userId] }),
  projects: many(researchProjects),
  conversations: many(aiConversations),
  usage: many(usageTracking),
}));

export const subscriptionPlansRelations = relations(subscriptionPlans, ({ many }) => ({
  subscriptions: many(subscriptions),
  features: many(planFeatures),
}));

export const planFeaturesRelations = relations(planFeatures, ({ one }) => ({
  plan: one(subscriptionPlans, {
    fields: [planFeatures.planId],
    references: [subscriptionPlans.id],
  }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
  plan: one(subscriptionPlans, {
    fields: [subscriptions.planId],
    references: [subscriptionPlans.id],
  }),
}));

export const researchProjectsRelations = relations(researchProjects, ({ one, many }) => ({
  user: one(users, { fields: [researchProjects.userId], references: [users.id] }),
  sections: many(researchSections),
  conversations: many(aiConversations),
  references: many(references),
  notes: many(projectNotes),
  titleCandidates: many(titleCandidates),
}));

export const researchSectionsRelations = relations(researchSections, ({ one, many }) => ({
  project: one(researchProjects, {
    fields: [researchSections.projectId],
    references: [researchProjects.id],
  }),
  versions: many(sectionVersions),
}));

export const sectionVersionsRelations = relations(sectionVersions, ({ one }) => ({
  section: one(researchSections, {
    fields: [sectionVersions.sectionId],
    references: [researchSections.id],
  }),
}));

export const aiConversationsRelations = relations(aiConversations, ({ one, many }) => ({
  user: one(users, { fields: [aiConversations.userId], references: [users.id] }),
  project: one(researchProjects, {
    fields: [aiConversations.projectId],
    references: [researchProjects.id],
  }),
  messages: many(aiMessages),
}));

export const aiMessagesRelations = relations(aiMessages, ({ one }) => ({
  conversation: one(aiConversations, {
    fields: [aiMessages.conversationId],
    references: [aiConversations.id],
  }),
}));

export const datasetsRelations = relations(datasets, ({ one, many }) => ({
  user: one(users, { fields: [datasets.userId], references: [users.id] }),
  project: one(researchProjects, {
    fields: [datasets.projectId],
    references: [researchProjects.id],
  }),
  runs: many(analysisRuns),
}));

export const analysisRunsRelations = relations(analysisRuns, ({ one }) => ({
  dataset: one(datasets, { fields: [analysisRuns.datasetId], references: [datasets.id] }),
  project: one(researchProjects, {
    fields: [analysisRuns.projectId],
    references: [researchProjects.id],
  }),
}));

export const agentTasksRelations = relations(agentTasks, ({ one }) => ({
  user: one(users, { fields: [agentTasks.userId], references: [users.id] }),
  conversation: one(aiConversations, {
    fields: [agentTasks.conversationId],
    references: [aiConversations.id],
  }),
}));

export const referencesRelations = relations(references, ({ one }) => ({
  project: one(researchProjects, {
    fields: [references.projectId],
    references: [researchProjects.id],
  }),
}));

/* -------------------------------------------------------------------------- */
/*                              Inferred types                                */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserSettingsRow = typeof userSettings.$inferSelect;
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type PlanFeature = typeof planFeatures.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type UsageRow = typeof usageTracking.$inferSelect;
export type ResearchProject = typeof researchProjects.$inferSelect;
export type NewResearchProject = typeof researchProjects.$inferInsert;
export type ResearchSection = typeof researchSections.$inferSelect;
export type SectionVersion = typeof sectionVersions.$inferSelect;
export type TitleCandidate = typeof titleCandidates.$inferSelect;
export type ReferenceRow = typeof references.$inferSelect;
export type AnalysisJob = typeof analysisJobs.$inferSelect;

/**
 * A file the system generated, kept as a first-class object.
 *
 * Documents were produced and handed over: the Word export wrote a file,
 * streamed it, and forgot it. A researcher who exported a thesis, changed a
 * chapter and exported again had no way to reach the first one — and no way to
 * tell which version their supervisor had read.
 *
 * **Nothing is overwritten.** Regenerating creates a new row pointing at the
 * previous one, so the chain is walkable in both directions. A researcher who
 * regenerates at midnight and realises at nine that the earlier draft was
 * better can still get it.
 *
 * The quality report travels with the file rather than being computed on
 * demand, because it describes the artefact as it was generated. Re-running the
 * check later would judge a March export against a June bibliography.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /* Detached rather than destroyed when a project goes, like conversations. */
    projectId: text('project_id').references(() => researchProjects.id, { onDelete: 'set null' }),
    /* The job that produced it, when one did. */
    jobId: text('job_id').references(() => analysisJobs.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id').references(() => aiConversations.id, {
      onDelete: 'set null',
    }),

    /** docx, pdf, pptx, xlsx, csv, md, bib, ris. */
    kind: varchar('kind', { length: 16 }).notNull(),
    filename: text('filename').notNull(),
    /** Where the bytes live, in the same object store uploads use. */
    storageKey: text('storage_key').notNull(),
    byteSize: integer('byte_size').notNull(),

    /**
     * Version within its lineage, from 1.
     *
     * Stored rather than derived by counting: a count would renumber every
     * version if one were ever removed, and a researcher citing "version 3" in
     * an email expects it to stay version 3.
     */
    version: integer('version').default(1).notNull(),
    /** The version this replaces. Null for the first in a lineage. */
    parentArtifactId: text('parent_artifact_id'),
    /** Stable across versions, so a lineage can be fetched in one query. */
    lineageId: text('lineage_id').notNull(),

    /** What produced it: the style, the sections, the options. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    /** The quality report as generated. Null when checking was skipped. */
    qualityReport: jsonb('quality_report').$type<Record<string, unknown> | null>(),
    /** pass, attention, fail, not-applicable, or unchecked. */
    validationStatus: varchar('validation_status', { length: 16 }).default('unchecked').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('artifacts_user_idx').on(table.userId, table.createdAt),
    index('artifacts_project_idx').on(table.projectId),
    /* The lineage query: every version of one document, newest first. */
    index('artifacts_lineage_idx').on(table.lineageId, table.version),
  ],
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;

/**
 * A long-running task and its plan.
 *
 * Separate from `analysis_jobs`, which holds one unit of work with a known
 * shape. A task is a *plan* — a sequence of steps that may grow while it runs,
 * with dependencies between them and a budget across them. Forcing that into a
 * table designed for "run this bootstrap" would mean storing the plan in a JSON
 * blob nobody can query, and the first question anyone asks is "which step is
 * it on".
 */
export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => researchProjects.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id').references(() => aiConversations.id, {
      onDelete: 'set null',
    }),

    /** The request, as the user wrote it. */
    request: text('request').notNull(),
    locale: varchar('locale', { length: 2 }).default('en').notNull(),

    /**
     * QUEUED, PLANNING, RUNNING, PAUSED, WAITING_FOR_INPUT, COMPLETED, FAILED,
     * CANCELLED.
     *
     * PAUSED and WAITING_FOR_INPUT are different states with different
     * remedies: one is the system stopping at a budget limit, the other is the
     * system needing an answer. Collapsing them would leave the user unable to
     * tell "you have hit a limit" from "I need to know something".
     */
    status: varchar('status', { length: 20 }).default('QUEUED').notNull(),

    /** The question, when waiting for input. */
    pendingQuestion: text('pending_question'),
    /** Why it paused, when paused at a limit. */
    pauseReasonKey: varchar('pause_reason_key', { length: 128 }),

    /**
     * Facts gathered as the task runs, keyed so a later step can read them.
     *
     * Deliberately not the whole conversation: passing everything between steps
     * costs tokens on every call and makes a step's behaviour depend on
     * anything that happened earlier, which is untestable.
     */
    context: jsonb('context').$type<Record<string, unknown>>().default({}).notNull(),

    /** Ceilings, resolved at creation so a change does not affect a running task. */
    budget: jsonb('budget').$type<Record<string, number>>().default({}).notNull(),
    /** What has been consumed against them. */
    spent: jsonb('spent').$type<Record<string, number>>().default({}).notNull(),

    errorReasonKey: varchar('error_reason_key', { length: 128 }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('tasks_user_idx').on(table.userId, table.createdAt),
    /* The recovery query: tasks that were running when the process stopped. */
    index('tasks_status_idx').on(table.status),
  ],
);

/**
 * One step of a plan.
 *
 * Rows rather than a JSON array, because the executor asks questions of them —
 * which steps are ready, which are blocked, which have retries left — and those
 * are queries, not array scans. Steps added while the task runs are the same
 * shape as planned ones, so a dynamically added step is as traceable as any
 * other.
 */
export const taskSteps = pgTable(
  'task_steps',
  {
    id: id(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),

    /** Position in the plan. Not execution order — dependencies decide that. */
    ordinal: integer('ordinal').notNull(),
    /** The capability this step runs: 'web.search', 'document.generate', … */
    capability: varchar('capability', { length: 64 }).notNull(),
    /** What the step is for, in the user's language, for the progress display. */
    label: text('label').notNull(),

    /** PENDING, RUNNING, COMPLETED, FAILED, SKIPPED, BLOCKED. */
    status: varchar('status', { length: 16 }).default('PENDING').notNull(),

    /** Step ids this one needs. Empty means it can start immediately. */
    dependsOn: jsonb('depends_on').$type<string[]>().default([]).notNull(),

    /** Structured input, assembled from the task context and prior outputs. */
    input: jsonb('input').$type<Record<string, unknown>>().default({}).notNull(),
    /** Structured output, which dependent steps read by key. */
    output: jsonb('output').$type<Record<string, unknown> | null>(),
    /** Artifacts this step produced. */
    artifactIds: jsonb('artifact_ids').$type<string[]>().default([]).notNull(),

    attempts: integer('attempts').default(0).notNull(),
    errorReasonKey: varchar('error_reason_key', { length: 128 }),
    /** True when the planner added it after execution began. */
    dynamic: boolean('dynamic').default(false).notNull(),

    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('task_steps_task_idx').on(table.taskId, table.ordinal)],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskStep = typeof taskSteps.$inferSelect;
export type NewTaskStep = typeof taskSteps.$inferInsert;


export type NewAnalysisJob = typeof analysisJobs.$inferInsert;
export type AIConversation = typeof aiConversations.$inferSelect;
export type NewAIConversation = typeof aiConversations.$inferInsert;
export type AIMessageRow = typeof aiMessages.$inferSelect;
export type NewAIMessage = typeof aiMessages.$inferInsert;
export type Dataset = typeof datasets.$inferSelect;
export type NewDataset = typeof datasets.$inferInsert;
export type AnalysisRun = typeof analysisRuns.$inferSelect;
export type NewAnalysisRun = typeof analysisRuns.$inferInsert;
export type AgentTask = typeof agentTasks.$inferSelect;
export type NewAgentTask = typeof agentTasks.$inferInsert;
