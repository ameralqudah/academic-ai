'use client';

import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import { markdownComponents, proseClass, type MarkdownProps } from './markdown';

/*
 * KaTeX's stylesheet, imported here rather than in the global sheet.
 *
 * That placement is the entire point of this file existing. Importing it
 * globally would put a quarter of a megabyte of fonts and CSS into the first
 * load for every visitor, including the great majority who will never see an
 * equation. Importing it inside the lazily-loaded chunk means it arrives with
 * the maths renderer, when there is maths to render, and not before.
 */
import 'katex/dist/katex.min.css';

/**
 * Markdown with LaTeX.
 *
 * Identical to the plain renderer except for two extra plugins, and separate
 * from it only so that the bundler can split them apart. `markdownComponents`
 * and `proseClass` are shared rather than duplicated, so a change to how tables
 * or code blocks look applies to both without anyone remembering to update the
 * second copy.
 */
export default function MathMarkdown({ content, compact }: MarkdownProps) {
  return (
    <div className={proseClass(compact)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          /*
           * `throwOnError: false` because the content is model output. A
           * malformed expression should render as the text it is, not take
           * down the message that contains it — and half-written LaTeX is
           * exactly what arrives mid-stream while a response is still coming in.
           */
          [rehypeKatex, { throwOnError: false, strict: false }],
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        components={markdownComponents()}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
