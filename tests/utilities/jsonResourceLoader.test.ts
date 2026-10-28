import { gameSchema } from '@ancadeba/schemas'
import { JsonResourceLoader, type ILogger, type IResourceSource } from '@ancadeba/utilities'
import { describe, expect, it, vi } from 'vite-plus/test'

function gameDefinition(title: string) {
  return {
    'schema-version': '1.0.0' as const,
    id: 'test-game',
    title,
    description: 'Test game',
    version: '1.0.0',
    scenes: [] as string[],
  }
}

function createLoader() {
  const source = {
    readText: vi.fn<IResourceSource['readText']>(),
    readBytes: vi.fn<IResourceSource['readBytes']>(),
  } satisfies IResourceSource
  const logger = {
    debug: vi.fn<ILogger['debug']>(() => ''),
    info: vi.fn<ILogger['info']>(() => ''),
    warn: vi.fn<ILogger['warn']>(() => ''),
    error: vi.fn<ILogger['error']>(() => ''),
  } satisfies ILogger

  return { source, logger, loader: new JsonResourceLoader(source, logger) }
}

describe('JsonResourceLoader', () => {
  it('loads and validates JSON from a source without HTTP or URL dependencies', async () => {
    const { source, loader } = createLoader()
    const game = gameDefinition('Demo')
    source.readText.mockResolvedValue(JSON.stringify(game))

    await expect(loader.load('definitions/game.json', gameSchema)).resolves.toEqual(game)
    expect(source.readText).toHaveBeenCalledExactlyOnceWith('definitions/game.json')
    expect(source.readBytes).not.toHaveBeenCalled()
  })

  it('preserves source errors and logs the resource path', async () => {
    const { source, logger, loader } = createLoader()
    const error = new Error('Resource unavailable')
    source.readText.mockRejectedValue(error)

    await expect(loader.load('game.json', gameSchema)).rejects.toBe(error)
    expect(logger.error).toHaveBeenCalledWith(
      'JsonResourceLoader',
      expect.any(String),
      'game.json',
      error.message,
    )
  })

  it('rejects malformed JSON', async () => {
    const { source, loader } = createLoader()
    source.readText.mockResolvedValue('invalid JSON')

    await expect(loader.load('game.json', gameSchema)).rejects.toBeInstanceOf(SyntaxError)
  })

  it('rejects JSON that does not satisfy the supplied schema', async () => {
    const { source, loader } = createLoader()
    source.readText.mockResolvedValue('[]')

    await expect(loader.load('game.json', gameSchema)).rejects.toThrow(
      'JSON from path game.json does not match the expected schema',
    )
  })
})
