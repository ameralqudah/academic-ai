import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';

import { stepsForDocType } from '@/config/research';
import { sectionI18nKey } from '@/lib/sections';
import { SECTION_LABELS_EN } from '@/ai/context/labels';
import type { ResearchSection } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as referencesRepo from '@/server/repositories/references.repository';

import { getProjectWithSections } from './project.service';
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

  const children: Paragraph[] = [
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
