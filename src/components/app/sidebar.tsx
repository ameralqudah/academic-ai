'use client';

import {
  BarChart3,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  GraduationCap,
  Library,
  LogOut,
  Plus,
  Pencil,
  Search,
  Settings,
  Shield,
  Telescope,
  Trash2,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { signOut } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState, useSyncExternalStore } from 'react';

import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/theme-toggle';

import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/cn';

/**
 * The sidebar.
 *
 * Two decisions here are worth more than the layout.
 *
 * **Unbuilt features are shown, disabled, rather than hidden.** Web Search and
 * Deep Research appear greyed with a "Soon" badge. Hiding them would be tidier
 * and would leave a user unable to tell a missing feature from one they failed
 * to find; showing them as working would be a lie. It is the same discipline
 * the agent uses when it declines PLS-SEM by name — say what exists, say what
 * does not, and never let the two blur.
 *
 * **Academic Search and Literature Review open the chat.** They are not
 * separate pages because they are not separate features: the agent already does
 * both, and a page duplicating that would be a second implementation to keep in
 * step with the first. They carry a prompt into the composer instead, which is
 * where the work actually happens.
 */

interface NavItem {
  href: string;
  key: string;
  icon: LucideIcon;
  /** Recognised, not built. Rendered disabled with a badge. */
  soon?: boolean;
  /** Seeds the composer — for entries that are a way into the chat. */
  prompt?: string;
}

interface NavSection {
  key: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    key: 'workspace',
    items: [
      { href: '/projects', key: 'projects', icon: FolderKanban },
      /*
       * Points at the files page, which is what "Library" means to a
       * researcher. It pointed at the analysis tool, which inspects a single
       * file — a different question from "what do I have".
       */
      { href: '/files', key: 'library', icon: Library },
      { href: '/analysis', key: 'dataAnalysis', icon: BarChart3 },
    ],
  },
  {
    key: 'research',
    items: [
      /*
       * These two carry a prompt rather than pointing at a page of their own.
       * The agent already searches Crossref and OpenAlex; a dedicated page
       * would be a second implementation of the same capability, drifting from
       * the first the moment either changed.
       */
      { href: '/chat', key: 'academicSearch', icon: GraduationCap, prompt: 'academicSearchPrompt' },
      { href: '/chat', key: 'literatureReview', icon: BookOpen, prompt: 'literatureReviewPrompt' },
      /*
       * Built. Whether they are reachable depends on a search provider key, and
       * that is decided by the server rather than hard-coded here — a `soon`
       * flag left in place after the feature shipped is the failure this
       * replaces.
       */
      { href: '/chat', key: 'webSearch', icon: Search, prompt: 'webSearchPrompt' },
      { href: '/chat', key: 'deepResearch', icon: Telescope, prompt: 'deepResearchPrompt' },
    ],
  },
];

/**
 * Billing and settings sit in the account block at the foot of the sidebar, as
 * icons beside the user's name. As a full section they took three rows of the
 * scrolling area, which is space the conversation list needs.
 */
const ACCOUNT_LINKS: { href: string; key: string; icon: LucideIcon }[] = [
  { href: '/billing', key: 'billing', icon: Wallet },
  { href: '/settings', key: 'settings', icon: Settings },
];

export interface ConversationSummary {
  id: string;
  title: string | null;
  /** ISO time of the last activity. Optional so older callers keep working. */
  at?: string;
}

type GroupKey = 'today' | 'yesterday' | 'week' | 'older';

const GROUP_ORDER: GroupKey[] = ['today', 'yesterday', 'week', 'older'];

/**
 * Which heading a conversation belongs under.
 *
 * Measured in calendar days from local midnight rather than in 24-hour spans,
 * because "yesterday" means the previous date to a person, not "between 24 and
 * 48 hours ago".
 */
function groupOf(at: string | undefined, now: Date): GroupKey {
  if (!at) return 'older';

  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = new Date(at).getTime();
  const day = 86_400_000;

  if (time >= midnight) return 'today';
  if (time >= midnight - day) return 'yesterday';
  if (time >= midnight - 7 * day) return 'week';
  return 'older';
}

