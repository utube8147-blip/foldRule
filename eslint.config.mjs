import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import unusedImports from 'eslint-plugin-unused-imports';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: { 'unused-imports': unusedImports },
    rules: {
      // `npm run lint -- --fix` removes unused imports automatically.
      'unused-imports/no-unused-imports': 'warn',
      // Existing code uses `any` heavily around pdf.js / canvas interop.
      // Keep visible as warnings and tighten file-by-file.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // React Compiler readiness rules. The app does not use the compiler and
      // relies on ref-sync patterns these flag, so surface them as warnings.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/use-memo': 'warn',
      'react/no-unescaped-entities': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
    },
  },
  {
    // Lab/test-bench code: prototypes, linted leniently.
    files: ['app/(test)/**', 'components/test/**', 'workers/**', 'components/ui/**'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'prefer-const': 'warn',
    },
  },
  globalIgnores([
    '.next/**', 'out/**', 'node_modules/**', 'next-env.d.ts',
    'public/**', 'lib/generate_boq.py', 'workers/svgPathUtils.js',
  ]),
]);
