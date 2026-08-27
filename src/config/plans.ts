/**
 * Seed values for subscription plans.
 *
 * This file is the *initial* state of the `subscription_plans` table, not the
 * runtime source of truth. Once seeded, every limit is read from the database and
 * editable from the admin dashboard. Application code must never import these
 * numbers — it reads the user's plan instead.
 */

import type { ToolKey } from './research';

export const UNLIMITED = -1;

export interface PlanSeed {
  code: 'FREE' | 'PRO';
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  priceCents: number;
  currency: string;
  billingInterval: 'month' | 'year';
  maxProjects: number;
  maxAiRequests: number;
  maxGeneratedWords: number;
  maxExports: number;
  toolAccess: Record<ToolKey | 'editor' | 'thesis' | 'proposal' | 'export' | 'titles', boolean>;
  sortOrder: number;
  isDefault: boolean;
  features: { key: string; labelEn: string; labelAr: string; enabled: boolean }[];
}

export const PLAN_SEEDS: PlanSeed[] = [
  {
    code: 'FREE',
    nameEn: 'Free',
    nameAr: 'المجانية',
    descriptionEn: 'Try the platform on a single research project.',
    descriptionAr: 'جرّب المنصة على مشروع بحثي واحد.',
    priceCents: 0,
    currency: 'USD',
    billingInterval: 'month',
    maxProjects: 1,
    maxAiRequests: 20,
    maxGeneratedWords: 5000,
    maxExports: 0,
    toolAccess: {
      titles: true,
      editor: false,
      thesis: false,
      proposal: false,
      export: false,
      rewriter: true,
      summarizer: false,
      questionGenerator: false,
      hypothesisGenerator: false,
      gapFinder: false,
      methodologyAssistant: false,
      translator: false,
      citationAssistant: false,
    },
    sortOrder: 0,
    isDefault: true,
    features: [
      { key: 'projects', labelEn: '1 research project', labelAr: 'مشروع بحثي واحد', enabled: true },
      {
        key: 'aiRequests',
        labelEn: '20 AI requests per month',
        labelAr: '20 طلب ذكاء اصطناعي شهريًا',
        enabled: true,
      },
      {
        key: 'words',
        labelEn: '5,000 generated words per month',
        labelAr: '5,000 كلمة مولَّدة شهريًا',
        enabled: true,
      },
      {
        key: 'titles',
        labelEn: 'Research title generator',
        labelAr: 'مولّد عناوين البحث',
        enabled: true,
      },
      {
        key: 'editor',
        labelEn: 'Academic writing editor',
        labelAr: 'محرر الكتابة الأكاديمية',
        enabled: false,
      },
      {
        key: 'thesis',
        labelEn: 'Thesis & proposal assistants',
        labelAr: 'مساعد الرسائل والمقترحات',
        enabled: false,
      },
      { key: 'export', labelEn: 'Export to DOCX / PDF', labelAr: 'التصدير DOCX / PDF', enabled: false },
    ],
  },
  {
    code: 'PRO',
    nameEn: 'Pro',
    nameAr: 'الاحترافية',
    descriptionEn: 'Everything you need to finish a thesis.',
    descriptionAr: 'كل ما تحتاجه لإنجاز رسالتك الجامعية.',
    priceCents: 1500,
    currency: 'USD',
    billingInterval: 'month',
    maxProjects: 25,
    maxAiRequests: 1000,
    maxGeneratedWords: 150000,
    maxExports: 200,
    toolAccess: {
      titles: true,
      editor: true,
      thesis: true,
      proposal: true,
      export: true,
      rewriter: true,
      summarizer: true,
      questionGenerator: true,
      hypothesisGenerator: true,
      gapFinder: true,
      methodologyAssistant: true,
      translator: true,
      citationAssistant: true,
    },
    sortOrder: 1,
    isDefault: false,
    features: [
      { key: 'projects', labelEn: '25 research projects', labelAr: '25 مشروعًا بحثيًا', enabled: true },
      {
        key: 'aiRequests',
        labelEn: '1,000 AI requests per month',
        labelAr: '1,000 طلب ذكاء اصطناعي شهريًا',
        enabled: true,
      },
      {
        key: 'words',
        labelEn: '150,000 generated words per month',
        labelAr: '150,000 كلمة مولَّدة شهريًا',
        enabled: true,
      },
      {
        key: 'editor',
        labelEn: 'Academic writing editor',
        labelAr: 'محرر الكتابة الأكاديمية',
        enabled: true,
      },
      {
        key: 'thesis',
        labelEn: 'Thesis & proposal assistants',
        labelAr: 'مساعد الرسائل والمقترحات',
        enabled: true,
      },
      {
        key: 'tools',
        labelEn: 'All 8 advanced research tools',
        labelAr: 'الأدوات البحثية المتقدمة الثماني',
        enabled: true,
      },
      { key: 'export', labelEn: 'Export to DOCX / PDF', labelAr: 'التصدير DOCX / PDF', enabled: true },
    ],
  },
];
