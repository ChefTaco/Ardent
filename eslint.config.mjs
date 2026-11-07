import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['**/coverage/**', '**/dist/**', '**/node_modules/**', 'test/generated/**']),
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    rules: {
      'no-debugger': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-unreachable': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
]);
