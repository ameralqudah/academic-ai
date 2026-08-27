import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

/**
 * Flat config (ESLint 9). `eslint-config-next` v16 ships flat config natively,
 * so it is spread in directly — no FlatCompat shim.
 */
export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'drizzle/**',
      'test-results/**',
      'playwright-report/**',
      'next-env.d.ts',
    ],
  },

  ...(Array.isArray(nextCoreWebVitals) ? nextCoreWebVitals : [nextCoreWebVitals]),
  ...tseslint.configs.recommended,

  {
    rules: {
      // `_`-prefixed values are intentionally unused (destructuring, catch args).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      // Server code handles provider payloads whose shape is asserted at the edge.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  {
    // Scripts and E2E specs are tooling, not shipped code.
    files: ['scripts/**/*.ts', 'e2e/**/*.ts', '*.config.{ts,mjs}'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
