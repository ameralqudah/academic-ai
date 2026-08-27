import { getFormatter } from 'next-intl/server';

import { Alert } from '@/components/ui/alert';
import type { LegalDocument } from '@/content/legal';

/**
 * Renders one legal document. `**bold**` is the only markup the source text
 * uses, so it is resolved here rather than pulling in a markdown renderer.
 */
function withEmphasis(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={index} className="font-semibold text-ink">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

export async function LegalDocumentView({
  locale,
  document,
}: {
  locale: string;
  document: LegalDocument;
}) {
  const format = await getFormatter({ locale });

  return (
    <article className="container-page flex max-w-3xl flex-col gap-8 py-14">
      <header className="flex flex-col gap-3">
        <h1 className="text-[2rem] font-bold text-ink sm:text-[2.4rem]">{document.title}</h1>
        <p className="text-sm text-muted">
          {format.dateTime(new Date(document.updated), { dateStyle: 'long' })}
        </p>
      </header>

      <Alert tone="warning">{document.notice}</Alert>

      <div className="flex flex-col gap-8">
        {document.sections.map((section) => (
          <section key={section.heading} className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-ink">{section.heading}</h2>
            {section.body.map((paragraph, index) => (
              <p key={index} className="leading-relaxed text-ink-soft">
                {withEmphasis(paragraph)}
              </p>
            ))}
          </section>
        ))}
      </div>
    </article>
  );
}
