/**
 * The Integrity and Provenance Appendix of a Word export (WS2 B5, N7).
 *
 * A reader of an exported document sees the text, not the checks behind it.
 * This appendix states them: how each section's research numbers were
 * checked, what was replaced or left untraced, and which analyses the numbers
 * could come from, with their tiers. It is always included, even when there
 * is nothing to report — "no untraced numbers" is itself a finding.
 *
 * Pure and deterministic: structured input in, document sections out, in a
 * fixed order, with no database, clock or model. The same input gives the
 * same text. The callers (the thesis export and a task's Word file) gather
 * the input; neither rewrites a word of the document to build it.
 *
 * Nothing is called "verified": only P1-C runs are, and none appears here.
 * Legacy results are pinned, unpinned or windowed (`legacyResultTier`); an
 * analysis is used, excluded (windowed) or no longer available.
 */

import type { DocumentSection } from '@/server/generators/documents';

import { QUARANTINE_MARKER, type LegacyResultTier } from './numbers';
import type { SectionIntegrity } from './section';

export type AppendixLanguage = 'ar' | 'en';

/** Where a section's record came from: stored with its version, or a person-mode scan at export (never stored). */
export type AppendixRecord = 'stored' | 'checked-at-export';

export interface AppendixSection {
  /** The section as it is headed in the document. */
  label: string;
  /** Who wrote the text being exported; null when not known. */
  origin: 'AI' | 'USER' | null;
  /** Null where approval does not apply (a task's text). */
  approved: boolean | null;
  record: AppendixRecord;
  integrity: SectionIntegrity;
}

export type AppendixAnalysisStatus = 'used' | 'excluded' | 'unavailable';

export interface AppendixAnalysis {
  /** A short, stable reference: "run:1a2b3c4d", or a task source "S1". */
  reference: string;
  /** What was computed: a test key or an analysis kind. */
  analysis: string;
  /** The section it is attached to, when there is one. */
  section: string | null;
  tier: LegacyResultTier | null;
  engine: string | null;
  datasetVersion: string | null;
  contentHash: string | null;
  status: AppendixAnalysisStatus;
}

/** WS3-D (D3): a claim the document references as `{{claim:id}}`, with what its graph records. */
export interface AppendixClaim {
  /** "claim:1a2b3c4d". */
  reference: string;
  /** The sections that reference it. */
  sections: readonly string[];
  status: 'current' | 'not_found' | 'not_a_claim' | 'not_current' | 'not_verified';
  /** Its stored text, only while current. */
  text: string | null;
  /** Keys of the result values it reports. */
  values: readonly string[];
  /** "run:1a2b3c4d" for each statistics run behind those values. */
  runs: readonly string[];
  engine: string | null;
  datasetVersions: readonly string[];
  contentHashes: readonly string[];
  /** The research run and step that wrote it (short ids), or null when a person did. */
  writtenBy: { run: string; step: string } | null;
}

export interface AppendixInput {
  language: AppendixLanguage;
  guardVersion: string;
  sections: readonly AppendixSection[];
  analyses: readonly AppendixAnalysis[];
  /** WS3-D (D3): the claims the document references; the block is shown only when there are some. */
  claims?: readonly AppendixClaim[];
  /** Text included in the document that no guard checked (a task's literature review, say). */
  notChecked?: readonly string[];
}

