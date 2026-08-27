import { DrizzleAdapter } from '@auth/drizzle-adapter';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';

import { getEnv } from '@/config/env';
import { db } from '@/server/db';
import { accounts, sessions, users, verificationTokens } from '@/server/db/schema';
import { credentialsSchema } from '@/server/validation/auth';
import { isOwnerEmail } from './owner';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: 'USER' | 'ADMIN';
      locale: 'ar' | 'en';
    } & DefaultSession['user'];
  }

  interface User {
    role?: 'USER' | 'ADMIN';
    locale?: 'ar' | 'en';
    status?: 'ACTIVE' | 'SUSPENDED';
  }
}

const env = getEnv();

const googleEnabled = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 30 },
  trustHost: true,
  secret: env.AUTH_SECRET,
  pages: {
    signIn: '/ar/login',
    error: '/ar/login',
  },
  providers: [
    ...(googleEnabled
      ? [
          Google({
            clientId: env.AUTH_GOOGLE_ID,
            clientSecret: env.AUTH_GOOGLE_SECRET,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;
        const [record] = await db
          .select()
          .from(users)
          .where(eq(users.email, email.toLowerCase()))
          .limit(1);

        if (!record?.passwordHash) return null;
        if (record.status === 'SUSPENDED') return null;

        const valid = await bcrypt.compare(password, record.passwordHash);
        if (!valid) return null;

        await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, record.id));

        return {
          id: record.id,
          email: record.email,
          name: record.name,
          image: record.image,
          role: record.role,
          locale: record.locale,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user?.id) {
        token.sub = user.id;
        token.role = user.role ?? 'USER';
        token.locale = user.locale ?? 'ar';

        // The owner is an administrator by configuration, not by a database
        // row. Persisting it on sign-in keeps the admin list and role badges
        // honest; access itself never depends on this write succeeding.
        if (isOwnerEmail(user.email) && token.role !== 'ADMIN') {
          token.role = 'ADMIN';
          await db
            .update(users)
            .set({ role: 'ADMIN' })
            .where(eq(users.id, user.id))
            .catch(() => undefined);
        }
      }

      // Re-read role/locale after the user changes them in settings.
      if (trigger === 'update' && token.sub) {
        const [fresh] = await db
          .select({ role: users.role, locale: users.locale, status: users.status })
          .from(users)
          .where(eq(users.id, token.sub))
          .limit(1);
        if (fresh) {
          token.role = fresh.role;
          token.locale = fresh.locale;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      session.user.role = (token.role as 'USER' | 'ADMIN') ?? 'USER';
      session.user.locale = (token.locale as 'ar' | 'en') ?? 'ar';
      return session;
    },
  },
});
