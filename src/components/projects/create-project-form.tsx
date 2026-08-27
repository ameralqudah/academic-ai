'use client';

import { Loader2, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent, type KeyboardEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, OptionCards, Select, TextArea, TextInput } from '@/components/ui/field';
import {
  ACADEMIC_FIELDS,
  DEGREES,
  DOC_TYPES,
  PROJECT_LANGUAGES,
  RESEARCH_TYPES,
} from '@/config/research';
import { useRouter } from '@/i18n/navigation';

type Degree = (typeof DEGREES)[number];
type ProjectLanguage = (typeof PROJECT_LANGUAGES)[number];
type ResearchType = (typeof RESEARCH_TYPES)[number];
type DocType = (typeof DOC_TYPES)[number];

const MAX_KEYWORDS = 8;

export function CreateProjectForm({ canCreate }: { canCreate: boolean }) {
  const t = useTranslations('projects.create');
  const tp = useTranslations('projects');
  const tu = useTranslations('usage');
  const te = useTranslations('errors');
  const locale = useLocale();
  const router = useRouter();

  const [degree, setDegree] = useState<Degree>('MASTER');
  const [language, setLanguage] = useState<ProjectLanguage>(locale === 'en' ? 'EN' : 'AR');
  const [researchType, setResearchType] = useState<ResearchType>('QUANTITATIVE');
  const [docType, setDocType] = useState<DocType>('PAPER');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(!canCreate);

  function addKeyword() {
    const value = keywordDraft.trim();
    if (!value || keywords.includes(value) || keywords.length >= MAX_KEYWORDS) return;
    setKeywords((current) => [...current, value]);
    setKeywordDraft('');
  }

  function onKeywordKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addKeyword();
    } else if (event.key === 'Backspace' && !keywordDraft) {
      setKeywords((current) => current.slice(0, -1));
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);
    const payload = {
      academicField: String(form.get('academicField') ?? ''),
      specialization: String(form.get('specialization') ?? ''),
      degree,
      language,
      researchType,
      docType,
      keywords,
      problemArea: String(form.get('problemArea') ?? ''),
    };

    if (payload.keywords.length === 0) {
      setError(te('validation'));
      return;
    }

    setPending(true);
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = (await response.json()) as
      | { ok: true; data: { id: string } }
      | { ok: false; error: { code: string } };

    if (!response.ok || !body.ok) {
      setPending(false);
      if (!body.ok && body.error.code === 'PLAN_LIMIT') setLimitReached(true);
      else setError(te('server'));
      return;
    }

    // Phase 2 lands the user on the title generator; until then the project page
    // is the destination and it links onwards.
    router.push(`/projects/${body.data.id}`);
  }

  if (limitReached) {
    return (
      <Alert tone="upgrade" title={tu('limitReachedTitle')}>
        {tu('limitReachedBody')}
      </Alert>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t('academicField')} htmlFor="academicField" hint={t('academicFieldHint')} required>
          <Select id="academicField" name="academicField" defaultValue="educationalSciences" required>
            {ACADEMIC_FIELDS.map((field) => (
              <option key={field} value={field}>
                {tp(`fields.${field}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('specialization')} htmlFor="specialization">
          <TextInput
            id="specialization"
            name="specialization"
            maxLength={160}
            placeholder={t('specializationPlaceholder')}
          />
        </Field>
      </div>

      <Field label={t('degree')} required>
        <OptionCards
          name="degree"
          value={degree}
          onChange={setDegree}
          options={DEGREES.map((value) => ({ value, label: tp(`degrees.${value}`) }))}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t('language')} required>
          <OptionCards
            name="language"
            value={language}
            onChange={setLanguage}
            options={PROJECT_LANGUAGES.map((value) => ({
              value,
              label: tp(`languages.${value}`),
            }))}
          />
        </Field>

        <Field label={t('docType')} required>
          <OptionCards
            name="docType"
            value={docType}
            onChange={setDocType}
            options={DOC_TYPES.map((value) => ({ value, label: tp(`docTypes.${value}`) }))}
          />
        </Field>
      </div>

      <Field label={t('researchType')} required>
        <OptionCards
          name="researchType"
          columns={3}
          value={researchType}
          onChange={setResearchType}
          options={RESEARCH_TYPES.map((value) => ({
            value,
            label: tp(`researchTypes.${value}`),
          }))}
        />
      </Field>

      <Field label={t('keywords')} htmlFor="keyword-draft" hint={t('keywordsHint')} required>
        <div className="flex flex-col gap-2">
          {keywords.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {keywords.map((keyword) => (
                <li key={keyword}>
                  <button
                    type="button"
                    onClick={() => setKeywords((current) => current.filter((k) => k !== keyword))}
                    className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 py-1 ps-3 pe-2 text-sm text-ink"
                  >
                    {keyword}
                    <X className="size-3.5 text-muted" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <TextInput
            id="keyword-draft"
            value={keywordDraft}
            onChange={(event) => setKeywordDraft(event.target.value)}
            onKeyDown={onKeywordKeyDown}
            onBlur={addKeyword}
            maxLength={60}
            disabled={keywords.length >= MAX_KEYWORDS}
            placeholder={t('keywordsPlaceholder')}
          />
        </div>
      </Field>

      <Field label={t('problemArea')} htmlFor="problemArea" hint={t('problemAreaHint')} required>
        <TextArea
          id="problemArea"
          name="problemArea"
          rows={6}
          required
          minLength={20}
          maxLength={2000}
          placeholder={t('problemAreaPlaceholder')}
        />
      </Field>

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {pending ? t('creating') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
