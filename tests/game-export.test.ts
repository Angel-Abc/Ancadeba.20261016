import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite-plus'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { loadRuntimeConfig } from '../apps/engine/src/config.js'
import { ContainerBuilder } from '../apps/engine/src/ioc/containerBuilder.js'
import { HttpGameResources } from '../apps/engine/src/gameResources.js'
import { exportGame } from '../tooling/game-export.js'
import {
  Engine,
  GameLoader,
  resolveGraphic,
  validateImageSource,
  type EngineMessages,
} from '@ancadeba/game-runtime'
import { JsonResourceLoader, MessageBus, type ILogger } from '@ancadeba/utilities'
import { graphicAppearanceSchema } from '@ancadeba/schemas'

const input = {
  'schema-version': '1.0.0',
  'virtual-keys': ['north'],
  keyboard: { KeyW: 'north', ArrowUp: 'north' },
  contexts: { gameplay: { north: 'moveNorth' } },
  'initial-context': 'gameplay',
}

const scene = {
  'schema-version': '1.0.0',
  id: 'start-screen',
  title: 'Start Screen',
  description: '',
  type: 'stand-alone',
  screen: { type: 'grid', grid: { rows: 20, columns: 20 } },
  components: [],
}

function gameDefinition(title: string) {
  return {
    'schema-version': '1.0.0' as const,
    id: 'test-game',
    title,
    description: 'Test game',
    version: '1.0.0',
    scenes: ['start-screen'],
  }
}

function gameData(title: string) {
  return {
    id: 'test-game',
    title,
    description: 'Test game',
    version: '1.0.0',
    input: {
      virtualKeys: input['virtual-keys'],
      keyboard: input.keyboard,
      contexts: input.contexts,
      initialContext: input['initial-context'],
    },
    scenes: new Map([
      [
        'start-screen',
        {
          id: scene.id,
          title: scene.title,
          description: scene.description,
          type: scene.type,
          screen: scene.screen,
          components: [],
        },
      ],
    ]),
  }
}

