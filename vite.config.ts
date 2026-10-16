import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: false,
    endOfLine: 'lf',
    ignorePatterns: ['**/dist/**', 'coverage/**', 'pnpm-lock.yaml'],
  },
  lint: {
    plugins: ['typescript'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: ['**/dist/**', 'coverage/**'],
    overrides: [
      {
        files: ['apps/engine/src/**', 'apps/editor-ui/src/**', 'packages/ui-components/src/**'],
        env: { browser: true, node: false },
      },
      {
        files: ['apps/editor-server/**', 'tests/**', '**/vite.config.ts'],
        env: { node: true },
      },
      {
        files: [
          'packages/schemas/src/**',
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