export function Sidebar({
  conversations,
  userName,
  userEmail,
  isAdmin,
  onNavigate,
}: {
  conversations: ConversationSummary[];
  userName: string;
  userEmail: string;
  isAdmin: boolean;
  /** Closes the mobile drawer after a tap. Unused on desktop. */
  onNavigate?: () => void;
}) {
  const t = useTranslations('sidebar');
  const tn = useTranslations('nav');
  const pathname = usePathname();

  /*
   * Collapse state in localStorage, not the database. It is a preference about
   * this screen rather than data about the user, and a round trip to the server
   * to remember a chevron would be absurd.
   */
  /*
   * Read lazily rather than in an effect.
   *
   * Setting state from an effect renders once with the wrong value and again
   * with the right one, which is a visible flash of an expanded sidebar for
   * anyone who collapsed it. The lazy initialiser runs before the first paint;
   * the `typeof window` guard is for the server render, where there is no
   * localStorage and the default is correct anyway.
   */
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('sidebar:collapsed') === '1',
  );

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem('sidebar:collapsed', next ? '1' : '0');
      return next;
    });
  }

  const [query, setQuery] = useState('');

  /*
   * False on the server and during hydration, true afterwards.
   *
   * "Today" depends on the reader's timezone, and the server does not know it:
   * a conversation from 23:30 UTC is yesterday in one place and today in
   * another. Grouping during the server render would put a heading in the HTML
   * that the browser then disagrees with — a hydration error, and a list that
   * visibly rearranges. So the first paint is one plain list, and the grouping
   * is applied once the browser's own clock is the one being read.
   */
  const hydrated = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  /*
   * Filtered, then grouped. The list arrives newest first, so each group keeps
   * that order without sorting again.
   */
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const now = new Date();
    const result: Record<GroupKey, ConversationSummary[]> = {
      today: [],
      yesterday: [],
      week: [],
      older: [],
    };

    for (const conversation of conversations) {
      if (needle && !(conversation.title ?? '').toLowerCase().includes(needle)) continue;
      result[hydrated ? groupOf(conversation.at, now) : 'today'].push(conversation);
    }

    return result;
  }, [conversations, query, hydrated]);

  const matches = GROUP_ORDER.reduce((sum, key) => sum + groups[key].length, 0);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div
      className={cn(
        /*
         * `h-dvh` and `overflow-hidden` on the frame, with a single scrolling
         * region inside it.
         *
         * `h-full` was wrong: without a height on the parent it collapses to
         * the content, the whole sidebar grows past the viewport, and the page
         * scroll takes the brand and the New chat button off the top — which is
         * exactly what a user saw on a shorter screen. Fixing the frame to the
         * viewport keeps the header and the account block in place and lets
         * only the middle move.
         */
        'flex h-dvh flex-col gap-4 overflow-hidden border-e border-line bg-surface-2',
        'transition-[width] duration-200',
        collapsed ? 'w-16 px-2 py-4' : 'w-64 px-3 py-4',
      )}
    >
      {/* Brand and the collapse control */}
      <div className="flex items-center justify-between gap-2">
        {!collapsed && (
          <Link
            href="/chat"
            onClick={onNavigate}
            className="flex items-center gap-2 px-1 text-sm font-semibold text-ink"
          >
            <span
              aria-hidden
              className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-primary pb-1 font-display text-lg leading-none font-bold text-on-primary"
            >
              أ
            </span>
            Academic AI
          </Link>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t('expand') : t('collapse')}
          className="hidden shrink-0 rounded-lg p-1.5 text-muted hover:bg-subtle hover:text-ink lg:block"
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        </button>
      </div>

      {/* New chat — the one action that should never be more than one click away */}
      <Link
        href="/chat"
        onClick={onNavigate}
        className={cn(
          'flex items-center gap-2.5 rounded-xl px-2 py-2 text-sm font-medium text-primary',
          'hover:bg-primary-soft',
          collapsed && 'justify-center px-0',
        )}
        title={collapsed ? t('newChat') : undefined}
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-on-primary">
          <Plus className="size-3.5" strokeWidth={2.4} aria-hidden />
        </span>
        {!collapsed && t('newChat')}
      </Link>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
        {SECTIONS.map((section) => (
          <section key={section.key} className="flex flex-col gap-1">
            {!collapsed && (
              <h2 className="px-2 text-xs font-medium text-muted">{t(`section.${section.key}`)}</h2>
            )}
            {section.items.map((item) => (
              <NavLink
                key={`${section.key}-${item.key}`}
                item={item}
                collapsed={collapsed}
                /* An entry that seeds the composer is a shortcut into the chat, not a
                   place: marking it active lit up all four whenever the chat was open. */
                active={item.href !== '#' && !item.prompt && isActive(item.href)}
                label={t(`item.${item.key}`)}
                soonLabel={t('soon')}
                onNavigate={onNavigate}
              />
            ))}
          </section>
        ))}


        {/*
          Conversations, under the navigation and grouped by when they were last
          active. A flat list of forty titles is a wall; "today" and "yesterday"
          are how people actually remember where a conversation was.
        */}
        {!collapsed && conversations.length > 0 && (
          <section className="flex flex-col gap-1">
            {conversations.length > 5 && (
              <label className="mb-1 flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-muted focus-within:border-primary">
                <Search className="size-3.5 shrink-0" aria-hidden />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('searchChats')}
                  aria-label={t('searchChats')}
                  className="w-full min-w-0 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
                />
              </label>
            )}

            {matches === 0 && <p className="px-2 py-1 text-xs text-muted">{t('noMatches')}</p>}

            {GROUP_ORDER.map((key) =>
              groups[key].length === 0 ? null : (
                <div key={key} className="flex flex-col gap-0.5 pb-2">
                  <h2 className="px-2 text-xs font-medium text-muted">
                    {hydrated ? t(`group.${key}`) : t('recent')}
                  </h2>
                  {groups[key].map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              ),
            )}
          </section>
        )}
      </div>

      {/* Account */}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        {!collapsed && (
          <>
            <div className="flex items-center gap-2.5 px-1">
              <span
                aria-hidden
                className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent"
              >
                {userName.trim().charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm leading-tight text-ink">{userName}</p>
                <p className="truncate text-xs text-muted">{userEmail}</p>
              </div>
            </div>
            {/* Here rather than in a page footer, so they are reachable from the chat too. */}
            <div className="flex items-center gap-2 px-1">
              <ThemeToggle />
              <LocaleSwitcher />
            </div>
          </>
        )}

        <div className={cn('flex gap-1', collapsed ? 'flex-col items-center' : 'flex-wrap items-center')}>
          {[
            ...ACCOUNT_LINKS.map((link) => ({ ...link, label: t(`item.${link.key}`) })),
            ...(isAdmin ? [{ href: '/admin', key: 'admin', icon: Shield, label: tn('admin') }] : []),
          ].map(({ href, key, icon: Icon, label }) => (
            <Link
              key={key}
              href={href}
              onClick={onNavigate}
              title={label}
              aria-label={label}
              aria-current={isActive(href) ? 'page' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-subtle hover:text-ink',
                isActive(href) && 'bg-subtle text-ink',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {!collapsed && <span className="truncate">{label}</span>}
            </Link>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void signOut({ callbackUrl: '/' })}
          className={cn(
            'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-subtle hover:text-ink',
            collapsed && 'justify-center px-0',
          )}
          title={collapsed ? tn('logout') : undefined}
        >
          <LogOut className="size-4 shrink-0" aria-hidden />
          {!collapsed && tn('logout')}
        </button>
      </div>
    </div>
  );
}

/**
 * One conversation in the sidebar, with a way to delete it.
 *
 * There was a `MoreHorizontal` icon here that appeared on hover and did
 * nothing. It looked like an actions menu, which is worse than no affordance at
 * all: a user reported being unable to delete old chats, and the reason was an
 * icon promising a menu that had never been built. The deletion itself — the
 * service, the route, the soft delete — had existed since conversations were
 * first persisted.
 *
 * **Deleting archives rather than destroys.** A researcher who deletes a thread
 * and then realises the answer mattered should be able to get it back, and an
 * accidental click should not be irreversible. The messages stay; the
 * conversation leaves the list.
 */
function ConversationRow({
  conversation,
  onNavigate,
}: {
  conversation: ConversationSummary;
  onNavigate?: () => void;
}) {
  const t = useTranslations('sidebar');
  const router = useRouter();
  /* Which thread is open lives in the query string, not the path. */
  const isOpen = useSearchParams().get('c') === conversation.id;
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [hidden, setHidden] = useState(false);
  /*
   * Renaming exists in the service and the route and had no control, like
   * deletion before it. Titles come from the first message, which is right
   * most of the time and wrong often enough — a thread that began "quick
   * question" and became a chapter needs a name the researcher chose.
   */
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(conversation.title ?? '');

  async function remove() {
    setDeleting(true);

    try {
      const response = await fetch(`/api/conversations/${conversation.id}`, { method: 'DELETE' });

      if (!response.ok) {
        setDeleting(false);
        setConfirming(false);
        return;
      }

      /*
       * Hidden immediately, then the server list is refreshed. Waiting for the
       * refresh leaves the row on screen for a moment after the click, which
       * reads as the button not working — the complaint that led here.
       */
      setHidden(true);
      router.refresh();
    } catch {
      setDeleting(false);
      setConfirming(false);
    }
  }

  async function rename() {
    const trimmed = title.trim();

    if (!trimmed || trimmed === conversation.title) {
      setRenaming(false);
      return;
    }

    try {
      const response = await fetch(`/api/conversations/${conversation.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rename', title: trimmed }),
      });

      if (!response.ok) {
        /* Reverted, so the row never shows a name the server did not accept. */
        setTitle(conversation.title ?? '');
      }
    } catch {
      setTitle(conversation.title ?? '');
    } finally {
      setRenaming(false);
      router.refresh();
    }
  }

  if (hidden) return null;

  if (renaming) {
    return (
      <input
        value={title}
        onChange={(change) => setTitle(change.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void rename();
          if (event.key === 'Escape') {
            setTitle(conversation.title ?? '');
            setRenaming(false);
          }
        }}
        autoFocus
        maxLength={200}
        className="w-full rounded-lg border border-accent bg-ground px-2 py-1.5 text-sm text-ink outline-none"
      />
    );
  }

  return (
    <div className="group relative flex items-center">
      <Link
        href={{ pathname: '/chat', query: { c: conversation.id } }}
        onClick={onNavigate}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm',
          isOpen ? 'bg-subtle text-ink' : 'text-ink-soft hover:bg-subtle hover:text-ink',
        )}
        aria-current={isOpen ? 'page' : undefined}
      >
        <span className="truncate">{conversation.title ?? t('untitled')}</span>
      </Link>

      {confirming ? (
        /*
         * Confirmation inline rather than in a dialog. A modal for a reversible
         * action is heavier than the action deserves, and the two buttons here
         * are unambiguous.
         */
        <span className="flex shrink-0 items-center gap-1 pe-1">
          <button
            type="button"
            onClick={() => void remove()}
            disabled={deleting}
            aria-label={t('confirmDelete')}
            className="rounded p-1 text-danger hover:bg-subtle disabled:opacity-50"
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            aria-label={t('cancelDelete')}
            className="rounded p-1 text-muted hover:bg-subtle hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </span>
      ) : (
        <span className="absolute end-1 flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={() => setRenaming(true)}
            aria-label={t('renameConversation')}
            className="rounded p-1 text-muted hover:bg-subtle hover:text-ink"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label={t('deleteConversation')}
          /*
           * Hidden until hover or focus, so the list stays readable — but
           * reachable by keyboard, which `focus-visible` is for.
           */
            className="rounded p-1 text-muted hover:bg-subtle hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </button>
        </span>
      )}
    </div>
  );
}

function NavLink({
  item,
  collapsed,
  active,
  label,
  soonLabel,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
  label: string;
  soonLabel: string;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;

  const shared = cn(
    'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm',
    collapsed && 'justify-center px-0',
  );

  /*
   * Not a link. A disabled anchor still receives clicks, still appears in the
   * tab order, and still tells a screen reader it goes somewhere — which is
   * three ways of implying a feature works when it does not.
   */
  if (item.soon) {
    return (
      <span
        className={cn(shared, 'cursor-default text-muted/60')}
        title={collapsed ? `${label} — ${soonLabel}` : undefined}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        {!collapsed && (
          <>
            <span>{label}</span>
            <span className="ms-auto rounded bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-muted">
              {soonLabel}
            </span>
          </>
        )}
      </span>
    );
  }

  return (
    <Link
      href={
        item.prompt
          ? { pathname: item.href, query: { prompt: item.prompt } }
          : item.href
      }
      onClick={onNavigate}
      className={cn(
        shared,
        active ? 'bg-accent-soft text-accent' : 'text-ink-soft hover:bg-subtle hover:text-ink',
      )}
      title={collapsed ? label : undefined}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {!collapsed && label}
    </Link>
  );
}
