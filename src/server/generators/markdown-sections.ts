import type { DocumentSection } from '@/server/generators/documents';

/**
 * Written text, divided where its own headings divide it.
 *
 * A writing step asked for a whole paper returns one string with Markdown
 * headings in it. The generators take sections and paragraphs and know nothing
 * of Markdown, so the Word file opened with "## Abstract" typed out as a line of
 * body text, pound signs and all.
 *
 * Only structure is interpreted: headings become sections and everything else
 * is left as the paragraph it was, emphasis marks included. This is not a Markdown renderer and should not grow into one.
 */
export function sectionsFromMarkdown(
  text: string,
  fallbackHeading = '',
): { title: string | null; sections: DocumentSection[] } {
  const sections: DocumentSection[] = [];
  let title: string | null = null;
  let current: DocumentSection = { heading: fallbackHeading, level: 1, paragraphs: [] };
  let paragraph: string[] = [];

  /* Emphasis is left in: the generators honour `*italic*` and `**bold**` themselves. */
  const plain = (line: string) => line.trim();

  const endParagraph = () => {
    if (paragraph.length > 0) current.paragraphs?.push(paragraph.join(' '));
    paragraph = [];
  };

  const endSection = () => {
    endParagraph();
    if (current.heading || (current.paragraphs?.length ?? 0) > 0) sections.push(current);
  };

  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line.trim());

    if (heading) {
      const depth = (heading[1] as string).length;
      const words = plain(heading[2] as string);

      /* The first top-level heading of a paper is its title, not a chapter called by it. */
      if (depth === 1 && title === null && sections.length === 0 && !current.paragraphs?.length) {
        endParagraph();
        title = words;
        continue;
      }

      endSection();
      current = { heading: words, level: Math.max(1, depth - 1), paragraphs: [] };
      continue;
    }

    if (line.trim() === '') {
      endParagraph();
      continue;
    }

    /* A list item or a table row stands as its own paragraph rather than running into the next. */
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || line.trim().startsWith('|')) {
      endParagraph();
      current.paragraphs?.push(plain(line.replace(/^\s*[-*+]\s+/, '• ')));
      continue;
    }

    paragraph.push(plain(line));
  }

  endSection();

  return { title, sections };
}
