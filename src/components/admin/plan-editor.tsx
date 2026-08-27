'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { useRouter } from '@/i18n/navigation';

const NUMERIC_FIELDS = [
  'priceCents',
  'maxProjects',
  'maxAiRequests',
  'maxGeneratedWords',
  'maxExports',
] as const;

export interface EditablePlan {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  maxProjects: number;
  maxAiRequests: number;
  maxGeneratedWords: number;
  maxExports: number;
  toolAccess: Record<string, boolean>;
  isActive: boolean;
  externalPriceId: string | null;
}

export function PlanEditor({ plan }: { plan: EditablePlan }) {
  const t = useTranslations('admin.plansForm');
  const te = useTranslations('errors');
  const tc = useTranslations('common');
  const router = useRouter();

  const [access, setAccess] = useState(plan.toolAccess);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setSaved(false);
    setError(null);

    const form = new FormData(event.currentTarget);
    const payload: Record<string, unknown> = { planId: plan.id, toolAccess: access };

    for (const field of NUMERIC_FIELDS) {
      payload[field] = Number(form.get(field) ?? 0);
    }
    payload.isActive = form.get('isActive') === 'on';
    payload.externalPriceId = String(form.get('externalPriceId') ?? '') || null;

    const response = await fetch('/api/admin/plans', {
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
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">
          {plan.name} <span className="text-muted">· {plan.code}</span>
        </h2>
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            name="isActive"
            defaultChecked={plan.isActive}
            className="size-4 accent-[var(--primary)]"
          />
          {t('active')}
        </label>
      </div>

      {saved ? <Alert tone="success">{t('saved')}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Field label={t('price')} htmlFor={`${plan.id}-priceCents`}>
          <TextInput
            id={`${plan.id}-priceCents`}
            name="priceCents"
            type="number"
            min={0}
            defaultValue={plan.priceCents}
            dir="ltr"
          />
        </Field>
        <Field
          label={t('maxProjects')}
          htmlFor={`${plan.id}-maxProjects`}
          hint={t('unlimitedHint')}
        >
          <TextInput
            id={`${plan.id}-maxProjects`}
            name="maxProjects"
            type="number"
            min={-1}
            defaultValue={plan.maxProjects}
            dir="ltr"
          />
        </Field>
        <Field label={t('maxAiRequests')} htmlFor={`${plan.id}-maxAiRequests`}>
          <TextInput
            id={`${plan.id}-maxAiRequests`}
            name="maxAiRequests"
            type="number"
            min={-1}
            defaultValue={plan.maxAiRequests}
            dir="ltr"
          />
        </Field>
        <Field label={t('maxGeneratedWords')} htmlFor={`${plan.id}-maxGeneratedWords`}>
          <TextInput
            id={`${plan.id}-maxGeneratedWords`}
            name="maxGeneratedWords"
            type="number"
            min={-1}
            defaultValue={plan.maxGeneratedWords}
            dir="ltr"
          />
        </Field>
        <Field label={t('maxExports')} htmlFor={`${plan.id}-maxExports`}>
          <TextInput
            id={`${plan.id}-maxExports`}
            name="maxExports"
            type="number"
            min={-1}
            defaultValue={plan.maxExports}
            dir="ltr"
          />
        </Field>
        <Field label={t('externalPriceId')} htmlFor={`${plan.id}-externalPriceId`}>
          <TextInput
            id={`${plan.id}-externalPriceId`}
            name="externalPriceId"
            defaultValue={plan.externalPriceId ?? ''}
            dir="ltr"
            placeholder="price_…"
          />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-ink">{t('features')}</legend>
        <div className="flex flex-wrap gap-2">
          {Object.keys(access)
            .sort()
            .map((key) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink-soft"
              >
                <input
                  type="checkbox"
                  checked={access[key] === true}
                  onChange={(event) =>
                    setAccess((current) => ({ ...current, [key]: event.target.checked }))
                  }
                  className="size-3.5 accent-[var(--primary)]"
                />
                {key}
              </label>
            ))}
        </div>
      </fieldset>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {pending ? tc('saving') : tc('save')}
        </Button>
      </div>
    </form>
  );
}
