import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['postgres', 'bcryptjs'],
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          /*
           * HSTS. Tells the browser never to reach this origin over plain HTTP
           * again, which closes the window where a first request can be
           * intercepted and downgraded.
           *
           * Two years with subdomains, which is the preload requirement. Only
           * sent over HTTPS — a browser ignores it on an insecure connection,
           * so local development is unaffected.
           */
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
          /*
           * Content Security Policy.
           *
           * The one header that turns an injected script from a compromise into
           * a blocked request. Written explicitly rather than generated because
           * every directive here corresponds to something the application
           * genuinely does, and a policy assembled from guesses either breaks
           * the app or permits everything.
           *
           * `'unsafe-inline'` on scripts is required by Next's hydration, which
           * inlines a bootstrap script without a nonce in this configuration.
           * That is a real weakening and is stated rather than hidden; removing
           * it needs nonce-based CSP, which needs the middleware to generate one
           * per request.
           *
           * `connect-src` lists what the browser is allowed to call: this origin
           * for the API, and the model providers the client never contacts
           * directly — those calls happen server-side, so the list is
           * deliberately short.
           */
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              /* Fonts are self-hosted; the data: form is for inlined subsets. */
              "font-src 'self' data:",
              /* Images from anywhere: search results and citations carry them. */
              "img-src 'self' data: blob: https:",
              "connect-src 'self'",
              /* No plugins, no embedding, no base tag rewriting. */
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              /* Clickjacking, in the modern form that X-Frame-Options replaced. */
              "frame-ancestors 'self'",
              /* Upgrades any stray http:// subresource rather than blocking it. */
              'upgrade-insecure-requests',
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
