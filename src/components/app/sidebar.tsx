'use client';

import {
  BarChart3,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  FolderKanban,
  GraduationCap,
  LayoutDashboard,
  Library,
  LogOut,
  MoreHorizontal,
  Plus,
  Pencil,
  Pin,
  PinOff,
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
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

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

/*
 * One flat list, with the places first and the shortcuts behind "More".
 *
 * The two headed sections put seven rows and two labels above the
 * conversations, which is most of a laptop screen before the first chat. The
 * places a researcher returns to stay in view; the four entries that only seed
 * the composer are one click further away, because the composer itself is
 * already on screen.
 */
const PRIMARY: NavItem[] = [
  { href: '/projects', key: 'projects', icon: FolderKanban },
  /*
   * Points at the files page, which is what "Library" means to a researcher.
   * It pointed at the analysis tool, which inspects a single file — a
   * different question from "what do I have".
   */
  { href: '/files', key: 'library', icon: Library },
  { href: '/analysis', key: 'dataAnalysis', icon: BarChart3 },
  /*
   * This and the three under "More" carry a prompt rather than pointing at a
   * page of their own. The agent already searches Crossref and OpenAlex; a
   * dedicated page would be a second implementation of the same capability,
   * drifting from the first the moment either changed.
   */
  { href: '/chat', key: 'academicSearch', icon: GraduationCap, prompt: 'academicSearchPrompt' },
];

const MORE: NavItem[] = [
  { href: '/chat', key: 'literatureReview', icon: BookOpen, prompt: 'literatureReviewPrompt' },
  /*
   * Built. Whether they are reachable depends on a search provider key, and
   * that is decided by the server rather than hard-coded here — a `soon` flag
   * left in place after the feature shipped is the failure this replaces.
   */
  { href: '/chat', key: 'webSearch', icon: Search, prompt: 'webSearchPrompt' },
  { href: '/chat', key: 'deepResearch', icon: Telescope, prompt: 'deepResearchPrompt' },
];

/**
 * The dashboard, billing and settings live in the account menu at the foot of
 * the sidebar. The dashboard is here because signing in now opens the chat, and
 * a page nothing links to is a page that has been deleted by neglect.
 */
const ACCOUNT_LINKS: { href: string; key: string; icon: LucideIcon }[] = [
  { href: '/dashboard', key: 'dashboard', icon: LayoutDashboard },
  { href: '/billing', key: 'billing', icon: Wallet },
  { href: '/settings', key: 'settings', icon: Settings },
];

export interface ConversationSummary {
  id: string;
  title: string | null;
  /** ISO time of the last activity. Optional so older callers keep working. */
  at?: string;
  pinned?: boolean;
}

type GroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'older';

/* Pinned leads, and a pinned conversation is not repeated under its date. */
const GROUP_ORDER: GroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'older'];

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
  planName,
  isAdmin,
  onNavigate,
}: {
  conversations: ConversationSummary[];
  userName: string;
  userEmail: string;
  /** Shown beside the name, so the plan is visible without opening billing. */
  planName?: string;
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
  /* The search box stays out of the way until it is asked for. */
  const [searching, setSearching] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

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
      pinned: [],
      today: [],
      yesterday: [],
      week: [],
      older: [],
    };

    for (const conversation of conversations) {
      if (needle && !(conversation.title ?? '').toLowerCase().includes(needle)) continue;
      /* Pinning does not depend on the clock, so it is safe before hydration too. */
      const key = conversation.pinned ? 'pinned' : hydrated ? groupOf(conversation.at, now) : 'today';
      result[key].push(conversation);
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
        collapsed ? 'w-16 px-2 py-4' : 'w-72 px-3 py-4',
      )}
    >
      {/* Brand and the collapse control */}
      <div className="flex items-center justify-between gap-2">
        {!collapsed && (
          <Link
            href="/chat"
            onClick={onNavigate}
            className="flex items-center gap-2.5 px-1 text-base font-semibold text-ink"
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
          'flex items-center gap-3 rounded-xl px-2 py-2 text-[15px] font-medium text-primary',
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
        <nav className="flex flex-col gap-0.5">
          {[...PRIMARY, ...(moreOpen || collapsed ? MORE : [])].map((item) => (
            <NavLink
              key={item.key}
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
          {!collapsed && (
            <button
              type="button"
              onClick={() => setMoreOpen((open) => !open)}
              aria-expanded={moreOpen}
              className="flex items-center gap-3 rounded-lg px-2 py-2 text-[15px] text-muted hover:bg-subtle hover:text-ink"
            >
              <ChevronDown
                className={cn('size-[18px] shrink-0 transition-transform', moreOpen && 'rotate-180')}
                aria-hidden
              />
              {moreOpen ? t('less') : t('more')}
            </button>
          )}
        </nav>

        {/*
          Conversations, under the navigation and grouped by when they were last
          active. A flat list of forty titles is a wall; "today" and "yesterday"
          are how people actually remember where a conversation was.
        */}
        {!collapsed && conversations.length > 0 && (
          <section className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-xs font-medium text-muted">{t('chats')}</h2>
              {conversations.length > 5 && (
                <button
                  type="button"
                  onClick={() => {
                    setSearching((open) => !open);
                    setQuery('');
                  }}
                  aria-label={t('searchChats')}
                  aria-expanded={searching}
                  className="rounded-md p-1 text-muted hover:bg-subtle hover:text-ink"
                >
                  {searching ? <X className="size-4" aria-hidden /> : <Search className="size-4" aria-hidden />}
                </button>
              )}
            </div>

            {searching && (
              <label className="mb-1 flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-muted focus-within:border-primary">
                <Search className="size-3.5 shrink-0" aria-hidden />
                <input
                  type="search"
                  autoFocus
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
                    {hydrated || key === 'pinned' ? t(`group.${key}`) : t('recent')}
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

      <AccountMenu
        userName={userName}
        userEmail={userEmail}
        planName={planName}
        collapsed={collapsed}
        links={[
          ...ACCOUNT_LINKS.map((link) => ({ ...link, label: t(`item.${link.key}`) })),
          ...(isAdmin ? [{ href: '/admin', key: 'admin', icon: Shield, label: tn('admin') }] : []),
        ]}
        isActive={isActive}
        onNavigate={onNavigate}
      />
    </div>
  );
}

/**
 * The account, as one row that opens a menu.
 *
 * It was five rows — name, theme and language, billing and settings, admin,
 * sign out — permanently on screen, under a list that needed the room more.
 * None of them is used often enough to earn that. One row says who is signed in
 * and on which plan; the rest is a click away, which is where settings belong.
 */
function AccountMenu({
  userName,
  userEmail,
  planName,
  collapsed,
  links,
  isActive,
  onNavigate,
}: {
  userName: string;
  userEmail: string;
  planName?: string;
  collapsed: boolean;
  links: { href: string; key: string; icon: LucideIcon; label: string }[];
  isActive: (href: string) => boolean;
  onNavigate?: () => void;
}) {
  const t = useTranslations('sidebar');
  const tn = useTranslations('nav');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  /* Close on an outside click or Escape — the two ways anyone dismisses a menu. */
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative border-t border-line pt-3">
      {open && (
        <div
          role="menu"
          className={cn(
            'z-40 flex flex-col gap-1 rounded-xl border border-line bg-surface p-1.5 shadow-lg',
            /*
             * Fixed when collapsed: the rail is 4rem wide and clips its
             * overflow, so a menu positioned inside it would be cut to a sliver.
             */
            collapsed ? 'fixed start-2 bottom-16 w-64' : 'absolute inset-x-0 bottom-full mb-2',
          )}
        >
          <p className="truncate px-2.5 pt-1.5 pb-1 text-xs text-muted">
            <bdi>{userEmail}</bdi>
          </p>

          {/* Here rather than in a page footer, so they are reachable from the chat too. */}
          <div className="flex items-center gap-2 px-1.5 pb-1">
            <ThemeToggle />
            <LocaleSwitcher />
          </div>

          <div className="border-t border-line" />

          {links.map(({ href, key, icon: Icon, label }) => (
            <Link
              key={key}
              href={href}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              aria-current={isActive(href) ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-soft hover:bg-subtle hover:text-ink',
                isActive(href) && 'bg-subtle text-ink',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{label}</span>
            </Link>
          ))}

          <div className="border-t border-line" />

          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut({ callbackUrl: '/' })}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-soft hover:bg-subtle hover:text-ink"
          >
            <LogOut className="size-4 shrink-0" aria-hidden />
            {tn('logout')}
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('accountMenu')}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-start hover:bg-subtle',
          collapsed && 'justify-center px-0',
        )}
      >
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent"
        >
          {userName.trim().charAt(0).toUpperCase()}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-[15px] text-ink">
              {userName}
              {planName && <span className="text-muted"> · {planName}</span>}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted" aria-hidden />
          </>
        )}
      </button>
    </div>
  );
}

/**
 * One conversation in the sidebar, with a way to delete it.
 *
 * There was once a `MoreHorizontal` icon here that appeared on hover and did
 * nothing (the one in `RowMenu` below opens a real menu). It looked like an
 * actions menu, which is worse than no affordance at all: a user reported being
 * unable to delete old chats, and the reason was an icon promising a menu that
 * had never been built. The deletion itself — the
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

  async function togglePin() {
    try {
      await fetch(`/api/conversations/${conversation.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: conversation.pinned ? 'unpin' : 'pin' }),
      });
    } finally {
      /* The list is the server's; refreshing moves the row to where it now belongs. */
      router.refresh();
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
          'flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 ps-2 pe-8 text-sm',
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
        <RowMenu
          pinned={Boolean(conversation.pinned)}
          onPin={() => void togglePin()}
          onRename={() => setRenaming(true)}
          onDelete={() => setConfirming(true)}
        />
      )}
    </div>
  );
}

