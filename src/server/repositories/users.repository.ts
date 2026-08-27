import { eq } from 'drizzle-orm';

import { db } from '@/server/db';
import { userSettings, users, type NewUser, type User } from '@/server/db/schema';

export async function findByEmail(email: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return row;
}

export async function findById(id: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

export async function createUser(values: NewUser): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({ ...values, email: values.email.toLowerCase() })
    .returning();
  if (!row) throw new Error('Failed to create user');
  return row;
}

export async function updateUser(id: string, values: Partial<NewUser>): Promise<void> {
  await db.update(users).set(values).where(eq(users.id, id));
}

export async function ensureSettings(userId: string) {
  const [existing] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db.insert(userSettings).values({ userId }).returning();
  if (!created) throw new Error('Failed to create user settings');
  return created;
}

export async function updateSettings(
  userId: string,
  values: Partial<typeof userSettings.$inferInsert>,
) {
  await db.update(userSettings).set(values).where(eq(userSettings.userId, userId));
}
