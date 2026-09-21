'use client';

import { useLocale } from 'next-intl';
import { useSyncExternalStore } from 'react';

/**
 * A moment, shown in the reader's own time zone.
 *
 * Server-rendered dates use the one zone the app is configured with (UTC), so
 * an operator in Amman saw a payment event stamped three hours before it
 * happened. The server cannot know the reader's zone; the browser does. So the
 * server renders the UTC time, labelled as such, and the browser replaces it
 * once it is running — no hydration mismatch, and never a wrong time presented
 * as local.
 */
export function LocalTime({ iso }: { iso: string }) {
  const locale = useLocale();

  const hydrated = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  const date = new Date(iso);
  const tag = locale === 'ar' ? 'ar-JO-u-nu-latn' : 'en-GB';

  const text = new Intl.DateTimeFormat(tag, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(hydrated ? {} : { timeZone: 'UTC' }),
  }).format(date);

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {hydrated ? text : `${text} UTC`}
    </time>
  );
}
