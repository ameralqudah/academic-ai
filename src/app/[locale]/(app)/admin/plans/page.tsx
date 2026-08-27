import { getTranslations } from 'next-intl/server';

import { PlanEditor } from '@/components/admin/plan-editor';
import { listPlans } from '@/server/services/admin.service';

export default async function AdminPlansPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'admin' });
  const plans = await listPlans();

  if (plans.length === 0) {
    return <p className="surface-card p-6 text-sm text-muted">{t('empty')}</p>;
  }

  return (
    <div className="flex flex-col gap-5">
      {plans.map((plan) => (
        <PlanEditor
          key={plan.id}
          plan={{
            id: plan.id,
            code: plan.code,
            name: locale === 'ar' ? plan.nameAr : plan.nameEn,
            priceCents: plan.priceCents,
            maxProjects: plan.maxProjects,
            maxAiRequests: plan.maxAiRequests,
            maxGeneratedWords: plan.maxGeneratedWords,
            maxExports: plan.maxExports,
            toolAccess: plan.toolAccess ?? {},
            isActive: plan.isActive,
            externalPriceId: plan.externalPriceId,
          }}
        />
      ))}
    </div>
  );
}
