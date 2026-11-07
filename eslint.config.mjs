import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// jsx-a11y ships inside eslint-config-next; reuse that instance instead of importing an undeclared dependency.
const jsxA11y = nextVitals.find((c) => c.plugins && c.plugins['jsx-a11y'])?.plugins['jsx-a11y'];

// No ad-hoc `style` in the Studio. Components in app/studio/ui/** never take a style prop; every other Studio file
// may only set CSS custom properties (string keys such as '--progress'), the way dynamic values reach the
// stylesheet. Screens written before the UI system are listed below with the date they were listed; the tab passes
// move their spacing and colour into classes and drop them from this list.
// Positions computed at run time (mindmap, calendar, menus) stay allowed only in their listed files.
export const STYLE_ALLOW_LIST_DATE = '2026-11-06';
export const STYLE_ALLOW_LIST = [
  'app/studio/Autopilot.tsx',
  'app/studio/Keys.tsx',
  'app/studio/MemoryMindmap.tsx',
  'app/studio/Pipelines.tsx',
  'app/studio/Projects.tsx',
  'app/studio/Select.tsx',
  'app/studio/UploadPostPicker.tsx',
  'app/studio/Workspace.tsx',
  'app/studio/loaders.tsx',
];
const STYLE_VALUE = "JSXAttribute[name.name='style'] > JSXExpressionContainer";
const STYLE_OBJECT = `${STYLE_VALUE} > ObjectExpression`;
const STYLE_MESSAGE = 'Use a class from studio.css or ui/ui.css. Inline styles may only set CSS custom properties.';

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
    files: ['app/studio/**/*.tsx'],
    ignores: STYLE_ALLOW_LIST,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[STYLE_OBJECT, `${STYLE_VALUE} > TSAsExpression > ObjectExpression`].flatMap((obj) => [
          { selector: `${obj} > Property[key.type!='Literal']`, message: STYLE_MESSAGE },
          { selector: `${obj} > Property[key.type='Literal']:not([key.value=/^--/])`, message: STYLE_MESSAGE },
          { selector: `${obj} > SpreadElement`, message: STYLE_MESSAGE },
        ]),
        { selector: `${STYLE_VALUE} > :not(ObjectExpression, TSAsExpression)`, message: STYLE_MESSAGE },
        { selector: `${STYLE_VALUE} > TSAsExpression > :not(ObjectExpression, TSTypeReference, TSQualifiedName)`, message: STYLE_MESSAGE },
      ],
    },
  },
  {
    // The components themselves: no style prop at all.
    files: ['app/studio/ui/**/*.tsx'],
    rules: {
      'react/forbid-dom-props': ['error', { forbid: [{ propName: 'style', message: 'UI components style through ui/ui.css only.' }] }],
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**', 'test-results/**', 'next-env.d.ts', 'data/**', 'desktop/**'],
  },
];

export default config;
