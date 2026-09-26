import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import { stepsForDocType } from '@/config/research';
import { sectionI18nKey } from '@/lib/sections';
import { SECTION_LABELS_EN } from '@/ai/context/labels';
import type { ResearchSection } from '@/server/db/schema';
import type { DocumentSection } from '@/server/generators/documents';
import { AppError } from '@/server/http/errors';
import { integrityAppendix, type AppendixAnalysis, type AppendixSection } from '@/server/integrity/appendix';
import { legacyResultTier, NUMERIC_GUARD_VERSION, type LegacyResultTier } from '@/server/integrity/numbers';
import * as analysisRunsRepo from '@/server/repositories/analysis-runs.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';
import * as referencesRepo from '@/server/repositories/references.repository';

import { getProjectWithSections } from './project.service';
import { personIntegrity } from './section.service';
import { resolvePlanForUser } from './subscription.service';
import { recordSimple } from './usage.service';

/**
 * Markdown in, Word out.
 *
 * The editor stores lightweight markdown, so export parses the handful of
 * constructs the assistant actually produces — ATX headings, bullets, numbered
 * items, blank-line paragraphs — rather than pulling in a full markdown engine
 * whose extra output would not survive the conversion anyway.
 */
function paragraphsFrom(markdown: string, rtl: boolean): Paragraph[] {
  const alignment = rtl ? AlignmentType.RIGHT : AlignmentType.LEFT;
  const output: Paragraph[] = [];

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd();

    if (!line.trim()) continue;

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      output.push(
        new Paragraph({
          text: stripInline(heading[2]!),
          heading:
            level === 1
              ? HeadingLevel.HEADING_2
              : level === 2
                ? HeadingLevel.HEADING_3
                : HeadingLevel.HEADING_4,
          bidirectional: rtl,
          alignment,
          spacing: { before: 240, after: 120 },
        }),
      );
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      output.push(
        new Paragraph({
          children: [new TextRun({ text: stripInline(bullet[1]!), rightToLeft: rtl })],
          bullet: { level: 0 },
          bidirectional: rtl,
          alignment,
          spacing: { after: 80 },
        }),
      );
      continue;
    }

    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      output.push(
        new Paragraph({
          children: [new TextRun({ text: stripInline(numbered[2]!), rightToLeft: rtl })],
          numbering: { reference: 'ordered', level: 0 },
          bidirectional: rtl,
          alignment,
          spacing: { after: 80 },
        }),
      );
      continue;
    }

    output.push(
      new Paragraph({
        children: [new TextRun({ text: stripInline(line), rightToLeft: rtl })],
        bidirectional: rtl,
        alignment,
        spacing: { after: 160, line: 360 },
      }),
    );
  }

  return output;
}

/** Word has no markdown emphasis syntax; the markers would render literally. */
function stripInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim();
}

function headingFor(
  key: string,
  labels: Record<string, string>,
): string {
  return labels[sectionI18nKey(key)] ?? SECTION_LABELS_EN[key as never] ?? key;
}

/**
 * The appendix's sections and analyses for a project export (WS2 B5, N7).
 *
 * Each exported section uses the record stored with its latest version when
 * that version is the text being exported; otherwise (text saved before the
 * records existed, or written without one) it is scanned in person mode now,
 * labelled "checked at export", and the result is not stored. Nothing is
 * rewritten, and nothing here can block the export or change an approval.
 *
 * The analyses are those attached anywhere in the project, then any a record
 * cites that is no longer attached, then any that no longer exists, each in
 * a fixed order, with its tier from its own row.
 */
async function appendixFor(input: {
  projectId: string;
  userId: string;
  sections: readonly ResearchSection[];
  label: (key: string) => string;
}): Promise<{ sections: AppendixSection[]; analyses: AppendixAnalysis[] }> {
  const latest = new Map((await projectsRepo.latestVersions(input.sections.map((section) => section.id))).map((version) => [version.sectionId, version]));

  const sections: AppendixSection[] = [];
  for (const section of input.sections) {
    const version = latest.get(section.id);
    const current = version && version.content === section.content ? version : undefined;
    sections.push({
      label: input.label(section.sectionKey),
      origin: current?.origin ?? null,
      approved: section.status === 'APPROVED',
      ...(current?.integrity
        ? { record: 'stored' as const, integrity: current.integrity }
        : { record: 'checked-at-export' as const, integrity: await personIntegrity(input.projectId, input.userId, section.sectionKey, section.content) }),
    });
  }

  const order = new Map(input.sections.map((section, index) => [section.sectionKey as string, index]));
  const byPosition = (a: { sectionKey: string | null; createdAt: Date; id: string }, b: { sectionKey: string | null; createdAt: Date; id: string }) =>
    (order.get(a.sectionKey ?? '') ?? order.size) - (order.get(b.sectionKey ?? '') ?? order.size) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id);

  const attached = (await analysisRunsRepo.listAttached(input.projectId, input.userId)).sort(byPosition);
  const known = new Set(attached.map((run) => run.id));

  /* Runs a record cites (used or excluded) that are no longer attached, with the tier the record gave them. */
  const cited = new Map<string, LegacyResultTier>();
  for (const { integrity } of sections) {
    for (const entry of [...integrity.sources, ...integrity.excluded]) if (!known.has(entry.id) && !cited.has(entry.id)) cited.set(entry.id, entry.tier);
  }
  const detached = [];
  const unavailable: [string, LegacyResultTier][] = [];
  for (const [id, tier] of [...cited].sort(([a], [b]) => a.localeCompare(b))) {
    const run = await analysisRunsRepo.findOwned(id, input.userId);
    if (run) detached.push(run);
    else unavailable.push([id, tier]);
  }

  const analyses: AppendixAnalysis[] = [...attached, ...detached.sort(byPosition)].map((run) => {
    const tier = legacyResultTier(run);
    return {
      reference: `run:${run.id.slice(0, 8)}`,
      analysis: run.testKey,
      section: run.sectionKey ? input.label(run.sectionKey) : null,
      tier,
      engine: run.engineVersion ?? null,
      datasetVersion: run.datasetVersionId ?? null,
      contentHash: run.datasetContentHash ?? null,
      status: tier === 'windowed' ? 'excluded' : 'used',
    };
  });
  for (const [id, tier] of unavailable) {
    analyses.push({ reference: `run:${id.slice(0, 8)}`, analysis: '—', section: null, tier, engine: null, datasetVersion: null, contentHash: null, status: 'unavailable' });
  }

  return { sections, analyses };
}

