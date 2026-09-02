import { z } from 'zod';

import { generateCsv, generateMarkdown, generatePdf, generatePptx } from '@/server/generators/documents';
import { toBibTeX, toRIS } from '@/server/generators/bibliography';
import { formatReferenceList, type StyleId } from '@/server/citation/styles';
import { ok, withApi } from '@/server/http/api';
import { listArtifacts, storeArtifact } from '@/server/services/artifact.service';

/**
 * Generating a document.
 *
 * One route for every format, because the pipeline is the same for all of them
 * — generate, validate, check, version, store — and splitting it per format
 * would mean five copies of that sequence drifting apart.
 */
const sectionSchema = z.object({
  heading: z.string().max(300).optional(),
  level: z.number().int().min(1).max(6).optional(),
  paragraphs: z.array(z.string().max(20000)).max(200).optional(),
  table: z
    .object({
      headers: z.array(z.string().max(200)).max(20),
      rows: z.array(z.array(z.union([z.string().max(500), z.number()])).max(20)).max(500),
    })
    .optional(),
});

const referenceSchema = z.object({
  id: z.string().max(64),
  kind: z
    .enum([
      'journal-article', 'book', 'book-chapter', 'conference-paper', 'report',
      'thesis', 'website', 'dataset', 'preprint', 'unknown',
    ])
    .default('unknown'),
  title: z.string().max(600).optional(),
  authors: z.array(z.string().max(200)).max(60).optional(),
  year: z.number().int().optional(),
  container: z.string().max(400).optional(),
  publisher: z.string().max(300).optional(),
  doi: z.string().max(200).optional(),
  isbn: z.string().max(40).optional(),
  url: z.string().max(1000).optional(),
  pages: z.string().max(40).optional(),
  volume: z.string().max(40).optional(),
  issue: z.string().max(40).optional(),
  provenance: z.enum(['retrieved', 'user-provided', 'generated']).optional(),
});

const schema = z.object({
  kind: z.enum(['pdf', 'pptx', 'csv', 'md', 'bib', 'ris']),
  filename: z.string().min(1).max(200),
  title: z.string().max(500).default(''),
  subtitle: z.string().max(500).optional(),
  author: z.string().max(200).optional(),
  sections: z.array(sectionSchema).max(200).default([]),
  references: z.array(referenceSchema).max(500).default([]),
  citationStyle: z.enum(['apa', 'ieee', 'harvard', 'chicago', 'mla']).default('apa'),
  slides: z
    .array(
      z.object({
        title: z.string().max(300),
        bullets: z.array(z.string().max(500)).max(20).optional(),
        notes: z.string().max(3000).optional(),
      }),
    )
    .max(100)
    .optional(),
  csv: z
    .object({
      headers: z.array(z.string().max(200)).max(100),
      rows: z.array(z.array(z.union([z.string().max(2000), z.number(), z.null()])).max(100)).max(10000),
    })
    .optional(),
  projectId: z.string().optional(),
  conversationId: z.string().optional(),
  /** Present when replacing an earlier version rather than starting a lineage. */
  previousArtifactId: z.string().optional(),
  rtl: z.boolean().default(false),
});

type Body = z.infer<typeof schema>;

export const POST = withApi<Body>(
  { schema, rateLimit: { max: 30, windowSeconds: 300, key: 'artifact.generate' } },
  async ({ user, body }) => {
    const formatted = formatReferenceList(body.references as never, body.citationStyle as StyleId);

    const content = {
      title: body.title,
      subtitle: body.subtitle,
      author: body.author,
      sections: body.sections,
      references: formatted.map((entry) => entry.formatted),
    };

    let bytes: Uint8Array;
    let unsupported: string[] = [];

    if (body.kind === 'pdf') {
      const result = await generatePdf(content);
      bytes = result.bytes;
      unsupported = result.unsupportedText;
    } else if (body.kind === 'pptx') {
      bytes = await generatePptx(body.title, body.slides ?? [], {
        subtitle: body.subtitle,
        rtl: body.rtl,
      });
    } else if (body.kind === 'csv') {
      bytes = generateCsv(body.csv?.headers ?? [], body.csv?.rows ?? []);
    } else if (body.kind === 'md') {
      bytes = generateMarkdown(content);
    } else if (body.kind === 'bib') {
      bytes = new TextEncoder().encode(toBibTeX(body.references as never));
    } else {
      bytes = new TextEncoder().encode(toRIS(body.references as never));
    }

    /* Prose is checked; a spreadsheet or bibliography has none to check. */
    const proseText =
      body.kind === 'csv' || body.kind === 'bib' || body.kind === 'ris'
        ? null
        : body.sections
            .flatMap((section) => [section.heading ?? '', ...(section.paragraphs ?? [])])
            .join('\n\n');

    const artifact = await storeArtifact({
      userId: user.id,
      kind: body.kind,
      filename: body.filename,
      bytes,
      projectId: body.projectId ?? null,
      conversationId: body.conversationId ?? null,
      previousArtifactId: body.previousArtifactId,
      metadata: {
        citationStyle: body.citationStyle,
        sections: body.sections.length,
        references: body.references.length,
        /*
         * Recorded rather than discarded: a PDF whose Arabic could not be drawn
         * is a document the researcher must be told about, and the metadata is
         * where the interface reads that from.
         */
        ...(unsupported.length > 0 ? { unsupportedText: unsupported.length } : {}),
      },
      ...(proseText
        ? { quality: { text: proseText, references: body.references as never } }
        : {}),
    });

    return ok({ artifact, ...(unsupported.length > 0 ? { unsupportedText: unsupported } : {}) });
  },
);

export const GET = withApi({}, async ({ user }) => ok({ artifacts: await listArtifacts(user.id) }));
