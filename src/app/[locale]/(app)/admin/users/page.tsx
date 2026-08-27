import { Search } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';

import { UserActions } from '@/components/admin/user-actions';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { requirePageAdmin } from '@/server/auth/guards';
import { users } from '@/server/services/admin.service';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ search?: string; page?: string }>;
};

export default async function AdminUsersPage({ params, searchParams }: Props) {
  const { locale } = await params;
  const { search, page } = await searchParams;
  const admin = await requirePageAdmin(locale);

  const t = await getTranslations({ locale, namespace: 'admin' });
  const format = await getFormatter({ locale });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US');

  const result = await users({
    search,
    page: Number(page ?? '1') || 1,
    pageSize: 25,
  });

  return (
    <div className="flex flex-col gap-4">
      <form className="flex items-center gap-2" action="" method="get">
        <div className="relative flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted"
            aria-hidden
          />
          <input
            type="search"
            name="search"
            defaultValue={search ?? ''}
            placeholder={t('actions.search')}
            className="w-full rounded-lg border border-line bg-surface py-2.5 ps-9 pe-3 text-sm text-ink placeholder:text-muted/70 focus:border-primary focus:ring-2 focus:ring-primary/25 focus:outline-none"
          />
        </div>
      </form>

      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className="px-4 py-3 text-start font-medium">{t('table.user')}</th>
                <th className="px-4 py-3 text-start font-medium">{t('table.plan')}</th>
                <th className="px-4 py-3 text-start font-medium">{t('table.status')}</th>
                <th className="px-4 py-3 text-end font-medium">{t('table.projects')}</th>
                <th className="px-4 py-3 text-start font-medium">{t('table.joined')}</th>
                <th className="px-4 py-3 text-start font-medium">{t('table.lastLogin')}</th>
                <th className="px-4 py-3 text-end font-medium">{t('table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted">
                    {t('empty')}
                  </td>
                </tr>
              ) : (
                result.rows.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-3">
                      <div className="flex flex-col">
                        <span className="font-medium text-ink">
                          {row.name ?? t('table.none')}
                          {row.role === 'ADMIN' ? (
                            <Badge tone="upgrade" className="ms-2">
                              {t('table.role')}
                            </Badge>
                          ) : null}
                        </span>
                        <span dir="ltr" className="text-xs text-muted">
                          {row.email}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={row.planCode === 'PRO' ? 'upgrade' : 'neutral'}>
                        {row.planCode ?? t('table.none')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={row.status === 'ACTIVE' ? 'success' : 'danger'}>
                        {row.status}
                      </Badge>
                    </td>
                    <td className="tabular px-4 py-3 text-end">{number.format(row.projects)}</td>
                    <td className="px-4 py-3 text-muted">
                      {format.dateTime(row.createdAt, { dateStyle: 'medium' })}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {row.lastLoginAt
                        ? format.dateTime(row.lastLoginAt, { dateStyle: 'medium' })
                        : t('table.never')}
                    </td>
                    <td className="px-4 py-3">
                      <UserActions
                        userId={row.id}
                        status={row.status}
                        role={row.role}
                        isSelf={row.id === admin.id}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {result.pages > 1 ? (
        <nav className="flex items-center justify-between gap-3 text-sm">
          <Link
            href={`/admin/users?page=${Math.max(1, result.page - 1)}${search ? `&search=${encodeURIComponent(search)}` : ''}`}
            aria-disabled={result.page <= 1}
            className={
              result.page <= 1
                ? 'pointer-events-none text-muted opacity-50'
                : 'text-primary hover:underline'
            }
          >
            {t('actions.previous')}
          </Link>
          <span className="tabular text-muted">
            {t('actions.pageOf', { page: result.page, pages: result.pages })}
          </span>
          <Link
            href={`/admin/users?page=${Math.min(result.pages, result.page + 1)}${search ? `&search=${encodeURIComponent(search)}` : ''}`}
            aria-disabled={result.page >= result.pages}
            className={
              result.page >= result.pages
                ? 'pointer-events-none text-muted opacity-50'
                : 'text-primary hover:underline'
            }
          >
            {t('actions.next')}
          </Link>
        </nav>
      ) : null}
    </div>
  );
}