/** The appendix's blocks as Word paragraphs and tables, starting on a new page. */
function appendixBlocks(blocks: readonly DocumentSection[], rtl: boolean): (Paragraph | Table)[] {
  const alignment = rtl ? AlignmentType.RIGHT : AlignmentType.LEFT;
  const text = (value: string, bold = false) => new Paragraph({ children: [new TextRun({ text: value, bold, rightToLeft: rtl })], bidirectional: rtl, alignment });
  const output: (Paragraph | Table)[] = [];

  blocks.forEach((block, index) => {
    if (block.heading) {
      output.push(
        new Paragraph({
          text: block.heading,
          heading: block.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
          bidirectional: rtl,
          alignment,
          pageBreakBefore: index === 0,
          spacing: { before: 240, after: 120 },
        }),
      );
    }
    for (const paragraph of block.paragraphs ?? []) output.push(text(paragraph));
    if (block.table) {
      output.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          visuallyRightToLeft: rtl,
          rows: [
            new TableRow({ tableHeader: true, children: block.table.headers.map((header) => new TableCell({ children: [text(header, true)] })) }),
            ...block.table.rows.map((row) => new TableRow({ children: row.map((cell) => new TableCell({ children: [text(String(cell))] })) })),
          ],
        }),
        new Paragraph({ text: '' }),
      );
    }
  });

  return output;
}

export interface ExportInput {
  projectId: string;
  userId: string;
  /** Section headings already translated by the caller (which has the locale). */
  sectionLabels: Record<string, string>;
  referencesLabel: string;
  unverifiedLabel: string;
}

export async function exportProjectDocx(input: ExportInput): Promise<{
  buffer: Buffer;
  filename: string;
}> {
  const { plan } = await resolvePlanForUser(input.userId);
  if (plan.toolAccess?.export !== true) {
    throw AppError.planLimit('export', 0, 0);
  }

  const { project, sections } = await getProjectWithSections(input.projectId, input.userId);
  const references = await referencesRepo.listForProject(input.projectId);

  const rtl = project.language === 'AR';
  const order = stepsForDocType(project.docType);
  const ordered: ResearchSection[] = order
    .map((key) => sections.find((section) => section.sectionKey === key))
    .filter((section): section is ResearchSection => Boolean(section?.content.trim()));

  const children: (Paragraph | Table)[] = [
    new Paragraph({
      text: project.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      bidirectional: rtl,
      spacing: { after: 480 },
    }),
    ...ordered.flatMap((section) => [
      new Paragraph({
        text: headingFor(section.sectionKey, input.sectionLabels),
        heading: HeadingLevel.HEADING_1,
        bidirectional: rtl,
        alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
        spacing: { before: 360, after: 180 },
        pageBreakBefore: true,
      }),
      ...paragraphsFrom(section.content, rtl),
    ]),
  ];

  if (references.length > 0) {
    children.push(
      new Paragraph({
        text: input.referencesLabel,
        heading: HeadingLevel.HEADING_1,
        bidirectional: rtl,
        alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
        pageBreakBefore: true,
        spacing: { after: 180 },
      }),
      ...references.map(
        (reference) =>
          new Paragraph({
            children: [
              new TextRun({
                text: reference.formatted ?? reference.rawText,
                rightToLeft: rtl,
              }),
              ...(reference.verification === 'UNVERIFIED'
                ? [
                    new TextRun({
                      text: `  [${input.unverifiedLabel}]`,
                      italics: true,
                      color: '9A6412',
                      rightToLeft: rtl,
                    }),
                  ]
                : []),
            ],
            bidirectional: rtl,
            alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
            spacing: { after: 120 },
            indent: { hanging: 480 },
          }),
      ),
    );
  }

  /*
   * The Integrity and Provenance Appendix, always, after the references
   * (WS2 B5, N7): how each section's numbers were checked and which analyses
   * they could come from. Built from what is stored, or scanned now without
   * storing; the document's text above is exactly what was saved.
   */
  const appendix = await appendixFor({
    projectId: input.projectId,
    userId: input.userId,
    sections: ordered,
    label: (key) => headingFor(key, input.sectionLabels),
  });
  children.push(...appendixBlocks(integrityAppendix({ language: rtl ? 'ar' : 'en', guardVersion: NUMERIC_GUARD_VERSION, ...appendix }), rtl));

  const document = new Document({
    creator: 'Academic AI Research Assistant',
    title: project.title,
    numbering: {
      config: [
        {
          reference: 'ordered',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: rtl ? 'Traditional Arabic' : 'Times New Roman', size: 26 },
          paragraph: { spacing: { line: 360 } },
        },
      },
    },
    sections: [{ properties: {}, children }],
  });

  const buffer = await Packer.toBuffer(document);
  await recordSimple(input.userId, 'EXPORT', 1, input.projectId);

  const safeTitle = project.title.replace(/[^\p{Letter}\p{Number}\s-]/gu, '').slice(0, 60).trim();
  return { buffer, filename: `${safeTitle || 'research'}.docx` };
}