const WORDS = {
  en: {
    title: 'Integrity and provenance appendix',
    statement: (guard: string) => [
      `Research numbers in this document were checked by the numeric guard (version ${guard}) when each section was saved, or at export where no record was stored. Exporting never changes the text.`,
      `Numbers the AI wrote that traced to no analysis were replaced with the marker ${QUARANTINE_MARKER.en} (${QUARANTINE_MARKER.ar} in Arabic text). Numbers a researcher wrote, and text saved before these checks existed, are kept exactly as written; those that trace to no attached analysis are listed below.`,
      'Analyses were computed by the legacy analysis engine and have not been independently checked. A windowed analysis read only the first rows of a file; its numbers are excluded.',
    ],
    sections: 'Sections',
    sectionHeaders: ['Section', 'Written by', 'Approved', 'Check', 'Traced', 'Replaced by marker', 'Untraced (as written)', 'Record'],
    origin: { AI: 'AI', USER: 'Researcher', none: '—' },
    approved: { yes: 'Yes', no: 'No', none: '—' },
    mode: { model: 'Untraced numbers replaced', person: 'Listed, not changed' },
    record: { stored: 'stored with the section', 'checked-at-export': 'checked at export' },
    untraced: 'Untraced numbers',
    untracedIn: (label: string) => `${label}: numbers as written, not traced to an attached analysis`,
    noUntraced: 'No untraced numbers were found in text kept as written.',
    analyses: 'Analyses',
    analysisHeaders: ['Reference', 'Analysis', 'Section', 'Tier', 'Engine', 'Dataset version', 'Content hash', 'Status'],
    tier: { pinned: 'pinned', unpinned: 'unpinned', windowed: 'windowed', none: '—' },
    status: { used: 'used', excluded: 'excluded (windowed)', unavailable: 'no longer available' },
    noAnalyses: 'No analyses are attached to this document.',
    notChecked: 'Text not checked by the numeric guard',
    claims: 'Claims and traceability',
    claimsStatement: [
      'Claims are referenced in the text and shown there as recorded: their numbers were rendered from the statistics engine’s stored estimates when each claim was written, and are not recomputed at export.',
      `A referenced claim that is no longer current (replaced, resting on replaced or invalidated data, or not found) is not shown as evidence: the text shows the marker ${QUARANTINE_MARKER.en} in its place.`,
    ],
    claimHeaders: ['Reference', 'Sections', 'Claim', 'Status', 'Values', 'Statistics run', 'Engine', 'Dataset version', 'Content hash', 'Written by'],
    claimStatus: { current: 'current, verified', not_found: 'not found', not_a_claim: 'not a claim', not_current: 'not current', not_verified: 'not verified' },
    researcher: 'researcher',
    writtenBy: (run: string, step: string) => `research run ${run}, step ${step}`,
  },
  ar: {
    title: 'ملحق سلامة الأرقام ومصدرها',
    statement: (guard: string) => [
      `فُحصت الأرقام البحثية في هذا المستند بأداة فحص الأرقام (الإصدار ${guard}) عند حفظ كل قسم، أو عند التصدير إن لم يكن للقسم سجلّ محفوظ. التصدير لا يغيّر النص أبدًا.`,
      `الأرقام التي كتبها الذكاء الاصطناعي ولم تُنسب إلى تحليل استُبدلت بالعلامة ${QUARANTINE_MARKER.ar} (${QUARANTINE_MARKER.en} في النص الإنجليزي). أما الأرقام التي كتبها الباحث، والنصوص المحفوظة قبل وجود هذا الفحص، فتبقى كما كُتبت، وتُذكر أدناه تلك التي لا تُنسب إلى تحليل مرفق.`,
      'حُسبت التحليلات بمحرّك التحليل القديم ولم تُراجَع مراجعة مستقلة. التحليل المحدود قرأ الصفوف الأولى من الملف فقط، فأرقامه مستبعدة.',
    ],
    sections: 'الأقسام',
    sectionHeaders: ['القسم', 'الكاتب', 'معتمد', 'الفحص', 'منسوبة', 'استُبدلت بعلامة', 'غير منسوبة (كما كُتبت)', 'السجلّ'],
    origin: { AI: 'الذكاء الاصطناعي', USER: 'الباحث', none: '—' },
    approved: { yes: 'نعم', no: 'لا', none: '—' },
    mode: { model: 'استُبدلت الأرقام غير المنسوبة', person: 'تُذكر ولا تُغيَّر' },
    record: { stored: 'محفوظ مع القسم', 'checked-at-export': 'فُحص عند التصدير' },
    untraced: 'الأرقام غير المنسوبة',
    untracedIn: (label: string) => `${label}: أرقام كما كُتبت، غير منسوبة إلى تحليل مرفق`,
    noUntraced: 'لم يُعثر على أرقام غير منسوبة في النص المحفوظ كما كُتب.',
    analyses: 'التحليلات',
    analysisHeaders: ['المرجع', 'التحليل', 'القسم', 'الفئة', 'المحرّك', 'نسخة البيانات', 'بصمة المحتوى', 'الحالة'],
    tier: { pinned: 'مثبّت', unpinned: 'غير مثبّت', windowed: 'محدود', none: '—' },
    status: { used: 'مستخدم', excluded: 'مستبعد (محدود)', unavailable: 'لم يعد متاحًا' },
    noAnalyses: 'لا توجد تحليلات مرفقة بهذا المستند.',
    notChecked: 'نص لم تفحصه أداة فحص الأرقام',
    claims: 'الادعاءات وإمكانية تتبّعها',
    claimsStatement: [
      'يُشار إلى الادعاءات في النص وتُعرض فيه كما سُجّلت: صيغت أرقامها من تقديرات محرّك الإحصاء المحفوظة عند كتابة كل ادعاء، ولا يُعاد حسابها عند التصدير.',
      `الادعاء المشار إليه الذي لم يعد حاليًا (استُبدل، أو يعتمد على بيانات مستبدلة أو ملغاة، أو لم يُعثر عليه) لا يُعرض دليلًا: يظهر في النص بدله الرمز ${QUARANTINE_MARKER.ar}.`,
    ],
    claimHeaders: ['المرجع', 'الأقسام', 'الادعاء', 'الحالة', 'القيم', 'تشغيل الإحصاء', 'المحرّك', 'نسخة البيانات', 'بصمة المحتوى', 'الكاتب'],
    claimStatus: { current: 'حالي، موثَّق', not_found: 'غير موجود', not_a_claim: 'ليس ادعاءً', not_current: 'غير حالي', not_verified: 'غير موثَّق' },
    researcher: 'الباحث',
    writtenBy: (run: string, step: string) => `تشغيل بحثي ${run}، الخطوة ${step}`,
  },
} as const;

