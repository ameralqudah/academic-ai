'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Select, TextInput } from '@/components/ui/field';
import { ACADEMIC_FIELDS, CITATION_STYLES } from '@/config/research';
import { useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';

export function SettingsForm({
  initial,
}: {
  initial: {
    name: string;
    email: string;
    locale: Locale;
    citationStyle: string;
    defaultAcademicField: string;
  };
}) {
  const t = useTranslations('settings');
  const ta = useTranslations('auth');
  const tc = useTranslations('common');
  const tp = useTranslations('projects');
  const te = useTranslations('errors');
  const router = useRouter();

  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setSaved(false);
    setError(null);

    const form = new FormData(event.currentTarget);
    const nextLocale = String(form.get('locale') ?? initial.locale) as Locale;

    const response = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: String(form.get('name') ?? ''),
        locale: nextLocale,
        citationStyle: String(form.get('citationStyle') ?? ''),
        defaultAcademicField: String(form.get('defaultAcademicField') ?? ''),
      }),
    });

    setPending(false);

    if (!response.ok) {
      setError(te('server'));
      return;
    }

    setSaved(true);
    if (nextLocale !== initial.locale) router.replace('/settings', { locale: nextLocale });
    else router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      {saved ? <Alert tone="success">{t('updated')}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field label={t('displayName')} htmlFor="name" required>
        <TextInput id="name" name="name" defaultValue={initial.name} minLength={2} maxLength={80} />
      </Field>

      <Field label={ta('email')} htmlFor="email">
        <TextInput id="email" defaultValue={initial.email} dir="ltr" disabled />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t('interfaceLanguage')} htmlFor="locale">
          <Select id="locale" name="locale" defaultValue={initial.locale}>
            <option value="ar">{tc('arabic')}</option>
            <option value="en">{tc('english')}</option>
          </Select>
        </Field>

        <Field label={t('citationStyle')} htmlFor="citationStyle">
          <Select id="citationStyle" name="citationStyle" defaultValue={initial.citationStyle}>
            {CITATION_STYLES.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label={t('defaultField')} htmlFor="defaultAcademicField">
        <Select
          id="defaultAcademicField"
          name="defaultAcademicField"
          defaultValue={initial.defaultAcademicField}
        >
          {ACADEMIC_FIELDS.map((field) => (
            <option key={field} value={field}>
              {tp(`fields.${field}`)}
            </option>
          ))}
        </Select>
      </Field>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {pending ? tc('saving') : tc('save')}
        </Button>
      </div>
    </form>
  );
}
