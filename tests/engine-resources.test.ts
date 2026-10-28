import { describe, expect, it, vi } from 'vite-plus/test'
import { gameSchema } from '@ancadeba/schemas'
import { HttpGameResources } from '../apps/engine/src/gameResources.js'
import { loadRuntimeConfig } from '../apps/engine/src/config.js'
import { ContainerBuilder } from '../apps/engine/src/ioc/containerBuilder.js'

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

function gameData(title: string) {
  return {
    id: 'test-game',
    title,
    description: 'Test game',
    version: '1.0.0',
    scenes: new Map(),
  }
}

describe('engine game resources', () => {
  const host = { mount: () => () => {} }

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
    '',
    '../secret',
    '/secret',
    '//other.example/secret',
    'https://other.example/file',
    'a/../../secret',
    'a\\secret',
    'a\0b',
  ])('rejects escaped or invalid resource paths %j', async (path) => {
    const fetcher = vi.fn<typeof fetch>()
    const resources = new HttpGameResources('/game/', 'https://engine.example/', fetcher)
    await expect(resources.fetchResource(path)).rejects.toThrow()
    await expect(resources.readText(path)).rejects.toThrow()
    await expect(resources.readBytes(path)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['%2e%2e/secret', '%2fsecret', '%'])(
    'rejects invalid URL paths in fetchResource %j',
    async (path) => {
      const fetcher = vi.fn<typeof fetch>()
      const resources = new HttpGameResources('/game/', 'https://engine.example/', fetcher)
      await expect(resources.fetchResource(path)).rejects.toThrow()
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it.each(['a/./b', 'a//b', 'a/', 'a\nb', 'a\tb', 'assets/C:file'])(
    'rejects invalid literal paths %j before fetching',
    async (path) => {
      const fetcher = vi.fn<typeof fetch>()
      const resources = new HttpGameResources('/game/', 'https://engine.example/', fetcher)
      await expect(resources.readText(path)).rejects.toThrow()
      await expect(resources.readBytes(path)).rejects.toThrow()
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['dialogue/intro #1.txt', 'dialogue/intro%20%231.txt'],
    ['literal%2f.txt', 'literal%252f.txt'],
    ['assets/100%.txt', 'assets/100%25.txt'],
    ['%2e%2e/secret', '%252e%252e/secret'],
    ['%2fsecret', '%252fsecret'],
    ['assets/..#1.txt', 'assets/..%231.txt'],
    ['assets/query?.txt', 'assets/query%3F.txt'],
    ['assets/Café 🎮.txt', 'assets/Caf%C3%A9%20%F0%9F%8E%AE.txt'],
  ])('reads literal resource path %j without URL interpretation', async (path, encoded) => {
    const bytes = new TextEncoder().encode('Café 🎮')
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes))
    const resources = new HttpGameResources('/game/', 'https://engine.example/', fetcher)

    await expect(resources.readText(path)).resolves.toBe('Café 🎮')
    await expect(resources.readBytes(path)).resolves.toEqual(bytes)
    expect(fetcher.mock.calls).toEqual([
      [`https://engine.example/game/${encoded}`, { cache: 'no-cache' }],
      [`https://engine.example/game/${encoded}`],
    ])
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
    const container = new ContainerBuilder(config, 'https://engine.example/', fetcher, host).build()
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
    const game = gameDefinition('Demo')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(game)))
    const container = new ContainerBuilder(
      { gameUrl },
      'https://engine.example/app/',
      fetcher,
      host,
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
      host,
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
      host,
    ).build()

    await expect(
      container.resolve('jsonResourceLoader').load('../secret.json', gameSchema),
    ).rejects.toThrow('Game resource paths must stay within the game directory')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('resolves the engine with the registered loader, host, logger, and session bus factory', async () => {
    const game = gameDefinition('Container game')
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(game)))
    const cleanup = vi.fn<() => void>()
    const host = { mount: vi.fn().mockReturnValue(cleanup) }
    const container = new ContainerBuilder(
      { gameUrl: '/game/' },
      'https://engine.example/',
      fetcher,
      host,
    ).build()
    const loader = container.resolve('jsonResourceLoader')
    const load = vi.spyOn(loader, 'load')
    const info = vi.spyOn(container.resolve('logger'), 'info')
    const engine = container.resolve('engine')

    expect(container.resolve('engine')).toBe(engine)
    expect(container.resolve('host')).toBe(host)
    expect(engine.messages).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()

    const starting = engine.start()
    const firstBus = engine.messages
    const started = vi.fn()
    firstBus?.subscribe('engine.started', started)
    await starting

    expect(load).toHaveBeenCalledExactlyOnceWith('game.json', gameSchema)
    expect(host.mount).toHaveBeenCalledExactlyOnceWith(gameData('Container game'), {
      input: undefined,
    })
    expect(info).toHaveBeenCalledWith('Engine', 'The engine workspace is ready.')
    expect(started).not.toHaveBeenCalled()
    engine.flushMessages()
    expect(started).toHaveBeenCalledExactlyOnceWith({ game: gameData('Container game') })

    engine.stop()
    await engine.start()
    expect(engine.messages).not.toBe(firstBus)
    expect(load).toHaveBeenCalledTimes(2)
    engine.flushMessages()
    expect(started).toHaveBeenCalledTimes(1)
    engine.stop()
    expect(cleanup).toHaveBeenCalledTimes(2)

    const createMessageBus = container.resolve('createMessageBus')
    expect(createMessageBus()).not.toBe(createMessageBus())
  })

  it('keeps registered engines and their session state isolated between containers', async () => {
    const firstHost = { mount: vi.fn(() => () => {}) }
    const secondHost = { mount: vi.fn(() => () => {}) }
    const first = new ContainerBuilder(
      { gameUrl: '/first/' },
      'https://engine.example/',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(gameDefinition('First')))),
      firstHost,
    ).build()
    const second = new ContainerBuilder(
      { gameUrl: '/second/' },
      'https://engine.example/',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(gameDefinition('Second')))),
      secondHost,
    ).build()
    const firstEngine = first.resolve('engine')
    const secondEngine = second.resolve('engine')
    await Promise.all([firstEngine.start(), secondEngine.start()])
    firstEngine.stop()

    expect(firstEngine).not.toBe(secondEngine)
    expect(first.resolve('jsonResourceLoader')).not.toBe(second.resolve('jsonResourceLoader'))
    expect(firstEngine.messages).not.toBe(secondEngine.messages)
    expect(firstEngine.state).toBe('stopped')
    expect(secondEngine.state).toBe('running')
    expect(firstHost.mount).toHaveBeenCalledExactlyOnceWith(gameData('First'), { input: undefined })
    expect(secondHost.mount).toHaveBeenCalledExactlyOnceWith(gameData('Second'), {
      input: undefined,
    })
    secondEngine.stop()
  })
})
