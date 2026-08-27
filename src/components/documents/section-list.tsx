import { ArrowLeft, ArrowRight, Check, Circle } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import type { SectionKey } from '@/config/research';
import { Link } from '@/i18n/navigation';
import { sectionI18nKey } from '@/lib/sections';
import type { ResearchSection } from '@/server/db/schema';

/**
 * The shared "parts of this document" list used by the proposal generator, the
 * thesis assistant and the workspace. Each entry links to the wizard step that
 * edits it, so there is exactly one editing surface in the product.
 */
export async function SectionList({
  locale,
  projectId,
  order,
  stepOrder,
  sections,
}: {
  locale: string;
  projectId: string;
  /** The parts of *this* document, in the order they are presented. */
  order: SectionKey[];
  /**
   * The project's actual wizard order. Step numbers come from here, not from the
   * list above — a proposal viewed on a project still set to PAPER would
   * otherwise link every row to the wrong section.
   */
  stepOrder: SectionKey[];
  sections: ResearchSection[];
}) {
  const ts = await getTranslations({ locale, namespace: 'sections' });
  const td = await getTranslations({ locale, namespace: 'documents' });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US');
  const Arrow = locale === 'ar' ? ArrowLeft : ArrowRight;

  return (
    <ol className="flex flex-col gap-2">
      {order.map((key, index) => {
        const section = sections.find((row) => row.sectionKey === key);
        const status = section?.status ?? 'EMPTY';
        const step = stepOrder.indexOf(key) + 1;

        const body = (
          <>
            <span className="flex min-w-0 items-center gap-3">
                {status === 'APPROVED' ? (
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-success/15 text-success">
                    <Check className="size-4" aria-hidden />
                  </span>
                ) : (
                  <span className="tabular grid size-7 shrink-0 place-items-center rounded-full border border-line text-xs text-muted">
                    {status === 'EMPTY' ? (
                      <Circle className="size-2 fill-current" aria-hidden />
                    ) : (
                      number.format(index + 1)
                    )}
                  </span>
                )}
                <span className="flex min-w-0 flex-col">
                  <span
                    className={
                      status === 'EMPTY'
                        ? 'truncate text-sm text-muted'
                        : 'truncate text-sm font-medium text-ink'
                    }
                  >
                    {ts(sectionI18nKey(key))}
                  </span>
                  {section && section.wordCount > 0 ? (
                    <span className="tabular text-xs text-muted">
                      {number.format(section.wordCount)}
                    </span>
                  ) : null}
                </span>
              </span>

            <span className="flex shrink-0 items-center gap-2">
              <Badge tone={status === 'APPROVED' ? 'success' : 'neutral'}>
                {ts(`status.${status}`)}
              </Badge>
              {step > 0 ? (
                <span className="hidden items-center gap-1 text-xs text-muted group-hover:text-primary sm:flex">
                  {td('openSection')}
                  <Arrow className="size-3.5" aria-hidden />
                </span>
              ) : null}
            </span>
          </>
        );

        const className =
          'surface-card group flex items-center justify-between gap-3 px-4 py-3 transition-colors';

        return (
          <li key={key}>
            {step > 0 ? (
              <Link
                href={`/projects/${projectId}/wizard/${step}`}
                className={`${className} hover:border-line-strong`}
              >
                {body}
              </Link>
            ) : (
              // The section exists but is not part of this project's wizard order
              // yet — the page above shows the "switch document type" banner.
              <div className={`${className} opacity-70`}>{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
