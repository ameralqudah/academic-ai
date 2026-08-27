/**
 * Seeds the subscription plans and (optionally) a first admin account.
 *
 *   npm run db:push   # create the tables
 *   npm run db:seed
 *
 * Safe to re-run: plans are upserted by `code`, the admin by email.
 */

import 'dotenv/config';

import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';

import { PLAN_SEEDS } from '@/config/plans';

import { db } from './index';
import { planFeatures, subscriptionPlans, userSettings, users } from './schema';

async function seedPlans() {
  for (const seed of PLAN_SEEDS) {
    const [existing] = await db
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.code, seed.code))
      .limit(1);

    const values = {
      code: seed.code,
      nameEn: seed.nameEn,
      nameAr: seed.nameAr,
      descriptionEn: seed.descriptionEn,
      descriptionAr: seed.descriptionAr,
      priceCents: seed.priceCents,
      currency: seed.currency,
      billingInterval: seed.billingInterval,
      maxProjects: seed.maxProjects,
      maxAiRequests: seed.maxAiRequests,
      maxGeneratedWords: seed.maxGeneratedWords,
      maxExports: seed.maxExports,
      toolAccess: seed.toolAccess as Record<string, boolean>,
      sortOrder: seed.sortOrder,
      isActive: true,
      isDefault: seed.isDefault,
    };

    let planId: string;
    if (existing) {
      await db.update(subscriptionPlans).set(values).where(eq(subscriptionPlans.id, existing.id));
      planId = existing.id;
    } else {
      const [created] = await db
        .insert(subscriptionPlans)
        .values(values)
        .returning({ id: subscriptionPlans.id });
      if (!created) throw new Error(`Failed to create plan ${seed.code}`);
      planId = created.id;
    }

    await db.delete(planFeatures).where(eq(planFeatures.planId, planId));
    if (seed.features.length > 0) {
      await db.insert(planFeatures).values(
        seed.features.map((feature, index) => ({
          planId,
          featureKey: feature.key,
          labelEn: feature.labelEn,
          labelAr: feature.labelAr,
          enabled: feature.enabled,
          sortOrder: index,
        })),
      );
    }

    console.log(`✓ plan ${seed.code}`);
  }
}

async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('· skipped admin (set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create one)');
    return;
  }

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    console.log(`· admin ${email} already exists`);
    return;
  }

  const [created] = await db
    .insert(users)
    .values({
      email,
      name: 'Administrator',
      passwordHash: await bcrypt.hash(password, 12),
      role: 'ADMIN',
      emailVerified: new Date(),
    })
    .returning({ id: users.id });

  if (created) {
    await db.insert(userSettings).values({ userId: created.id });
    console.log(`✓ admin ${email}`);
  }
}

async function main() {
  await seedPlans();
  await seedAdmin();
  console.log('\nSeed complete.');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
