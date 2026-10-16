import { describe, expect, it } from 'vite-plus/test'

describe('shared workspace packages', () => {
  it.each([
    '@ancadeba/schemas',
    '@ancadeba/game-runtime',
    '@ancadeba/utilities',
    '@ancadeba/ui-components',
  ])('loads the built export for %s', async (name) => {
    const entryPoint = import.meta.resolve(name)

    expect(entryPoint).toMatch(/\/packages\/[^/]+\/dist\/index\.js$/)
    await expect(import(entryPoint)).resolves.toBeDefined()
  })
})
