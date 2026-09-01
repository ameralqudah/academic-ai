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
  MessageSquarePlus,
  Pencil,
  Search,
  Settings,
  Shield,
  Sparkles,
  Telescope,
  Trash2,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

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
  {
    key: 'account',
    items: [
      { href: '/billing', key: 'billing', icon: Wallet },
      { href: '/settings', key: 'settings', icon: Settings },
    ],
  },
];

export interface ConversationSummary {
  id: string;
  title: string | null;
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
        'flex h-dvh flex-col gap-4 overflow-hidden border-e border-line bg-surface',
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
            <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
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
          'flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink',
          'hover:border-accent hover:text-accent',
          collapsed && 'justify-center px-0',
        )}
        title={collapsed ? t('newChat') : undefined}
      >
        <MessageSquarePlus className="size-4 shrink-0" aria-hidden />
        {!collapsed && t('newChat')}
      </Link>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
        {/*
          Recent conversations — the part of this sidebar that only became
          possible once conversations were persisted. Before that there was
          nothing to list.
        */}
        {!collapsed && conversations.length > 0 && (
          <section className="flex flex-col gap-1">
            <h2 className="px-2 text-xs font-medium text-muted">{t('recent')}</h2>
            {conversations.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                onNavigate={onNavigate}
              />
            ))}
          </section>
        )}

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
                active={item.href !== '#' && isActive(item.href)}
                label={t(`item.${item.key}`)}
                soonLabel={t('soon')}
                onNavigate={onNavigate}
              />
            ))}
          </section>
        ))}

        {isAdmin && (
          <section className="flex flex-col gap-1">
            <NavLink
              item={{ href: '/admin', key: 'admin', icon: Shield }}
              collapsed={collapsed}
              active={isActive('/admin')}
              label={tn('admin')}
              soonLabel={t('soon')}
              onNavigate={onNavigate}
            />
          </section>
        )}
      </div>

      {/* Account */}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        {!collapsed && (
          <div className="px-2">
            <p className="truncate text-sm text-ink">{userName}</p>
            <p className="truncate text-xs text-muted">{userEmail}</p>
          </div>
        )}
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
          'text-ink-soft hover:bg-subtle hover:text-ink',
        )}
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
