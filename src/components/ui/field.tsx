'use client';

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

const CONTROL =
  'w-full rounded-lg border border-line bg-surface px-3.5 py-2.5 text-[0.95rem] text-ink ' +
  'placeholder:text-muted/70 transition-colors ' +
  'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted';

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {/*
        The required marker sits *outside* the label element on purpose. The
        input already carries `required`, which is what assistive technology
        announces; keeping the asterisk inside the label would make every field
        read as "Email star" — browsers include it in the accessible name even
        when it is aria-hidden.
      */}
      <span className="flex items-center gap-0.5">
        <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
          {label}
        </label>
        {required ? (
          <span className="text-sm text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, className)} {...props} />;
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL, 'min-h-28 resize-y leading-relaxed', className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(CONTROL, 'cursor-pointer appearance-none pe-9', className)} {...props}>
      {children}
    </select>
  );
}

/** Radio group rendered as selectable cards — used for degree, language, research type. */
export function OptionCards<T extends string>({
  name,
  options,
  value,
  onChange,
  columns = 2,
}: {
  name: string;
  options: { value: T; label: string; hint?: string }[];
  value: T | null;
  onChange: (value: T) => void;
  columns?: 2 | 3;
}) {
  const groupId = useId();

  return (
    <div
      role="radiogroup"
      className={cn('grid gap-2', columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}
    >
      {options.map((option) => {
        const id = `${groupId}-${option.value}`;
        const selected = value === option.value;
        return (
          <label
            key={option.value}
            htmlFor={id}
            className={cn(
              'flex cursor-pointer flex-col gap-0.5 rounded-lg border px-4 py-3 transition-colors',
              selected
                ? 'border-primary bg-primary-soft text-ink'
                : 'border-line bg-surface hover:border-line-strong',
            )}
          >
            <input
              id={id}
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            <span className="text-sm font-medium">{option.label}</span>
            {option.hint ? <span className="text-xs text-muted">{option.hint}</span> : null}
          </label>
        );
      })}
    </div>
  );
}
