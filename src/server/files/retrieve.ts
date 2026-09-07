import { filterByRelevance } from '@/server/knowledge/relevance';

import type { ExtractedDocument } from './extract';

/**
 * Finding the part of a document that answers a question.
 *
 * A researcher asks "what sample size did the study I uploaded use?" and the
 * answer is one sentence in a forty-page paper. Sending the whole paper costs
 * a fortune per call and buries the sentence; sending nothing means the
 * question cannot be answered at all.
 *
 * **Lexical retrieval, not embeddings.** Deliberate, and worth stating: an
 * embedding index would need a model call per chunk, a vector store, and a
 * reindex on every change — against a matching problem that the canonicalising
 * relevance filter built for search already solves for most questions, and
 * solves in a way that can be read and corrected.
 *
 * The shape here takes a query and returns passages. An embedding retriever
 * would satisfy the same shape, so adding one later replaces this function
 * rather than the design around it.
 */

export interface Chunk {
  id: string;
  /** The heading this text sat under, where the document had one. */
  heading: string;
  text: string;
  /** Position in the document, so results can be returned in reading order. */
  ordinal: number;
}

/**
 * How much text a chunk holds, in characters.
 *
 * Large enough to carry a complete thought — a method described across three
 * sentences is useless split in half — and small enough that several fit in a
 * context budget alongside everything else the call needs.
 */
const CHUNK_CHARS = 1200;

/**
 * A document as retrievable passages.
 *
 * Chunked within sections rather than across them: a boundary between the
 * methods and the results is a real boundary, and a chunk spanning it answers
 * questions about neither.
 */
export function chunkDocument(document: ExtractedDocument): Chunk[] {
  const chunks: Chunk[] = [];
  let ordinal = 0;

  for (const section of document.sections) {
    let buffer = '';

    const flush = () => {
      const text = buffer.trim();
      if (text.length === 0) return;

      chunks.push({
        id: `chunk-${ordinal}`,
        heading: section.heading,
        /*
         * The heading travels inside the text, not only beside it. A passage
         * that begins "Participants were recruited from three universities"
         * is far more useful to a model when it knows that sits under
         * "Methods" — and putting it in the text means retrieval matches on it
         * too.
         */
        text: section.heading ? `${section.heading}\n${text}` : text,
        ordinal,
      });

      ordinal += 1;
      buffer = '';
    };

    for (const paragraph of section.paragraphs) {
      /*
       * A paragraph longer than a chunk is split rather than truncated. Long
       * paragraphs are common in academic writing and dropping their tails
       * would lose exactly the detail a question tends to ask about.
       */
      if (paragraph.length > CHUNK_CHARS) {
        flush();

        for (let start = 0; start < paragraph.length; start += CHUNK_CHARS) {
          buffer = paragraph.slice(start, start + CHUNK_CHARS);
          flush();
        }

        continue;
      }

      if (buffer.length + paragraph.length > CHUNK_CHARS) flush();

      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    }

    flush();
  }

  return chunks;
}

export interface RetrievedPassage {
  heading: string;
  text: string;
  ordinal: number;
}

/**
 * The passages that bear on a question.
 *
 * Reuses the search relevance filter, which already canonicalises across
 * Arabic and English and requires a two-word query to appear as a phrase — the
 * same judgement that stopped "hybrid learning" from matching papers about
 * hybrid machine learning. A document search has the identical failure mode.
 *
 * Returned in reading order rather than by score: a researcher reading three
 * passages from one paper expects them in the order the paper puts them, and
 * ranking is for choosing which three, not for presenting them.
 */
export function retrievePassages(
  chunks: Chunk[],
  question: string,
  limit = 4,
): RetrievedPassage[] {
  if (chunks.length === 0) return [];

  /*
   * A short document is returned whole. Retrieval over five chunks is a
   * needless chance to return the wrong one, and five chunks fit a budget.
   */
  if (chunks.length <= limit) {
    return chunks.map(({ heading, text, ordinal }) => ({ heading, text, ordinal }));
  }

  /*
   * The relevance filter works on sources, so each chunk is presented as one.
   * Reusing it rather than writing a second matcher means an improvement to
   * search relevance improves document retrieval too — and the canonicalising
   * and phrase rules are exactly what this needs.
   */
  const asSources = chunks.map((chunk) => ({
    kind: 'academic' as const,
    title: chunk.text.slice(0, 300),
    url: chunk.id,
    language: 'en' as const,
    provider: 'document',
    retrievedAt: new Date().toISOString(),
  }));

  const { kept } = filterByRelevance(asSources, question);

  const keptIds = new Set(kept.map((source) => source.url));
  const matched = chunks.filter((chunk) => keptIds.has(chunk.id));

  /*
   * Nothing matched. The opening of the document is returned rather than
   * nothing: a paper's first pages say what it is about, which answers more
   * questions than silence does — and the caller can see that retrieval found
   * no specific match by the passages being the first ones.
   */
  const chosen = matched.length > 0 ? matched : chunks;

  return chosen
    .slice(0, limit)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(({ heading, text, ordinal }) => ({ heading, text, ordinal }));
}
