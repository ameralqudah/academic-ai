'use client';

import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/cn';

/**
 * Rendering assistant output.
 *
 * Everything before this displayed model output with `whitespace-pre-wrap`,
 * which turns a table into a row of pipes and a heading into a line beginning
 * with a hash. The model was writing markdown all along; nothing was reading it.
 *
 * **Maths is loaded only when there is maths.** KaTeX is around 250KB — two
 * thirds of everything this file pulls in — and most people using this product
 * are writing in education and the social sciences, where `p < .001` appears as
 * ordinary text and a LaTeX expression never does. So the content is scanned
 * for `$…$` or `$$…$$` first, and the maths pipeline is imported only if one is
 * found. A student who never writes an equation never downloads the engine for
 * one.
 *
 * The scan is a regular expression over the message, which costs microseconds
 * against a quarter of a megabyte saved. That ratio is why this is worth the
 * indirection.
 */

/**
 * Detects real maths rather than any dollar sign.
 *
 * "$50" and "costs $5–$10" are prices, and treating them as delimiters would
 * load the engine for a sentence about money and then render the text between
 * two prices as an equation. Requiring a non-space, non-digit character
 * immediately after the opening `$` rules that out while still matching `$x$`,
 * `$\alpha$` and `$$\sum_{i=1}^{n}$$`.
 */
const MATH_PATTERN = /\$\$[\s\S]+?\$\$|\$[^\s\d$][^$\n]*\$/;

export function containsMath(content: string): boolean {
  return MATH_PATTERN.test(content);
}

/**
 * The maths-capable renderer, in its own chunk.
 *
 * `lazy` puts KaTeX and its plugins behind a dynamic import, so the bundle for
 * a conversation with no equations never contains them.
 */
const MathMarkdown = lazy(() => import('./markdown-math'));

export interface MarkdownProps {
  content: string;
  /** Slightly tighter spacing inside a chat bubble than in a document. */
  compact?: boolean;
}

export function Markdown({ content, compact }: MarkdownProps) {
  const hasMath = useMemo(() => containsMath(content), [content]);

  if (hasMath) {
    return (
      <Suspense fallback={<PlainMarkdown content={content} compact={compact} />}>
        <MathMarkdown content={content} compact={compact} />
      </Suspense>
    );
  }

  return <PlainMarkdown content={content} compact={compact} />;
}

/** Markdown and GFM only — no maths pipeline, no KaTeX in the bundle. */
function PlainMarkdown({ content, compact }: MarkdownProps) {
  return (
    <div className={proseClass(compact)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={markdownComponents()}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Shared presentation                             */
/* -------------------------------------------------------------------------- */

export function proseClass(compact?: boolean): string {
  return cn(
    'max-w-none text-sm leading-relaxed text-ink',
    '[&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-1',
    '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold',
    '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold',
    '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold',
    '[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:ps-5 [&_ol]:ps-5',
    '[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2',
    /*
     * Logical properties throughout — `ps`, `ms`, `border-s` — so a quote or a
     * list indents from the correct side in both directions. `pl` would put the
     * bar on the wrong edge of every Arabic blockquote.
     */
    '[&_blockquote]:border-s-2 [&_blockquote]:border-line [&_blockquote]:ps-3 [&_blockquote]:text-muted',
    '[&_hr]:my-4 [&_hr]:border-line',
    '[&_strong]:font-semibold [&_strong]:text-ink',
    compact && '[&_p]:my-1.5 [&_h1]:mt-3 [&_h2]:mt-3',
  );
}

export function markdownComponents(): Components {
  return {
    /*
     * Code needs its own handling because a fenced block and an inline span
     * arrive as the same element. Inline code is a coloured span; a block gets
     * a copy button, since the reason anyone reads code in a chat is to use it
     * elsewhere.
     */
    code({ className, children, ...props }) {
      const isBlock = /language-/.test(className ?? '');

      if (!isBlock) {
        return (
          <code
            className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[0.85em] text-ink"
            {...props}
          >
            {children}
          </code>
        );
      }

      return (
        <code className={cn(className, 'font-mono text-xs')} {...props}>
          {children}
        </code>
      );
    },

    pre({ children }) {
      return <CodeBlock>{children}</CodeBlock>;
    },

    /*
     * Tables scroll rather than overflow. A five-column comparison on a phone
     * has to go somewhere, and a horizontally scrolling table is far better
     * than one that pushes the whole page sideways — which is exactly what the
     * responsive tests check for.
     */
    table({ children }) {
      return (
        <div className="my-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-sm">{children}</table>
        </div>
      );
    },
    thead({ children }) {
      return <thead className="border-b border-line bg-subtle">{children}</thead>;
    },
    th({ children }) {
      return <th className="px-3 py-2 text-start text-xs font-medium text-muted">{children}</th>;
    },
    td({ children }) {
      return <td className="border-t border-line/50 px-3 py-2 text-ink">{children}</td>;
    },

    /* External links open away from the conversation and cannot reach it back. */
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
  };
}

/**
 * A code block with a copy button.
 *
 * The button carries a label rather than an icon alone, because an unlabelled
 * icon is invisible to a screen reader and ambiguous to everyone else. It
 * confirms for two seconds after copying — without that, a click that succeeds
 * and a click that did nothing look identical.
 */
function CodeBlock({ children }: { children: ReactNode }) {
  const t = useTranslations('chat');
  const [copied, setCopied] = useState(false);

  async function copy(event: React.MouseEvent<HTMLButtonElement>) {
    const block = event.currentTarget.parentElement?.querySelector('code');
    const text = block?.textContent ?? '';
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A denied clipboard permission is not worth an error message.
    }
  }

  return (
    <div className="group relative my-3">
      <button
        type="button"
        onClick={copy}
        aria-label={t('copyCode')}
        className={cn(
          'absolute top-2 end-2 flex items-center gap-1 rounded-md border border-line',
          'bg-surface px-2 py-1 text-xs text-muted opacity-0 transition-opacity',
          'group-hover:opacity-100 focus-visible:opacity-100',
        )}
      >
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
        {copied ? t('copied') : t('copy')}
      </button>
      {/*
        Forced left-to-right regardless of the page direction. Code is not
        Arabic even on an Arabic page, and an RTL code block puts the semicolons
        at the start of the line.
      */}
      <pre
        dir="ltr"
        className="overflow-x-auto rounded-lg border border-line bg-subtle p-3 text-start"
      >
        {children}
      </pre>
    </div>
  );
}
