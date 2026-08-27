/**
 * The academic vocabulary of the product, in one place.
 *
 * Every wizard step, thesis chapter, proposal part and AI tool is declared here.
 * Adding one is a change to this file plus a translation key — no migration,
 * no route, no schema change.
 */

export const SECTION_KEYS = [
  // Core research wizard — the 13 steps
  'TITLE',
  'PROBLEM',
  'QUESTIONS',
  'OBJECTIVES',
  'HYPOTHESES',
  'LITERATURE_REVIEW',
  'METHODOLOGY',
  'DATA_ANALYSIS_PLAN',
  'RESULTS',
  'DISCUSSION',
  'CONCLUSION',
  'RECOMMENDATIONS',
  'REFERENCES',
  // Proposal-only parts
  'INTRODUCTION',
  'BACKGROUND',
  'SIGNIFICANCE',
  'EXPECTED_RESULTS',
  'TIMELINE',
  // Thesis chapters
  'CHAPTER_1',
  'CHAPTER_2',
  'CHAPTER_3',
  'CHAPTER_4',
  'CHAPTER_5',
  'CHAPTER_6',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export interface SectionDefinition {
  key: SectionKey;
  order: number;
  /** i18n key under `sections.*` */
  i18nKey: string;
  /** Rough target length used for AI prompts and progress hints. */
  targetWords: number;
  /** Sections the AI must see to keep the document internally consistent. */
  dependsOn: SectionKey[];
  /** True when the section cannot be written from the brief alone (needs user data). */
  requiresUserData?: boolean;
}

export const WIZARD_STEPS: SectionDefinition[] = [
  { key: 'TITLE', order: 1, i18nKey: 'title', targetWords: 40, dependsOn: [] },
  { key: 'PROBLEM', order: 2, i18nKey: 'problem', targetWords: 450, dependsOn: ['TITLE'] },
  { key: 'QUESTIONS', order: 3, i18nKey: 'questions', targetWords: 200, dependsOn: ['TITLE', 'PROBLEM'] },
  {
    key: 'OBJECTIVES',
    order: 4,
    i18nKey: 'objectives',
    targetWords: 200,
    dependsOn: ['PROBLEM', 'QUESTIONS'],
  },
  {
    key: 'HYPOTHESES',
    order: 5,
    i18nKey: 'hypotheses',
    targetWords: 220,
    dependsOn: ['QUESTIONS', 'OBJECTIVES'],
  },
  {
    key: 'LITERATURE_REVIEW',
    order: 6,
    i18nKey: 'literatureReview',
    targetWords: 1200,
    dependsOn: ['TITLE', 'PROBLEM', 'QUESTIONS'],
  },
  {
    key: 'METHODOLOGY',
    order: 7,
    i18nKey: 'methodology',
    targetWords: 900,
    dependsOn: ['PROBLEM', 'QUESTIONS', 'OBJECTIVES', 'HYPOTHESES'],
  },
  {
    key: 'DATA_ANALYSIS_PLAN',
    order: 8,
    i18nKey: 'dataAnalysisPlan',
    targetWords: 500,
    dependsOn: ['METHODOLOGY', 'HYPOTHESES'],
  },
  {
    key: 'RESULTS',
    order: 9,
    i18nKey: 'results',
    targetWords: 800,
    dependsOn: ['QUESTIONS', 'HYPOTHESES', 'DATA_ANALYSIS_PLAN'],
    requiresUserData: true,
  },
  {
    key: 'DISCUSSION',
    order: 10,
    i18nKey: 'discussion',
    targetWords: 900,
    dependsOn: ['RESULTS', 'LITERATURE_REVIEW', 'QUESTIONS'],
    requiresUserData: true,
  },
  {
    key: 'CONCLUSION',
    order: 11,
    i18nKey: 'conclusion',
    targetWords: 400,
    dependsOn: ['PROBLEM', 'OBJECTIVES', 'RESULTS'],
  },
  {
    key: 'RECOMMENDATIONS',
    order: 12,
    i18nKey: 'recommendations',
    targetWords: 350,
    dependsOn: ['CONCLUSION', 'RESULTS'],
  },
  { key: 'REFERENCES', order: 13, i18nKey: 'references', targetWords: 0, dependsOn: [] },
];

export const PROPOSAL_SECTIONS: SectionKey[] = [
  'TITLE',
  'INTRODUCTION',
  'BACKGROUND',
  'PROBLEM',
  'QUESTIONS',
  'OBJECTIVES',
  'HYPOTHESES',
  'SIGNIFICANCE',
  'LITERATURE_REVIEW',
  'METHODOLOGY',
  'EXPECTED_RESULTS',
  'TIMELINE',
  'REFERENCES',
];

export const THESIS_CHAPTERS: { key: SectionKey; order: number; i18nKey: string }[] = [
  { key: 'CHAPTER_1', order: 1, i18nKey: 'chapter1' },
  { key: 'CHAPTER_2', order: 2, i18nKey: 'chapter2' },
  { key: 'CHAPTER_3', order: 3, i18nKey: 'chapter3' },
  { key: 'CHAPTER_4', order: 4, i18nKey: 'chapter4' },
  { key: 'CHAPTER_5', order: 5, i18nKey: 'chapter5' },
  { key: 'CHAPTER_6', order: 6, i18nKey: 'chapter6' },
];

export const SECTION_BY_KEY: Record<string, SectionDefinition | undefined> = Object.fromEntries(
  WIZARD_STEPS.map((step) => [step.key, step]),
);

/**
 * The ordered steps a given document type walks through. A paper walks the 13
 * research steps, a proposal its own 13 parts, a thesis its 6 chapters — one
 * wizard, three shapes.
 */
export function stepsForDocType(docType: 'PAPER' | 'PROPOSAL' | 'THESIS'): SectionKey[] {
  if (docType === 'PROPOSAL') return PROPOSAL_SECTIONS;
  if (docType === 'THESIS') return THESIS_CHAPTERS.map((chapter) => chapter.key);
  return WIZARD_STEPS.map((step) => step.key);
}

export function isSectionKey(value: string): value is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/*                                  AI tools                                  */
/* -------------------------------------------------------------------------- */

export const TOOL_KEYS = [
  'rewriter',
  'summarizer',
  'questionGenerator',
  'hypothesisGenerator',
  'gapFinder',
  'methodologyAssistant',
  'translator',
  'citationAssistant',
] as const;

export type ToolKey = (typeof TOOL_KEYS)[number];

export interface ToolDefinition {
  key: ToolKey;
  icon: string;
  /** Free-plan users may run tools flagged `free`. Everything else needs Pro. */
  free: boolean;
  /** Extra select inputs rendered above the textarea. */
  options?: { name: string; values: string[] }[];
}

export const TOOLS: ToolDefinition[] = [
  {
    key: 'rewriter',
    icon: 'pen-line',
    free: true,
    options: [
      {
        name: 'style',
        values: ['moreAcademic', 'moreNatural', 'simpleAcademic', 'formalAcademic'],
      },
    ],
  },
  { key: 'summarizer', icon: 'align-left', free: false },
  { key: 'questionGenerator', icon: 'help-circle', free: false },
  { key: 'hypothesisGenerator', icon: 'flask-conical', free: false },
  { key: 'gapFinder', icon: 'search', free: false },
  { key: 'methodologyAssistant', icon: 'compass', free: false },
  {
    key: 'translator',
    icon: 'languages',
    free: false,
    options: [{ name: 'direction', values: ['arToEn', 'enToAr'] }],
  },
  {
    key: 'citationAssistant',
    icon: 'quote',
    free: false,
    options: [{ name: 'style', values: ['APA7', 'HARVARD', 'MLA', 'CHICAGO'] }],
  },
];

/* -------------------------------------------------------------------------- */
/*                             Project form options                           */
/* -------------------------------------------------------------------------- */

export const DEGREES = ['BACHELOR', 'MASTER', 'PHD', 'PAPER'] as const;
export const PROJECT_LANGUAGES = ['AR', 'EN'] as const;
export const RESEARCH_TYPES = [
  'QUANTITATIVE',
  'QUALITATIVE',
  'MIXED_METHODS',
  'REVIEW_PAPER',
  'EXPERIMENTAL',
] as const;
export const DOC_TYPES = ['PAPER', 'PROPOSAL', 'THESIS'] as const;
export const CITATION_STYLES = ['APA7', 'HARVARD', 'MLA', 'CHICAGO'] as const;

export const ACADEMIC_FIELDS = [
  'educationalSciences',
  'socialSciences',
  'humanities',
  'businessAdministration',
  'economics',
  'law',
  'computerScience',
  'engineering',
  'medicalSciences',
  'nursing',
  'pharmacy',
  'naturalSciences',
  'agriculture',
  'islamicStudies',
  'arabicLanguage',
  'psychology',
  'mediaAndCommunication',
  'other',
] as const;

export type AcademicField = (typeof ACADEMIC_FIELDS)[number];
