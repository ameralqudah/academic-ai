import { DrizzleAdapter } from '@auth/drizzle-adapter';
import bcrypt from 'bcryptjs';
import { and, eq, isNull } from 'drizzle-orm';
import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';

import { getEnv } from '@/config/env';
import { db } from '@/server/db';
import { accounts, sessions, users, verificationTokens } from '@/server/db/schema';
import { credentialsSchema } from '@/server/validation/auth';
import { isVerifiedOwner } from './owner';
import { decideOAuthSignIn, signInErrorCode } from './policy';
import { evaluateToken, forgetSessionUser, loadSessionUser, needsCheck } from './session-check';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: 'USER' | 'ADMIN';
      locale: 'ar' | 'en';
      /** Whether the account's email address has been proven. */
      verified: boolean;
    } & DefaultSession['user'];
  }

  interface User {
    role?: 'USER' | 'ADMIN';
    locale?: 'ar' | 'en';
    status?: 'ACTIVE' | 'SUSPENDED';
    emailVerified?: Date | null;
    tokenVersion?: number;
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
          emailVerified: record.emailVerified,
          tokenVersion: record.tokenVersion,
        };
      },
    }),
  ],
  callbacks: {
    /*
     * Google sign-ins are checked before Auth.js links or creates anything.
     * The decision itself is a pure function in `policy.ts`; this only
     * gathers its inputs.
     */
    async signIn({ user, account, profile }) {
      if (account?.provider !== 'google') return true;

      const email = (user.email ?? profile?.email ?? '').toLowerCase();
      const [linked] = await db
        .select({ userId: accounts.userId })
        .from(accounts)
        .where(
          and(
            eq(accounts.provider, account.provider),
            eq(accounts.providerAccountId, account.providerAccountId),
          ),
        )
        .limit(1);

      const [existing] = email
        ? await db
            .select({
              id: users.id,
              passwordHash: users.passwordHash,
              emailVerified: users.emailVerified,
              status: users.status,
            })
            .from(users)
            .where(eq(users.email, email))
            .limit(1)
        : [];

      const decision = decideOAuthSignIn({
        providerEmailVerified: (profile as { email_verified?: boolean } | undefined)?.email_verified === true,
        alreadyLinked: Boolean(linked),
        existing: existing
          ? {
              hasPassword: Boolean(existing.passwordHash),
              emailVerified: Boolean(existing.emailVerified),
              suspended: existing.status === 'SUSPENDED',
            }
          : null,
      });

      if (decision.allow) return true;
      return `/ar/login?error=${signInErrorCode(decision.reason)}`;
    },

    async jwt({ token, user, trigger }) {
      if (user?.id) {
        token.sub = user.id;
        token.role = user.role ?? 'USER';
        token.locale = user.locale ?? 'ar';
        token.ev = Boolean(user.emailVerified);

        // The owner is an administrator by configuration, not by a database
        // row — but only once their address is verified (see `owner.ts`).
        // Persisting it on sign-in keeps the admin list and role badges
        // honest; access itself never depends on this write succeeding.
        if (isVerifiedOwner(user) && token.role !== 'ADMIN') {
          token.role = 'ADMIN';
          await db
            .update(users)
            .set({ role: 'ADMIN' })
            .where(eq(users.id, user.id))
            .catch(() => undefined);
        }
      }

      /*
       * Re-validated against the database at most once a minute, and at once
       * after the user updates their own settings. A suspended account, a
       * missing one, or a token issued before the user's sessions were ended
       * (password change, suspension, demotion) signs out: returning null
       * clears the session cookie.
       */
      const now = Date.now();
      if (token.sub && needsCheck(token, now, trigger === 'update' || Boolean(user?.id))) {
        const signingIn = Boolean(user?.id);
        if (trigger === 'update' || signingIn) forgetSessionUser(token.sub);
        const fresh = await loadSessionUser(token.sub, now);

        /*
         * A sign-in is itself a fresh proof of identity, so it adopts the
         * current version; only sessions issued *before* a bump are ended.
         */
        if (signingIn && fresh) token.tv = fresh.tokenVersion;

        const decision = evaluateToken(token, fresh, now);

        if (decision.action === 'revoke') return null;
        if (decision.action === 'refresh') {
          token.role = decision.patch.role;
          token.locale = decision.patch.locale;
          token.ev = decision.patch.ev;
          token.checkedAt = decision.patch.checkedAt;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      session.user.role = (token.role as 'USER' | 'ADMIN') ?? 'USER';
      session.user.locale = (token.locale as 'ar' | 'en') ?? 'ar';
      session.user.verified = token.ev === true;
      return session;
    },
  },
  events: {
    /*
     * A Google account whose provider has verified the address counts as
     * verified here too — the same proof, from a stronger source than an
     * email link.
     */
    async signIn({ user, account, profile }) {
      if (account?.provider !== 'google' || !user.id) return;
      if ((profile as { email_verified?: boolean } | undefined)?.email_verified !== true) return;

      await db
        .update(users)
        .set({ emailVerified: new Date() })
        .where(and(eq(users.id, user.id), isNull(users.emailVerified)))
        .catch(() => undefined);
    },
  },
});
