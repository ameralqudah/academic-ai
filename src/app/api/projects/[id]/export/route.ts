import { getTranslations } from 'next-intl/server';

import { SECTION_KEYS } from '@/config/research';
import { sectionI18nKey } from '@/lib/sections';
import { withApi } from '@/server/http/api';
import { exportProjectDocx } from '@/server/services/export.service';

export const maxDuration = 60;

type Params = { id: string };

export const POST = withApi<undefined, Params>(
  { rateLimit: { key: 'export', max: 20, windowSeconds: 600 } },
  async ({ user, params, request }) => {
    const locale = new URL(request.url).searchParams.get('locale') === 'en' ? 'en' : 'ar';
    const ts = await getTranslations({ locale, namespace: 'sections' });
    const td = await getTranslations({ locale, namespace: 'documents' });

    const sectionLabels = Object.fromEntries(
      SECTION_KEYS.map((key) => [sectionI18nKey(key), ts(sectionI18nKey(key))]),
    );

    const { buffer, filename } = await exportProjectDocx({
      projectId: params.id,
      userId: user.id,
      sectionLabels,
      referencesLabel: td('references'),
      unverifiedLabel: td('unverified'),
    });

    return new Response(new Uint8Array(buffer), {
      headers: {
        'content-type':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'cache-control': 'no-store',
      },
    });
  },
);
