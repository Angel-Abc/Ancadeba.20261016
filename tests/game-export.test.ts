import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
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
    input: 'input.json',
    assets: ['assets/my sprite.bin'],
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
    await writeFile(join(source, 'game.json'), JSON.stringify(game))
    await writeFile(join(source, 'input.json'), JSON.stringify(input))
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

  it('packages the engine and game, then runs from a relocated nested URL', async () => {
    const output = join(temp, 'export')
    const result = await exportGame({ gameDirectory: source, outputDirectory: output })
    expect(result.fileCount).toBe(6 + literalPaths.length)
    expect(JSON.parse(await readFile(join(output, 'config.json'), 'utf8'))).toEqual({
      gameUrl: './game/',
    })
    expect(await readFile(join(output, 'game/game.json'), 'utf8')).toBe(JSON.stringify(game))
    expect(JSON.parse(await readFile(join(output, 'game/input.json'), 'utf8'))).toEqual(input)
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
      const container = new ContainerBuilder(config, applicationUrl, fetch, host).build()
      const engine = container.resolve('engine')
      await engine.start()
      expect(engine.game).toEqual(gameData('Export test'))
      expect(host.mount).toHaveBeenCalledExactlyOnceWith(gameData('Export test'), {
        input: expect.objectContaining({ context: 'gameplay' }),
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
      'game.json, a referenced scene, or input definition is missing, malformed, or invalid',
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
    await writeFile(join(invalid, 'game.json'), JSON.stringify(game))
    await writeFile(join(invalid, 'input.json'), JSON.stringify(input))
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
    await mkdir(invalid)
    await writeFile(join(invalid, 'game.json'), JSON.stringify({ ...game, scenes: [] }))
    if (contents !== undefined) await writeFile(join(invalid, 'input.json'), contents)
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
