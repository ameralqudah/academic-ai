import type { SectionKey } from '@/config/research';

/**
 * English labels used inside prompts. Deliberately separate from the UI
 * translations: the model always reads a stable English section name, whatever
 * language the interface or the document is in.
 */
export const SECTION_LABELS_EN: Record<SectionKey, string> = {
  TITLE: 'Research title',
  PROBLEM: 'Research problem',
  QUESTIONS: 'Research questions',
  OBJECTIVES: 'Research objectives',
  HYPOTHESES: 'Research hypotheses',
  LITERATURE_REVIEW: 'Literature review',
  METHODOLOGY: 'Research methodology',
  DATA_ANALYSIS_PLAN: 'Data analysis plan',
  RESULTS: 'Results',
  DISCUSSION: 'Discussion',
  CONCLUSION: 'Conclusion',
  RECOMMENDATIONS: 'Recommendations',
  REFERENCES: 'References',
  INTRODUCTION: 'Introduction',
  BACKGROUND: 'Background of the study',
  SIGNIFICANCE: 'Significance of the study',
  EXPECTED_RESULTS: 'Expected results',
  TIMELINE: 'Timeline',
  CHAPTER_1: 'Chapter 1 — Introduction',
  CHAPTER_2: 'Chapter 2 — Literature review',
  CHAPTER_3: 'Chapter 3 — Methodology',
  CHAPTER_4: 'Chapter 4 — Results',
  CHAPTER_5: 'Chapter 5 — Discussion',
  CHAPTER_6: 'Chapter 6 — Conclusion and recommendations',
};

export function labelFor(key: SectionKey): string {
  return SECTION_LABELS_EN[key] ?? key;
}
