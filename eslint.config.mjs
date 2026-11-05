import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// jsx-a11y ships inside eslint-config-next; reuse that instance instead of importing an undeclared dependency.
const jsxA11y = nextVitals.find((c) => c.plugins && c.plugins['jsx-a11y'])?.plugins['jsx-a11y'];

const config = [
  ...nextVitals,
  ...nextTs,
  {
    // The full jsx-a11y recommended set (stricter than the Next.js defaults) for the WCAG 2.1 AA target.
    files: ['**/*.{ts,tsx}'],
    rules: {
      ...(jsxA11y ? jsxA11y.flatConfigs.recommended.rules : {}),
      'jsx-a11y/no-autofocus': ['error', { ignoreNonDOM: true }],
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**', 'test-results/**', 'next-env.d.ts', 'data/**'],
  },
];

export default config;
