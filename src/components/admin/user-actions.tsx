'use client';

import { Loader2, Shield, ShieldOff, UserCheck, UserX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';

export function UserActions({
  userId,
  status,
  role,
  isSelf,
}: {
  userId: string;
  status: 'ACTIVE' | 'SUSPENDED';
  role: 'USER' | 'ADMIN';
  isSelf: boolean;
}) {
  const t = useTranslations('admin.actions');
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function patch(payload: Record<string, unknown>) {
    setPending(true);
    await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ...payload }),
    });
    setPending(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap justify-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending || isSelf}
        onClick={() => patch({ status: status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' })}
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : status === 'ACTIVE' ? (
          <UserX className="size-3.5" aria-hidden />
        ) : (
          <UserCheck className="size-3.5" aria-hidden />
        )}
        {status === 'ACTIVE' ? t('suspend') : t('activate')}
      </Button>

      <Button
        size="sm"
        variant="ghost"
        disabled={pending || isSelf}
        onClick={() => patch({ role: role === 'ADMIN' ? 'USER' : 'ADMIN' })}
      >
        {role === 'ADMIN' ? (
          <ShieldOff className="size-3.5" aria-hidden />
        ) : (
          <Shield className="size-3.5" aria-hidden />
        )}
        {role === 'ADMIN' ? t('removeAdmin') : t('makeAdmin')}
      </Button>
    </div>
  );
}
