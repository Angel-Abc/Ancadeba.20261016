import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import {
  parseEngineConfig,
  parseEngineRuntimeConfig,
  parseEditorUiConfig,
  parseEditorServerConfig,
} from '@ancadeba/schemas'
import { engineConfigFile, loadEngineConfig } from '../apps/engine/tooling/config.js'
import { editorServerConfigFile, loadEditorServerConfig } from '../apps/editor-server/src/config.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { loadAppConfig } from '../tooling/app-config.js'

describe('configuration validation', () => {
  it('supplies defaults and keeps only public engine settings at runtime', () => {
    expect(parseEngineConfig({ gameUrl: '/games/demo' })).toEqual({
      gameUrl: '/games/demo',
      port: 5173,
    })
    expect(parseEngineRuntimeConfig({ gameUrl: '/games/', port: 5273 })).toEqual({
      gameUrl: '/games/',
    })
    expect(parseEditorUiConfig({})).toEqual({
      port: 5174,
      editorServerUrl: 'http://127.0.0.1:3000',
    })
    expect(parseEditorServerConfig({ workFolder: './work' })).toEqual({
      workFolder: './work',
      host: '127.0.0.1',
      port: 3000,
    })
  })

  it('uses environment overrides before JSON settings', () => {
    expect(parseEngineConfig({ gameUrl: './game', port: 6000 }, { ENGINE_PORT: '5273' }).port).toBe(
      5273,
    )
    expect(
      parseEditorUiConfig(
        { port: 6001, editorServerUrl: 'https://old.example' },
        {
          EDITOR_UI_PORT: '5274',
          EDITOR_SERVER_URL: 'http://127.0.0.1:3100',
        },
      ),
    ).toEqual({ port: 5274, editorServerUrl: 'http://127.0.0.1:3100' })
    expect(
      parseEditorServerConfig(
        { workFolder: './work', host: 'localhost', port: 6002 },
        {
          HOST: '127.0.0.2',
          PORT: '3100',
        },
      ),
    ).toEqual({ workFolder: './work', host: '127.0.0.2', port: 3100 })
  })

  it.each([null, [], 'config', 12])('rejects non-object configuration %j', (value) => {
    expect(() => parseEngineConfig(value)).toThrow('JSON object')
    expect(() => parseEditorUiConfig(value)).toThrow('JSON object')
    expect(() => parseEditorServerConfig(value)).toThrow('JSON object')
  })

  it.each([0, -1, 65536, 1.5, '', 'abc', true])('rejects invalid ports %j', (port) => {
    expect(() => parseEngineConfig({ gameUrl: '/game', port })).toThrow('port')
    expect(() => parseEditorUiConfig({ port })).toThrow('port')
    expect(() => parseEditorServerConfig({ workFolder: './work', port })).toThrow('port')
  })

  it.each([
    '',
    'file:///tmp/game',
    '//example.com/game',
    'C:\\games',
    '/game?name=x',
    '/game#x',
    'http://',
    'https:///game',
    'https://example.com:99999/game',
  ])('rejects invalid game URLs %j', (gameUrl) => {
    expect(() => parseEngineConfig({ gameUrl })).toThrow('gameUrl')
  })

  it('requires explicit paths and valid server URLs', () => {
    expect(() => parseEngineConfig({})).toThrow('gameUrl')
    expect(() => parseEditorServerConfig({})).toThrow('workFolder')
    expect(() => parseEditorServerConfig({ workFolder: ' ' })).toThrow('workFolder')
    expect(() => parseEditorUiConfig({ editorServerUrl: 'file:///tmp' })).toThrow('editorServerUrl')
    expect(() => parseEditorUiConfig({ editorServerUrl: 'http://' })).toThrow('editorServerUrl')
    expect(() => parseEditorServerConfig({ workFolder: './work' }, { PORT: '' })).toThrow('port')
  })
})

describe('app-local configuration files', () => {
  let temp: string
  beforeAll(async () => {
    temp = await mkdtemp(fileURLToPath(new URL('./.tmp-config-', import.meta.url)))
  })
  afterAll(async () => {
    await rm(temp, { recursive: true, force: true })
  })

  it('locates default config files relative to each app rather than the shell directory', () => {
    expect(fileURLToPath(engineConfigFile)).toBe(
      fileURLToPath(new URL('../apps/engine/config.json', import.meta.url)),
    )
    expect(fileURLToPath(editorServerConfigFile)).toBe(
      fileURLToPath(new URL('../apps/editor-server/config.json', import.meta.url)),
    )
  })

  it('reads app files and resolves workFolder relative to the selected config', async () => {
    const file = pathToFileURL(join(temp, 'server.json'))
    await writeFile(file, JSON.stringify({ workFolder: './workspace' }))
    const config = await loadEditorServerConfig(file, { PORT: '3100' })
    expect(config.workFolder).toBe(resolve(temp, 'workspace'))
    expect(config.port).toBe(3100)
    await expect(FileWorkspace.open(config.workFolder)).rejects.toThrow(
      'existing, accessible directory',
    )
    await mkdir(config.workFolder)
    await expect(FileWorkspace.open(config.workFolder)).resolves.toBeInstanceOf(FileWorkspace)
  })

  it('reads web configuration through the same parsers with explicit overrides', async () => {
    const engine = pathToFileURL(join(temp, 'engine.json'))
    await writeFile(engine, JSON.stringify({ gameUrl: 'https://games.example/demo', port: 6000 }))
    expect(loadEngineConfig(engine, { ENGINE_PORT: '5273' })).toEqual({
      gameUrl: 'https://games.example/demo',
      port: 5273,
    })
    const ui = pathToFileURL(join(temp, 'ui.json'))
    await writeFile(ui, '{}')
    expect(loadAppConfig(ui, parseEditorUiConfig, {}).port).toBe(5174)
  })

  it('provides setup guidance for missing, malformed, and invalid files', async () => {
    const file = pathToFileURL(join(temp, 'broken.json'))
    expect(() => loadEngineConfig(file, {})).toThrow('Copy config.example.json')
    await expect(loadEditorServerConfig(file, {})).rejects.toThrow('Copy config.example.json')
    for (const contents of ['{broken', '{}', '{"gameUrl":"http://[:::]/game"}']) {
      await writeFile(file, contents)
      expect(() => loadEngineConfig(file, {})).toThrow('Copy config.example.json')
      await expect(loadEditorServerConfig(file, {})).rejects.toThrow('Copy config.example.json')
    }
  })

  it('ships valid examples for all apps', async () => {
    const readExample = async (app: string) =>
      JSON.parse(
        await readFile(new URL(`../apps/${app}/config.example.json`, import.meta.url), 'utf8'),
      ) as unknown
    expect(parseEngineConfig(await readExample('engine')).gameUrl).toBeTruthy()
    expect(parseEditorUiConfig(await readExample('editor-ui')).port).toBe(5174)
    expect(parseEditorServerConfig(await readExample('editor-server')).workFolder).toBeTruthy()
  })
})
