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
    projectId: text('project_id').references(() => researchProjects.id, { onDelete: 'cascade' }),
    title: text('title'),
    scope: conversationScopeEnum('scope').default('PROJECT').notNull(),
    sectionKey: varchar('section_key', { length: 64 }).$type<SectionKey | null>(),
    toolKey: varchar('tool_key', { length: 64 }).$type<ToolKey | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('ai_conversations_project_idx').on(table.projectId, table.updatedAt),
    index('ai_conversations_user_idx').on(table.userId),
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
    createdAt: createdAt(),
  },
  (table) => [index('ai_messages_conversation_idx').on(table.conversationId, table.createdAt)],
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
export type AIConversation = typeof aiConversations.$inferSelect;
export type AIMessageRow = typeof aiMessages.$inferSelect;