describe('standalone game export', () => {
  let temp: string
  let source: string

  const game = {
    ...gameDefinition('Export test'),
    input: 'controls',
  }

  const bytes = new Uint8Array([0, 255, 128, 42])
  const literalPaths = ['assets/intro #1.txt', 'assets/literal%2f.txt', 'assets/100%.txt']

  beforeAll(async () => {
    temp = await mkdtemp(fileURLToPath(new URL('./.tmp-game-export-', import.meta.url)))
    source = join(temp, 'source')
    await mkdir(join(source, 'assets/dialogue'), { recursive: true })
    await mkdir(join(source, '.git'))
    await mkdir(join(source, 'node_modules'))
    await mkdir(join(source, 'scenes'))
    await mkdir(join(source, 'input'))
    await writeFile(join(source, 'game.json'), JSON.stringify(game))
    await writeFile(join(source, 'input/controls.json'), JSON.stringify(input))
    await writeFile(join(source, 'scenes/start-screen.json'), JSON.stringify(scene))
    await writeFile(join(source, 'assets/my sprite.bin'), bytes)
    await writeFile(join(source, 'assets/dialogue/intro.txt'), 'Café 🎮')

    for (const path of literalPaths) await writeFile(join(source, path), 'Café 🎮')
    await writeFile(join(source, 'index.html'), '<title>Game asset</title>')
    await writeFile(join(source, '.env'), 'LOCAL_SETTING=private')
    await writeFile(join(source, '.env.local'), 'LOCAL_SETTING=private')
    await writeFile(join(source, '.git/config'), 'source control metadata')
    await writeFile(join(source, 'node_modules/dependency.js'), 'development dependency')
  })

  afterAll(async () => {
    await rm(temp, { recursive: true, force: true })
  })

  it('packages language catalogs and validates languages beyond the configured default', async () => {
    const localized = join(temp, 'localized')
    const output = join(temp, 'localized-export')
    await cp(new URL('../sample-games/localized/', import.meta.url), localized, { recursive: true })
    await exportGame({ gameDirectory: localized, outputDirectory: output })
    expect(
      JSON.parse(await readFile(join(output, 'game/languages/nl/messages.json'), 'utf8')),
    ).toHaveProperty('welcome.greeting', 'Hallo, avonturier!')

    await writeFile(
      join(localized, 'languages/nl/messages.json'),
      JSON.stringify({ 'welcome.again': '' }),
    )
    const invalidOutput = join(temp, 'invalid-language-export')
    await expect(
      exportGame({ gameDirectory: localized, outputDirectory: invalidOutput }),
    ).rejects.toThrow('language catalog')
    await expect(readFile(join(invalidOutput, 'index.html'))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    )
  })

  it('exports the graphics sample, relocates it under a nested URL, and validates every artwork source', async () => {
    const gameDirectory = join(temp, 'graphics-source')
    await cp(new URL('../sample-games/graphics/', import.meta.url), gameDirectory, {
      recursive: true,
    })
    const destination = join(temp, 'graphics-output')
    await exportGame({ gameDirectory, outputDirectory: destination })
    const relocated = join(temp, 'graphics-relocated')
    await rename(destination, relocated)

    const server = await preview({
      configFile: false,
      root: temp,
      base: '/nested/graphics/',
      logLevel: 'silent',
      build: { outDir: relocated },
      preview: { host: '127.0.0.1', port: 0, strictPort: true },
    })

    try {
      // SAFETY: Vite preview was configured to listen on a loopback TCP port.
      const address = server.httpServer.address() as AddressInfo
      const base = `http://127.0.0.1:${address.port}/nested/graphics/`
      const config = await loadRuntimeConfig(base, fetch)
      const resources = new HttpGameResources(config.gameUrl, base, fetch)
      const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }
      const loaded = await new GameLoader(new JsonResourceLoader(resources, logger)).load()
      expect(loaded.assets?.parts.cloak?.pieces).toHaveLength(2)
      expect(loaded.inventory?.items['moss-cloak']?.placement).toEqual({
        type: 'inside',
        container: 'travel-pack',
      })
      expect(loaded.scenes.get('wardrobe')?.components[0]?.type).toBe('inventory')

      for (const image of Object.values(loaded.assets!.images)) {
        const bytes = await resources.readBytes(image.source)
        expect(() =>
          validateImageSource(image, bytes, new TextDecoder().decode(bytes)),
        ).not.toThrow()
      }

      expect(
        resolveGraphic(loaded.assets!, 'paper-doll', graphicAppearanceSchema.parse({})).pieces.map(
          (piece) => piece.layer,
        ),
      ).toEqual(['rear', 'body', 'clothes', 'sword', 'hands', 'clasp'])
    } finally {
      await server.close()
    }

    await writeFile(join(gameDirectory, 'assets/images/cloak-clasp.svg'), '<svg>broken</svg>')
    await expect(
      exportGame({ gameDirectory, outputDirectory: join(temp, 'graphics-invalid') }),
    ).rejects.toThrow('asset catalogues and sources')
    await expect(readFile(join(temp, 'graphics-invalid/index.html'))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    )
  })

  it('moves the map player using configured inputs from a served standalone export', async () => {
    const destination = join(temp, 'coast-output')
    await exportGame({
      gameDirectory: fileURLToPath(new URL('../sample-games/square-map/', import.meta.url)),
      outputDirectory: destination,
    })

    const server = await preview({
      configFile: false,
      root: temp,
      base: '/coast/',
      logLevel: 'silent',
      build: { outDir: destination },
      preview: { host: '127.0.0.1', port: 0, strictPort: true },
    })

    const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }
    const steps: (() => void)[] = []
    let engine: Engine | undefined

    try {
      // SAFETY: Vite preview is configured to listen on loopback TCP.
      const { port } = server.httpServer.address() as AddressInfo
      const base = `http://127.0.0.1:${port}/coast/`
      const config = await loadRuntimeConfig(base, fetch)

      const loader = new GameLoader(
        new JsonResourceLoader(new HttpGameResources(config.gameUrl, base, fetch), logger),
      )

      engine = new Engine(
        loader,
        { mount: () => () => {} },
        logger,
        () => new MessageBus<EngineMessages>(),
        {
          clock: { now: () => 0 },
          scheduler: {
            schedule(callback, delay) {
              if (delay > 0) steps.push(callback)

              return () => {}
            },
          },
        },
      )
      await engine.start()
      const scene = engine.lifecycle!.activeScene!
      const movement = engine.lifecycle!.currentGame!.mapMovement!
      expect(movement.getPosition(scene, 'coast-map')).toEqual({ x: 9, y: 4 })
      engine.input!.pressKey('KeyD')
      engine.input!.releaseKey('KeyD')

      for (let batch = 0; batch < 4; batch++) engine.flushMessages()
      expect(steps).toHaveLength(1)
      steps[0]!()
      expect(movement.getPosition(scene, 'coast-map')).toEqual({ x: 10, y: 4 })
    } finally {
      engine?.stop()
      await server.close()
    }
  })

  it('plays the museum rules from a served standalone export', async () => {
    const destination = join(temp, 'museum-output')
    await exportGame({
      gameDirectory: fileURLToPath(new URL('../sample-games/basic/', import.meta.url)),
      outputDirectory: destination,
    })

    const server = await preview({
      configFile: false,
      root: temp,
      base: '/museum/',
      logLevel: 'silent',
      build: { outDir: destination },
      preview: { host: '127.0.0.1', port: 0, strictPort: true },
    })

    const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }
    let engine: Engine | undefined

    try {
      // SAFETY: Vite preview is configured to listen on loopback TCP.
      const { port } = server.httpServer.address() as AddressInfo
      const base = `http://127.0.0.1:${port}/museum/`
      const config = await loadRuntimeConfig(base, fetch)

      const loader = new GameLoader(
        new JsonResourceLoader(new HttpGameResources(config.gameUrl, base, fetch), logger),
      )

      engine = new Engine(
        loader,
        { mount: () => () => {} },
        logger,
        () => new MessageBus<EngineMessages>(),
        {
          clock: { now: () => 0 },
          scheduler: { schedule: () => () => {} },
        },
      )
      await engine.start()
      const lifecycle = engine.lifecycle!
      const game = lifecycle.startGame()
      lifecycle.enterScene('standard')
      const actions = game.actions!

      const status = lifecycle.activeScene!.data.components.find(
        (component) => component.id === 'player-status',
      )

      expect(status).toMatchObject({
        type: 'status-panel',
        rows: expect.arrayContaining([
          expect.objectContaining({
            type: 'bar',
            value: { source: 'game.state', path: ['player', 'health'] },
          }),
        ]),
      })
      expect(
        game.bindings!.read({ source: 'game.state', path: ['player', 'maximumHealth'] }),
      ).toMatchObject({ status: 'resolved', value: 40 })
      game.nearby!.select(lifecycle.activeScene!, 'nearby', 'curator')
      game.actionBar!.activate(lifecycle.activeScene!, 'action-bar', '6')

      for (let batch = 0; batch < 4; batch++) engine.flushMessages()
      expect(
        game.bindings!.read({ source: 'game.state', path: ['inspectionResult'] }),
      ).toMatchObject({
        status: 'resolved',
        value: expect.stringContaining('Read the folded letter'),
      })
      actions.request('take-letter')
      actions.request('inspect-letter', 'folded-letter')
      actions.request('walk-east')
      actions.request('press-crown')
      actions.request('press-heron')
      actions.request('take-chart')
      actions.request('inspect-chart', 'harbour-chart')
      actions.request('walk-west')

      for (let batch = 0; batch < 4; batch++) engine.flushMessages()

      expect(lifecycle.activeScene?.data.id).toBe('standard')
      expect(actions.progression.worldTimeMs).toBe(120_000)
      expect(game.inventory?.snapshot.find(({ id }) => id === 'harbour-chart')?.placement).toEqual({
        type: 'carried',
        owner: 'player',
      })
      expect(game.bindings?.read({ source: 'game.state', path: ['chartDetails'] })).toMatchObject({
        status: 'resolved',
        value: expect.stringContaining('north cliffs'),
      })
      engine.input!.pressKey('KeyQ')
      engine.input!.releaseKey('KeyQ')

      for (let batch = 0; batch < 4; batch++) engine.flushMessages()

      expect(lifecycle.activeScene?.data.id).toBe('old-harbour')
      expect(engine.input!.getKeyboardCodes('gameplay', 'slot-1')).toEqual(['KeyQ'])
    } finally {
      engine?.stop()
      await server.close()
    }
  })

  it('packages the engine and game, then runs from a relocated nested URL', async () => {
    const output = join(temp, 'export')
    const result = await exportGame({ gameDirectory: source, outputDirectory: output })
    expect(result.fileCount).toBe(6 + literalPaths.length)
    expect(JSON.parse(await readFile(join(output, 'config.json'), 'utf8'))).toEqual({
      gameUrl: './game/',
    })
    expect(await readFile(join(output, 'game/game.json'), 'utf8')).toBe(JSON.stringify(game))
    expect(JSON.parse(await readFile(join(output, 'game/input/controls.json'), 'utf8'))).toEqual(
      input,
    )
    expect(
      JSON.parse(await readFile(join(output, 'game/scenes/start-screen.json'), 'utf8')),
    ).toEqual(scene)
    expect(new Uint8Array(await readFile(join(output, 'game/assets/my sprite.bin')))).toEqual(bytes)
    expect(await readFile(join(output, 'game/index.html'), 'utf8')).toBe(
      '<title>Game asset</title>',
    )

    for (const path of ['.env', '.env.local', '.git', 'node_modules']) {
      await expect(readFile(join(output, 'game', path))).rejects.toHaveProperty('code', 'ENOENT')
    }

    const relocated = join(temp, 'relocated')
    await rename(output, relocated)

    const server = await preview({
      configFile: false,
      root: temp,
      base: '/nested/game/',
      logLevel: 'silent',
      build: { outDir: relocated },
      preview: { host: '127.0.0.1', port: 0, strictPort: true },
    })

    try {
      // SAFETY: this server is listening on a TCP loopback port, not a Unix socket.
      const address = server.httpServer.address() as AddressInfo
      const applicationUrl = `http://127.0.0.1:${address.port}/nested/game/`
      const html = await (await fetch(applicationUrl)).text()

      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((match) => match[1]!)
        .filter((path) => !path.startsWith('data:'))

      expect(assets.some((path) => path.endsWith('.js'))).toBe(true)
      expect(assets.some((path) => path.endsWith('.css'))).toBe(true)

      for (const path of assets) {
        expect(path).toMatch(/^\.\/assets\//)
        const response = await fetch(new URL(path, applicationUrl))
        expect(response.status).toBe(200)
      }

      const config = await loadRuntimeConfig(applicationUrl, fetch)
      const host = { mount: vi.fn(() => () => {}) }

      const container = new ContainerBuilder(config, applicationUrl, fetch, host, {
        clock: { now: () => 0 },
        scheduler: { schedule: () => () => {} },
      }).build()

      const engine = container.resolve('engine')
      await engine.start()
      expect(engine.game).toEqual(gameData('Export test'))
      expect(host.mount).toHaveBeenCalledExactlyOnceWith(gameData('Export test'), {
        input: expect.objectContaining({ context: 'gameplay' }),
        messages: expect.anything(),
        timers: expect.anything(),
        actions: undefined,
        lifecycle: expect.anything(),
      })
      engine.stop()
      await expect(
        container.resolve('gameResources').readBytes('assets/my sprite.bin'),
      ).resolves.toEqual(bytes)
      await expect(
        container.resolve('gameResources').readText('assets/dialogue/intro.txt'),
      ).resolves.toBe('Café 🎮')

      // Serve literal filenames with standard percent decoding. Vite preview leaves
      // reserved characters such as %23 encoded when looking up static files.
      const fileServer = createServer((request, response) => {
        const path = decodeURIComponent(
          new URL(request.url ?? '/', 'http://localhost').pathname,
        ).replace(/^\/game\//, '')

        if (!literalPaths.includes(path)) {
          response.writeHead(404).end()

          return
        }

        void readFile(join(relocated, 'game', path))
          .then((contents) => response.end(contents))
          .catch(() => response.writeHead(500).end())
      })

      fileServer.listen(0, '127.0.0.1')
      await once(fileServer, 'listening')

      try {
        // SAFETY: this server is listening on a TCP loopback port, not a Unix socket.
        const address = fileServer.address() as AddressInfo

        const resources = new HttpGameResources(
          '/game/',
          `http://127.0.0.1:${address.port}/`,
          fetch,
        )

        for (const path of literalPaths) {
          await expect(resources.readText(path)).resolves.toBe('Café 🎮')
          await expect(resources.readBytes(path)).resolves.toEqual(
            new TextEncoder().encode('Café 🎮'),
          )
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          fileServer.close((error) => (error ? reject(error) : resolve()))
        })
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.httpServer.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  it('refuses to overwrite an existing directory', async () => {
    const output = join(temp, 'existing')
    await mkdir(output)
    await writeFile(join(output, 'keep.txt'), 'keep this file')

    await expect(exportGame({ gameDirectory: source, outputDirectory: output })).rejects.toThrow(
      'destination already exists',
    )
    expect(await readFile(join(output, 'keep.txt'), 'utf8')).toBe('keep this file')
  })

  it.each(['same', 'descendant', 'ancestor'])(
    'rejects a destination overlapping the game source: %s',
    async (kind) => {
      const output = kind === 'same' ? source : kind === 'descendant' ? join(source, 'dist') : temp
      await expect(exportGame({ gameDirectory: source, outputDirectory: output })).rejects.toThrow(
        'must not overlap',
      )
    },
  )

  it.each([
    ['missing', undefined],
    ['malformed', 'invalid JSON'],
    ['array', '[]'],
    ['null', 'null'],
  ])('rejects %s game.json without publishing a partial export', async (kind, contents) => {
    const invalid = join(temp, `invalid-${kind}`)
    const output = join(temp, `failed-${kind}`)
    await mkdir(invalid)

    if (contents !== undefined) await writeFile(join(invalid, 'game.json'), contents)

    await expect(exportGame({ gameDirectory: invalid, outputDirectory: output })).rejects.toThrow(
      'game.json, a referenced scene, input definition, or language catalog is missing, malformed, or invalid',
    )
    await expect(readdir(output)).rejects.toHaveProperty('code', 'ENOENT')
    expect((await readdir(temp)).filter((name) => name.startsWith('.game-export-'))).toEqual([])
  })

  it.each([
    ['missing', undefined],
    ['malformed', '{broken'],
    [
      'invalid grid',
      JSON.stringify({ ...scene, screen: { type: 'grid', grid: { rows: 0, columns: 20 } } }),
    ],
    ['mismatched ID', JSON.stringify({ ...scene, id: 'wrong' })],
  ])('rejects a %s scene without publishing an export', async (kind, contents) => {
    const invalid = join(temp, `scene-${kind}`)
    const output = join(temp, `failed-scene-${kind}`)
    await mkdir(join(invalid, 'scenes'), { recursive: true })
    await mkdir(join(invalid, 'input'))
    await writeFile(join(invalid, 'game.json'), JSON.stringify(game))
    await writeFile(join(invalid, 'input/controls.json'), JSON.stringify(input))

    if (contents !== undefined) await writeFile(join(invalid, 'scenes/start-screen.json'), contents)

    await expect(exportGame({ gameDirectory: invalid, outputDirectory: output })).rejects.toThrow(
      'referenced scene',
    )
    await expect(readdir(output)).rejects.toHaveProperty('code', 'ENOENT')
    expect((await readdir(temp)).filter((name) => name.startsWith('.game-export-'))).toEqual([])
  })

  it.each([
    ['missing', undefined],
    ['malformed', '{broken'],
    ['invalid', JSON.stringify({ ...input, 'initial-context': 'missing' })],
  ])('rejects %s input without publishing an export', async (kind, contents) => {
    const invalid = join(temp, `input-${kind}`)
    const output = join(temp, `failed-input-${kind}`)
    await mkdir(join(invalid, 'input'), { recursive: true })
    await writeFile(join(invalid, 'game.json'), JSON.stringify({ ...game, scenes: [] }))

    if (contents !== undefined) await writeFile(join(invalid, 'input/controls.json'), contents)
    await expect(exportGame({ gameDirectory: invalid, outputDirectory: output })).rejects.toThrow(
      'input definition',
    )
    await expect(readdir(output)).rejects.toHaveProperty('code', 'ENOENT')
    expect((await readdir(temp)).filter((name) => name.startsWith('.game-export-'))).toEqual([])
  })

  it('rejects linked assets and source directories', async () => {
    const linkedAssets = join(temp, 'linked-assets')
    await mkdir(linkedAssets)
    await writeFile(join(linkedAssets, 'game.json'), '{}')
    await symlink(
      source,
      join(linkedAssets, 'assets'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(
      exportGame({
        gameDirectory: linkedAssets,
        outputDirectory: join(temp, 'linked-assets-export'),
      }),
    ).rejects.toThrow('cannot contain links')

    const linkedSource = join(temp, 'linked-source')
    await symlink(source, linkedSource, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(
      exportGame({
        gameDirectory: linkedSource,
        outputDirectory: join(temp, 'linked-source-export'),
      }),
    ).rejects.toThrow('not a file or link')
  })

  it('detects source overlap through a linked destination parent', async () => {
    const alias = join(temp, 'source-alias')
    await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(
      exportGame({
        gameDirectory: source,
        outputDirectory: join(alias, 'new/export'),
      }),
    ).rejects.toThrow('must not overlap')
    await expect(readdir(join(source, 'new'))).rejects.toHaveProperty('code', 'ENOENT')
  })
})
