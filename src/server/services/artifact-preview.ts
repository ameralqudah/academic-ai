/**
 * The readable copy of a document, kept beside the file.
 *
 * A generated document is stored as bytes — a .docx, a .pdf — and the chat
 * could only offer it as a download: to see what had been written, a researcher
 * had to save a file and open another program. The text that went into the file
 * exists at the moment it is stored, so a copy is kept in the artifact's
 * metadata and the side panel reads that.
 *
 * Pure, and separate from the service, because the service reaches storage and
 * the database and a test of "is this text cut at the limit" needs neither.
 */

/** Generous for a chapter, and a bound on what one row's metadata can hold. */
export const PREVIEW_LIMIT = 60_000;

/** Kinds whose content is prose, and so can be shown as text. */
export const PREVIEWABLE_KINDS = ['docx', 'pdf', 'md', 'txt', 'pptx'] as const;

export function isPreviewable(kind: string): boolean {
  return (PREVIEWABLE_KINDS as readonly string[]).includes(kind);
}

export interface StoredPreview {
  preview: string;
  previewTruncated: boolean;
}

/**
 * Cuts at a paragraph boundary when there is one nearby, so the preview ends on
 * a whole sentence rather than mid-word — and says that it was cut.
 */
export function toStoredPreview(markdown: string): StoredPreview | null {
  const text = markdown.trim();
  if (!text) return null;

  if (text.length <= PREVIEW_LIMIT) return { preview: text, previewTruncated: false };

  const slice = text.slice(0, PREVIEW_LIMIT);
  const boundary = slice.lastIndexOf('\n\n');

  return {
    preview: boundary > PREVIEW_LIMIT * 0.8 ? slice.slice(0, boundary) : slice,
    previewTruncated: true,
  };
}

/**
 * Metadata without the preview, for lists.
 *
 * The preview is up to sixty thousand characters; a list of forty artifacts
 * that each carried theirs would be megabytes sent to draw a column of names.
 */
export function withoutPreview<T extends { metadata: Record<string, unknown> }>(row: T): T {
  const { preview: _preview, previewTruncated: _truncated, ...rest } = row.metadata;
  return { ...row, metadata: { ...rest, hasPreview: typeof _preview === 'string' } };
}