/** A shortened content hash: enough to match a file, short enough for a table cell. */
function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 12) : '—';
}

/** The appendix as document sections: statement, sections, untraced numbers, analyses, unchecked text. */
export function integrityAppendix(input: AppendixInput): DocumentSection[] {
  const words = WORDS[input.language];
  const blocks: DocumentSection[] = [
    { heading: words.title, level: 1, paragraphs: [...words.statement(input.guardVersion)] },
    {
      heading: words.sections,
      level: 2,
      table: {
        headers: [...words.sectionHeaders],
        rows: input.sections.map((section) => [
          section.label,
          section.origin ? words.origin[section.origin] : words.origin.none,
          section.approved === null ? words.approved.none : section.approved ? words.approved.yes : words.approved.no,
          words.mode[section.integrity.mode],
          section.integrity.traced,
          section.integrity.quarantined,
          section.integrity.manual,
          words.record[section.record],
        ]),
      },
    },
  ];

  /*
   * The numbers a researcher wrote that trace to nothing, as written. An AI
   * section's quarantined numbers are counted above and never repeated here:
   * listing them would put back the very values the marker replaced.
   */
  const untraced = input.sections.filter((section) => section.integrity.mode === 'person' && section.integrity.findings.length > 0);
  blocks.push({ heading: words.untraced, level: 2, ...(untraced.length ? {} : { paragraphs: [words.noUntraced] }) });
  for (const section of untraced) {
    blocks.push({ level: 3, paragraphs: [words.untracedIn(section.label), ...section.integrity.findings.map((found) => `• ${found.text}`)] });
  }

  blocks.push(
    input.analyses.length
      ? {
          heading: words.analyses,
          level: 2,
          table: {
            headers: [...words.analysisHeaders],
            rows: input.analyses.map((analysis) => [
              analysis.reference,
              analysis.analysis,
              analysis.section ?? '—',
              analysis.tier ? words.tier[analysis.tier] : words.tier.none,
              analysis.engine ?? '—',
              analysis.datasetVersion ?? '—',
              shortHash(analysis.contentHash),
              words.status[analysis.status],
            ]),
          },
        }
      : { heading: words.analyses, level: 2, paragraphs: [words.noAnalyses] },
  );

  /* WS3-D (D3): only when the document references claims, so a document without any is unchanged. */
  if (input.claims?.length) {
    const list = (items: readonly string[], short = false) => (items.length ? items.map((item) => (short ? shortHash(item) : item)).join(', ') : '—');
    blocks.push({
      heading: words.claims,
      level: 2,
      paragraphs: [...words.claimsStatement],
      table: {
        headers: [...words.claimHeaders],
        rows: input.claims.map((claim) => [
          claim.reference,
          list(claim.sections),
          claim.text ?? '—',
          words.claimStatus[claim.status],
          list(claim.values),
          list(claim.runs),
          claim.engine ?? '—',
          list(claim.datasetVersions),
          list(claim.contentHashes, true),
          claim.writtenBy ? words.writtenBy(claim.writtenBy.run, claim.writtenBy.step) : words.researcher,
        ]),
      },
    });
  }

  if (input.notChecked?.length) {
    blocks.push({ heading: words.notChecked, level: 2, paragraphs: input.notChecked.map((label) => `• ${label}`) });
  }

  return blocks;
}
