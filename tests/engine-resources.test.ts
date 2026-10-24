import { describe, expect, it, vi } from 'vite-plus/test'
import { gameSchema } from '@ancadeba/schemas'
import { HttpGameResources } from '../apps/engine/src/gameResources.js'
import { loadRuntimeConfig } from '../apps/engine/src/config.js'
import { ContainerBuilder } from '../apps/engine/src/ioc/containerBuilder.js'

describe('engine game resources', () => {
  it.each([
    ['/games/demo', 'https://engine.example/app/', 'https://engine.example/games/demo/data.json'],
    ['./game/', 'https://engine.example/app/', 'https://engine.example/app/game/data.json'],
    [
      'https://cdn.example/game',
      'https://engine.example/app/',
      'https://cdn.example/game/data.json',
    ],
  ])('resolves resources for %s', async (base, applicationUrl, expected) => {
    const response = new Response('{}')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
    const resources = new HttpGameResources(base, applicationUrl, fetcher)
    expect(await resources.fetchResource('data.json')).toBe(response)
    expect(fetcher).toHaveBeenCalledWith(expected)
  })

  it('supports nested paths, spaces, and response bytes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array([0, 255, 42])))
    const resources = new HttpGameResources('/game', 'https://engine.example/', fetcher)
    const response = await resources.fetchResource('assets/my sprite.bin')
    expect(fetcher).toHaveBeenCalledWith('https://engine.example/game/assets/my%20sprite.bin')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 42]))
  })

  it('reads UTF-8 text with cache revalidation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Café 🎮'))
    const resources = new HttpGameResources('/game', 'https://engine.example/', fetcher)

    await expect(resources.readText('dialogue/intro.txt')).resolves.toBe('Café 🎮')
    expect(fetcher.mock.contexts).toEqual([undefined])
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      'https://engine.example/game/dialogue/intro.txt',
      { cache: 'no-cache' },
    )
  })

  it('reads binary resources without altering their bytes', async () => {
    const bytes = new Uint8Array([0, 255, 128, 42])
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes))
    const resources = new HttpGameResources('/game', 'https://engine.example/', fetcher)

    await expect(resources.readBytes('assets/sprite.bin')).resolves.toEqual(bytes)
  })

  it.each([
    '../secret',
    '/secret',
    '//other.example/secret',
    'https://other.example/file',
    'a/../../secret',
    '%2e%2e/secret',
    '%2fsecret',
    'a\\secret',
    '%',
    'a\0b',
  ])('rejects escaped or invalid resource paths %j', async (path) => {
    const fetcher = vi.fn<typeof fetch>()
    const resources = new HttpGameResources('/game/', 'https://engine.example/', fetcher)
    await expect(resources.fetchResource(path)).rejects.toThrow()
    await expect(resources.readText(path)).rejects.toThrow()
    await expect(resources.readBytes(path)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['file:///game', 'https://user:pass@example.com/game', '/game?x=1', '/game#x'])(
    'rejects invalid game bases %s',
    (base) => {
      expect(() => new HttpGameResources(base, 'https://engine.example/', vi.fn())).toThrow()
    },
  )

  it('reports HTTP and network failures', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockRejectedValueOnce(new Error('offline'))
    const resources = new HttpGameResources('/game', 'https://engine.example/', fetcher)
    await expect(resources.fetchResource('missing.json')).rejects.toThrow('HTTP 404')
    await expect(resources.fetchResource('data.json')).rejects.toThrow(
      'Could not fetch game resource',
    )
  })

  it('loads deployment-time config from the app base without caching', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ gameUrl: '/games/', port: 1234 })))
    await expect(loadRuntimeConfig('https://engine.example/nested/', fetcher)).resolves.toEqual({
      gameUrl: '/games/',
    })
    expect(fetcher).toHaveBeenCalledWith('https://engine.example/nested/config.json', {
      cache: 'no-store',
    })
  })

  it('rejects unavailable, malformed, and invalid runtime config', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('invalid JSON'))
      .mockResolvedValueOnce(new Response('{}'))
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(loadRuntimeConfig('https://engine.example/', fetcher)).rejects.toThrow()
    }
  })

  it('injects configuration and resource access into isolated engine containers', async () => {
    const config = { gameUrl: '/game' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ready'))
    const container = new ContainerBuilder(config, 'https://engine.example/', fetcher).build()
    expect(container.resolve('config')).toBe(config)
    expect(container.resolve('gameResources')).toBe(container.resolve('gameResources'))
    await expect(container.resolve('gameResources').fetchResource('a.txt')).resolves.toBeInstanceOf(
      Response,
    )
    expect(fetcher).toHaveBeenCalledWith('https://engine.example/game/a.txt')
  })

  it.each([
    ['/game', 'https://engine.example/game/game.json'],
    ['./game/', 'https://engine.example/app/game/game.json'],
    ['https://cdn.example/game/', 'https://cdn.example/game/game.json'],
  ])('loads game.json from %s through the registered JSON loader', async (gameUrl, expectedUrl) => {
    const game = { title: 'Demo', settings: { difficulty: 1 } }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(game)))
    const container = new ContainerBuilder(
      { gameUrl },
      'https://engine.example/app/',
      fetcher,
    ).build()

    await expect(
      container.resolve('jsonResourceLoader').load('game.json', gameSchema),
    ).resolves.toEqual(game)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(expectedUrl, { cache: 'no-cache' })
  })

  it.each([
    ['missing', '', 404],
    ['malformed', 'invalid JSON', 200],
    ['non-object', '[]', 200],
  ])('rejects a %s game.json', async (_reason, body, status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }))
    const container = new ContainerBuilder(
      { gameUrl: '/game/' },
      'https://engine.example/',
      fetcher,
    ).build()

    await expect(
      container.resolve('jsonResourceLoader').load('game.json', gameSchema),
    ).rejects.toThrow()
  })

  it('enforces the game directory boundary when loading JSON through the container', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const container = new ContainerBuilder(
      { gameUrl: '/game/' },
      'https://engine.example/',
      fetcher,
    ).build()

    await expect(
      container.resolve('jsonResourceLoader').load('../secret.json', gameSchema),
    ).rejects.toThrow('Game resource paths must stay within the game directory')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
