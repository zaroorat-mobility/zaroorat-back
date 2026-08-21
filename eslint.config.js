const { defineConfig, globalIgnores } = require('eslint/config');
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = defineConfig([
  globalIgnores([
    'dist/',
    'coverage/',
    'node_modules/',
    '.husky/_/',
    '**/*.tsbuildinfo',
    // Generated Prisma client — machine-written, lives under src/ so it would
    // otherwise be linted. Produced ~6900 no-undef errors before being ignored.
    'src/generated/',
    // Separate browser app with its own toolchain and its own build output.
    // `dist/` above is anchored to this config's directory, so it does not
    // cover the bundle inside this folder.
    'frontend/',
  ]),

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    files: ['**/*.{ts,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      // Unused vars are errors, but allow the `_` prefix escape hatch for
      // intentionally-ignored params (Fastify handlers take many).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // Config files at the repo root are plain CommonJS scripts.
  {
    files: ['*.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Maintenance CLIs (schema merge/validate, db reset) and seed scripts.
  // These are CommonJS Node scripts whose entire purpose is printing progress
  // to a terminal, so require() and console are correct here — not lapses.
  {
    files: ['scripts/**/*.js', 'prisma/seed/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },

  // Must stay last: turns off every rule that fights Prettier.
  prettier,
]);
