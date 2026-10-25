import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite-plus'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { gameSchema } from '@ancadeba/schemas'
import { loadRuntimeConfig } from '../apps/engine/src/config.js'
import { ContainerBuilder } from '../apps/engine/src/ioc/containerBuilder.js'
import { exportGame } from '../tooling/game-export.js'

describe('standalone game export', () => {
  let temp: string
  let source: string
  const game = { title: 'Export test', assets: ['assets/my sprite.bin'] }
  const bytes = new Uint8Array([0, 255, 128, 42])

  beforeAll(async () => {
    temp = await mkdtemp(fileURLToPath(new URL('./.tmp-game-export-', import.meta.url)))
    source = join(temp, 'source')
    await mkdir(join(source, 'assets/dialogue'), { recursive: true })
    await mkdir(join(source, '.git'))
    await mkdir(join(source, 'node_modules'))
    await writeFile(join(source, 'game.json'), JSON.stringify(game))
    await writeFile(join(source, 'assets/my sprite.bin'), bytes)
    await writeFile(join(source, 'assets/dialogue/intro.txt'), 'Café 🎮')
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
    expect(result.fileCount).toBe(4)
    expect(JSON.parse(await readFile(join(output, 'config.json'), 'utf8'))).toEqual({
      gameUrl: './game/',
    })
    expect(await readFile(join(output, 'game/game.json'), 'utf8')).toBe(JSON.stringify(game))
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
      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]!)
      expect(assets.some((path) => path.endsWith('.js'))).toBe(true)
      expect(assets.some((path) => path.endsWith('.css'))).toBe(true)
      for (const path of assets) {
        expect(path).toMatch(/^\.\/assets\//)
        const response = await fetch(new URL(path, applicationUrl))
        expect(response.status).toBe(200)
      }

      const config = await loadRuntimeConfig(applicationUrl, fetch)
      const container = new ContainerBuilder(config, applicationUrl, fetch).build()
      await expect(
        container.resolve('jsonResourceLoader').load('game.json', gameSchema),
      ).resolves.toEqual(game)
      await expect(
        container.resolve('gameResources').readBytes('assets/my sprite.bin'),
      ).resolves.toEqual(bytes)
      await expect(
        container.resolve('gameResources').readText('assets/dialogue/intro.txt'),
      ).resolves.toBe('Café 🎮')
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
      'game.json is missing, malformed, or invalid',
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
