'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Select, TextInput } from '@/components/ui/field';
import { useRouter } from '@/i18n/navigation';

const PROVIDERS = ['anthropic', 'openai', 'google'] as const;
type Provider = (typeof PROVIDERS)[number];

export function AIProviderForm({
  current,
  models,
}: {
  current: Provider;
  models: Partial<Record<Provider, string>>;
}) {
  const t = useTranslations('admin.aiForm');
  const te = useTranslations('errors');
  const tc = useTranslations('common');
  const router = useRouter();

  const [provider, setProvider] = useState<Provider>(current);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setSaved(false);
    setError(null);

    const form = new FormData(event.currentTarget);
    const payload = {
      provider,
      models: Object.fromEntries(
        PROVIDERS.map((name) => [name, String(form.get(`model-${name}`) ?? '')]).filter(
          ([, value]) => value,
        ),
      ),
    };

    const response = await fetch('/api/admin/ai', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    setPending(false);
    if (!response.ok) {
      setError(te('server'));
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="surface-card flex flex-col gap-5 p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-ink">{t('title')}</h2>
        <p className="text-sm text-muted">{t('hint')}</p>
      </div>

      {saved ? <Alert tone="success">{t('saved')}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field label={t('provider')} htmlFor="ai-provider">
        <Select
          id="ai-provider"
          value={provider}
          onChange={(event) => setProvider(event.target.value as Provider)}
          className="sm:max-w-xs"
        >
          {PROVIDERS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        {PROVIDERS.map((name) => (
          <Field key={name} label={name} htmlFor={`model-${name}`}>
            <TextInput
              id={`model-${name}`}
              name={`model-${name}`}
              defaultValue={models[name] ?? ''}
              dir="ltr"
              placeholder="model id"
            />
          </Field>
        ))}
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {pending ? tc('saving') : tc('save')}
        </Button>
      </div>
    </form>
  );
}