/**
 * The actions for one conversation, behind a single "more" button.
 *
 * They were three icons that appeared on hover, and a phone has no hover: on a
 * touch screen a conversation could not be pinned, renamed or deleted at all.
 * One button that is always there on touch, and appears on hover or focus with
 * a mouse, reaches the same three actions everywhere — with their names written
 * out, which three 14-pixel icons never managed.
 *
 * The menu is positioned against the viewport rather than the row. The list
 * scrolls inside the sidebar, and anything positioned inside a scrolling box is
 * clipped by it: the menu for the last conversation would open into nothing.
 */
function RowMenu({
  pinned,
  onPin,
  onRename,
  onDelete,
}: {
  pinned: boolean;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('sidebar');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  const MENU_WIDTH = 176;
  const MENU_HEIGHT = 124;

  function toggle() {
    if (place) {
      setPlace(null);
      return;
    }

    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const rtl = document.documentElement.dir === 'rtl';
    const left = rtl ? rect.left : rect.right - MENU_WIDTH;
    /* Upwards when there is no room below — the last rows of a long list. */
    const below = rect.bottom + 4 + MENU_HEIGHT <= window.innerHeight;

    setPlace({
      top: below ? rect.bottom + 4 : rect.top - 4 - MENU_HEIGHT,
      left: Math.max(8, Math.min(left, window.innerWidth - MENU_WIDTH - 8)),
    });
  }

  useEffect(() => {
    if (!place) return;

    const close = () => setPlace(null);

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    /* Fixed to the viewport, so it would be left behind by a scrolling list. */
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [place]);

  const items = [
    { key: 'pin', label: pinned ? t('unpinConversation') : t('pinConversation'), icon: pinned ? PinOff : Pin, run: onPin },
    { key: 'rename', label: t('renameConversation'), icon: Pencil, run: onRename },
    { key: 'delete', label: t('deleteConversation'), icon: Trash2, run: onDelete, danger: true },
  ];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={place !== null}
        aria-label={t('conversationOptions')}
        className={cn(
          'absolute end-1 rounded-md p-1 text-muted transition-opacity hover:bg-surface hover:text-ink',
          /* Always there without a mouse; otherwise on hover, focus, or while open. */
          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
          place && 'opacity-100',
        )}
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>

      {place && (
        <div
          ref={menuRef}
          role="menu"
          style={{ top: place.top, left: place.left, width: MENU_WIDTH }}
          className="fixed z-50 flex flex-col rounded-xl border border-line bg-surface p-1 shadow-lg"
        >
          {items.map(({ key, label, icon: Icon, run, danger }) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              onClick={() => {
                setPlace(null);
                run();
              }}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-subtle',
                danger ? 'text-danger' : 'text-ink-soft hover:text-ink',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      )}
    </>
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
    'flex items-center gap-3 rounded-lg px-2 py-2 text-[15px]',
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
        <Icon className="size-[18px] shrink-0" aria-hidden />
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
      <Icon className="size-[18px] shrink-0" aria-hidden />
      {!collapsed && label}
    </Link>
  );
}
