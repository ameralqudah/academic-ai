'use client';

import { ArrowUp, ChevronDown, Loader2, Paperclip, Square, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * The composer.
 *
 * Simple by default, with the extra controls only where they are needed: a mode
 * selector and an attachment button in view, everything else revealed by use.
 * The brief asked for progressive disclosure and this is what that means in
 * practice — a person who wants to type a question sees a box to type in.
 *
 * Three behaviours here are not decoration.
 *
 * **Stop.** A long analysis or a slow model can run for many seconds, and
 * without a way to interrupt it the only options are waiting or reloading the
 * page — which loses the conversation. The button replaces send while a
 * response is streaming, because those two actions are never both available.
 *
 * **Drag and drop over the whole panel.** A researcher with a spreadsheet drags
 * it at the window, not at a particular button. Requiring aim is a small
 * cruelty repeated every time.
 *
 * **Enter sends, Shift+Enter breaks the line.** The convention every chat
 * follows, and the one people's hands already know.
 */

export type ModeKey = 'chat' | 'academic' | 'webSearch' | 'deepResearch' | 'dataAnalysis';

export interface ModeOption {
  key: ModeKey;
  available: boolean;
  requiresDataset: boolean;
}

export interface ModelOption {
  id: string;
  isDefault: boolean;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onAttach: (file: File) => void;
  busy: boolean;
  uploading: boolean;

  modes: ModeOption[];
  mode: ModeKey;
  onModeChange: (mode: ModeKey) => void;

  /** Empty when the user's plan offers no choice — the selector then hides itself. */
  models: ModelOption[];
  modelId: string | null;
  onModelChange: (modelId: string) => void;
  showModelSelector: boolean;
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  onAttach,
  busy,
  uploading,
  modes,
  mode,
  onModeChange,
  models,
  modelId,
  onModelChange,
  showModelSelector,
}: Props) {
  const t = useTranslations('agent');
  const tm = useTranslations('mode');

  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);

  /*
   * The box grows with the text up to a ceiling, then scrolls. A fixed single
   * row makes anyone writing a paragraph work through a letterbox; unbounded
   * growth eventually pushes the conversation off the screen.
   */
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [value]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!busy && value.trim()) onSend(value);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!busy && value.trim()) onSend(value);
  }

  /*
   * The drag counter exists because dragenter and dragleave fire for every
   * child element the pointer crosses. Tracking depth rather than a boolean is
   * what stops the highlight flickering as the file moves over the textarea.
   */
  const dragDepth = useRef(0);

  function onDragEnter(event: DragEvent) {
    event.preventDefault();
    dragDepth.current += 1;
    if (event.dataTransfer.types.includes('Files')) setDragging(true);
  }

  function onDragLeave(event: DragEvent) {
    event.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);

    const file = event.dataTransfer.files?.[0];
    if (file) onAttach(file);
  }

  const activeMode = modes.find((option) => option.key === mode);

  return (
    <form
      onSubmit={onSubmit}
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'relative flex flex-col gap-2 rounded-xl border bg-surface p-2 transition-colors',
        dragging ? 'border-accent bg-accent-soft/30' : 'border-line',
      )}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl bg-surface/90 text-sm text-accent">
          <Upload className="size-4" aria-hidden />
          {t('dropToAttach')}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.xlsx"
        className="hidden"
        onChange={(change) => {
          const selected = change.target.files?.[0];
          if (selected) onAttach(selected);
          change.target.value = '';
        }}
      />

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(change) => onChange(change.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder={t('placeholder')}
        disabled={busy}
        className={cn(
          'max-h-[200px] w-full resize-none bg-transparent px-2 py-2 text-sm text-ink',
          'outline-none placeholder:text-muted disabled:opacity-60',
        )}
      />

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading || busy}
          aria-label={t('attachFile')}
          className="rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-ink disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Paperclip className="size-4" aria-hidden />
          )}
        </button>

        {/* Mode */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setModeOpen((open) => !open)}
            disabled={busy}
            aria-haspopup="listbox"
            aria-expanded={modeOpen}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-subtle hover:text-ink disabled:opacity-50"
          >
            {tm(mode)}
            <ChevronDown className="size-3" aria-hidden />
          </button>

          {modeOpen && (
            <div
              role="listbox"
              className="absolute bottom-full start-0 z-20 mb-1 w-56 rounded-lg border border-line bg-surface p-1 shadow-lg"
            >
              {modes.map((option) =>
                option.available ? (
                  <button
                    key={option.key}
                    type="button"
                    role="option"
                    aria-selected={option.key === mode}
                    onClick={() => {
                      onModeChange(option.key);
                      setModeOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between rounded px-2.5 py-1.5 text-start text-sm hover:bg-subtle',
                      option.key === mode ? 'text-accent' : 'text-ink',
                    )}
                  >
                    {tm(option.key)}
                    {option.requiresDataset && (
                      <span className="text-[10px] text-muted">{t('needsFile')}</span>
                    )}
                  </button>
                ) : (
                  /*
                   * Not a button. A disabled one still takes focus and still
                   * reads as an action to a screen reader, which implies a mode
                   * that can be entered. It cannot.
                   */
                  <span
                    key={option.key}
                    className="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-sm text-muted/60"
                    title={tm(`unavailable.${option.key}`)}
                  >
                    {tm(option.key)}
                    <span className="rounded bg-subtle px-1.5 py-0.5 text-[10px]">
                      {t('soon')}
                    </span>
                  </span>
                ),
              )}
            </div>
          )}
        </div>

        {/*
          The model selector appears only where there is a genuine choice. With
          one provider configured a dropdown of one is furniture implying a
          decision the user does not have; the day a second key is added it
          appears on its own.
        */}
        {showModelSelector && models.length > 1 && (
          <select
            value={modelId ?? ''}
            onChange={(change) => onModelChange(change.target.value)}
            disabled={busy}
            aria-label={t('model')}
            className="rounded-lg bg-transparent px-2 py-1.5 text-xs text-muted outline-none hover:bg-subtle disabled:opacity-50"
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id.split(':')[1]}
              </option>
            ))}
          </select>
        )}

        <span className="ms-auto flex items-center gap-2">
          {activeMode?.requiresDataset && (
            <span className="hidden text-[11px] text-muted sm:inline">{t('needsFile')}</span>
          )}

          {/*
            Stop replaces send while a response streams. They are never both
            available, and showing a disabled send button next to a spinner
            gives the user nothing to do but wait or reload — and reloading used
            to lose the conversation.
          */}
          {busy ? (
            <Button type="button" onClick={onStop} variant="outline" aria-label={t('stop')}>
              <Square className="size-3.5 fill-current" aria-hidden />
            </Button>
          ) : (
            <Button type="submit" disabled={value.trim().length === 0} aria-label={t('send')}>
              <ArrowUp className="size-4" aria-hidden />
            </Button>
          )}
        </span>
      </div>
    </form>
  );
}
