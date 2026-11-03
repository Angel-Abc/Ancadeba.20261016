import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: false,
    endOfLine: 'lf',
    ignorePatterns: ['**/dist/**', 'coverage/**', 'pnpm-lock.yaml', 'tools/oxlint/anti-slop/**'],
  },
  lint: {
    plugins: ['typescript'],
    options: {
      typeAware: true,
      typeCheck: true,
      reportUnusedDisableDirectives: 'error',
    },
    ignorePatterns: ['**/dist/**', 'coverage/**', 'tools/oxlint/anti-slop/**'],
    jsPlugins: [{ name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' }],
    // Preserve boundary parsing and dynamic JSON contracts; enforce type evidence and spacing.
    rules: {
      'anti-slop/no-chained-type-assertions': 'error',
      'anti-slop/no-known-value-widening': 'error',
      'anti-slop/no-module-mocking': 'error',
      'anti-slop/no-object-parameters': 'error',
      'anti-slop/no-reflect-apply': 'error',
      'anti-slop/no-reflect-get': 'error',
      'anti-slop/no-widen-then-assert': 'error',
      'anti-slop/require-readable-spacing': 'error',
      'anti-slop/require-safety-comment-for-type-assertion': 'error',
    },
    overrides: [
      {
        files: ['apps/engine/src/**', 'apps/editor-ui/src/**', 'packages/ui-components/src/**'],
        env: { browser: true, node: false },
      },
      {
        files: [
          'apps/editor-server/**',
          'apps/editor-mcp/**',
          'apps/engine/tooling/**',
          'tooling/**',
          'tests/**',
          '**/vite.config.ts',
        ],
        env: { node: true },
      },
      {
        files: [
          'packages/schemas/src/**',
          'packages/editor-core/src/**',
          'packages/game-runtime/src/**',
          'packages/utilities/src/**',
        ],
        env: { browser: false, node: false },
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
