import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync, strFromU8 } from 'fflate'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { buildGame } from '../apps/editor-server/src/buildGame.js'
import { writeGameArchive } from '../apps/editor-server/src/gameArchive.js'
import {
  WorkspaceGameExporter,
  type GameExportArchive,
} from '../apps/editor-server/src/gameExports.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'

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

describe('editor game export API', () => {
  let temp: string
  let root: string
  let scratch: string
  let server: Server
  let baseUrl: string
  const bytes = new Uint8Array([0, 128, 255, 42])

  beforeAll(async () => {
    temp = await mkdtemp(fileURLToPath(new URL('./.tmp-editor-export-', import.meta.url)))
    root = join(temp, 'workspace')
    scratch = join(temp, 'exports')
    await mkdir(scratch)
    await mkdir(join(root, 'assets'), { recursive: true })
    await mkdir(join(root, 'second game'))
    await mkdir(join(root, 'invalid'))
    await writeFile(join(root, 'game.json'), JSON.stringify(gameDefinition('Workspace game')))
    await writeFile(join(root, 'assets/sprite.bin'), bytes)
    await writeFile(join(root, '.env.local'), 'PRIVATE_SETTING=value')
    await writeFile(
      join(root, 'second game/game.json'),
      JSON.stringify(gameDefinition('Second game')),
    )
    await writeFile(join(root, 'invalid/game.json'), '[]')
    await symlink(scratch, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const workspace = await FileWorkspace.open(root)
    const exports = new WorkspaceGameExporter(workspace, buildGame, writeGameArchive, scratch)
    server = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      exports,
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(temp, { recursive: true, force: true })
  })

  function request(body: unknown) {
    return fetch(`${baseUrl}/api/exports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('downloads a standalone game from a workspace subfolder and cleans temporary files', async () => {
    const response = await request({ path: 'second game' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="second-game.zip"',
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(strFromU8(files['index.html']!)).toContain('./assets/')
    expect(JSON.parse(strFromU8(files['config.json']!))).toEqual({ gameUrl: './game/' })
    expect(JSON.parse(strFromU8(files['game/game.json']!))).toEqual(gameDefinition('Second game'))
    expect(
      Object.keys(files).some((path) => path.startsWith('assets/') && path.endsWith('.js')),
    ).toBe(true)
    await vi.waitFor(async () => expect(await readdir(scratch)).toEqual([]))
  }, 20_000)

  it('exports current saved files from the workspace root with binary assets', async () => {
    // A linked asset must be rejected; remove this test-only link before exporting the root.
    await rm(join(root, 'linked'))
    await writeFile(join(root, 'game.json'), JSON.stringify(gameDefinition('Saved changes')))
    const response = await request({ path: '' })
    expect(response.status).toBe(200)
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(JSON.parse(strFromU8(files['game/game.json']!))).toEqual(gameDefinition('Saved changes'))
    expect(files['game/assets/sprite.bin']).toEqual(bytes)
    expect(files['game/.env.local']).toBeUndefined()
    expect(await readFile(join(root, 'game.json'), 'utf8')).toBe(
      JSON.stringify(gameDefinition('Saved changes')),
    )
    await vi.waitFor(async () => expect(await readdir(scratch)).toEqual([]))
  }, 20_000)

  it.each(['../outside', '/outside', 'C:/outside', 'second game/../invalid', 'second game\\file'])(
    'rejects an unsafe source %j without exposing filesystem paths',
    async (path) => {
      const response = await request({ path })
      expect([400, 403]).toContain(response.status)
      expect(await response.text()).not.toContain(temp)
      expect(await readdir(scratch)).toEqual([])
    },
  )

  it('rejects a source directory link', async () => {
    await symlink(
      scratch,
      join(root, 'linked-source'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const response = await request({ path: 'linked-source' })
    expect(response.status).toBe(403)
    await rm(join(root, 'linked-source'))
  })

  it('reports an invalid game and cleans up after build failure', async () => {
    const response = await request({ path: 'invalid' })
    expect(response.status).toBe(422)
    expect(await response.text()).not.toContain(temp)
    expect(await readdir(scratch)).toEqual([])
  }, 20_000)

  it.each([null, {}, { path: 123 }, { path: '', outputDirectory: 'C:/unexpected' }])(
    'rejects an invalid export request %j',
    async (body) => {
      const response = await request(body)
      expect(response.status).toBe(400)
    },
  )

  it('requires JSON requests and rejects malformed JSON', async () => {
    const unsupported = await fetch(`${baseUrl}/api/exports`, { method: 'POST', body: 'path=game' })
    expect(unsupported.status).toBe(415)
    const malformed = await fetch(`${baseUrl}/api/exports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken',
    })
    expect(malformed.status).toBe(400)
  })

  it('keeps an export busy until disposed and makes old cleanup idempotent', async () => {
    const workspace = await FileWorkspace.open(root)
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const builder = vi.fn(async (_source: string, output: string) => {
      await ready
      await mkdir(output)
      await writeFile(join(output, 'index.html'), 'export')
    })
    const exports = new WorkspaceGameExporter(workspace, builder, writeGameArchive, scratch)
    const pending = exports.create('')
    await vi.waitFor(() => expect(builder).toHaveBeenCalledTimes(1))
    await expect(exports.create('')).rejects.toMatchObject({ status: 409 })
    release()
    const first = await pending
    await expect(exports.create('')).rejects.toMatchObject({ status: 409 })
    await first.dispose()
    const second = await exports.create('')
    await first.dispose()
    await expect(exports.create('')).rejects.toMatchObject({ status: 409 })
    await second.dispose()
    expect(await readdir(scratch)).toEqual([])
  })

  it('cleans up after archive creation fails and permits retrying', async () => {
    const workspace = await FileWorkspace.open(root)
    const builder = async (_source: string, output: string) => {
      await mkdir(output)
      await writeFile(join(output, 'index.html'), 'export')
    }
    const writer = vi.fn(writeGameArchive).mockRejectedValueOnce(new Error('Archive failed'))
    const exports = new WorkspaceGameExporter(workspace, builder, writer, scratch)

    await expect(exports.create('')).rejects.toThrow('Archive failed')
    expect(await readdir(scratch)).toEqual([])
    const archive = await exports.create('')
    await archive.dispose()
    expect(await readdir(scratch)).toEqual([])
  })

  it('disposes the archive when a client disconnects before the build completes', async () => {
    const filePath = join(temp, 'disconnected.zip')
    await writeFile(filePath, new Uint8Array([80, 75, 3, 4]))
    const dispose = vi.fn(async () => {
      await rm(filePath)
    })
    let finish!: (archive: GameExportArchive) => void
    const create = vi.fn(
      () =>
        new Promise<GameExportArchive>((resolve) => {
          finish = resolve
        }),
    )
    const workspace = await FileWorkspace.open(root)
    const disconnected = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      { create },
    )
    disconnected.listen(0, '127.0.0.1')
    await once(disconnected, 'listening')
    const port = (disconnected.address() as AddressInfo).port
    const abort = new AbortController()
    try {
      const pending = fetch(`http://127.0.0.1:${port}/api/exports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"path":""}',
        signal: abort.signal,
      }).catch((error: unknown) => error)
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      abort.abort()
      await pending
      finish({ filePath, fileName: 'game.zip', size: 4, dispose })
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1))
      await dispose.mock.results[0]?.value
    } finally {
      await new Promise<void>((resolve, reject) =>
        disconnected.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})
