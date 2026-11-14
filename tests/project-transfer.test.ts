import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Zip, ZipPassThrough, zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import {
  maxProjectUnpackedBytes,
  maxProjectArchiveEntries,
  projectRegistryFile,
  projectViewSchema,
} from '@ancadeba/editor-core'
import {
  readProjectArchive,
  writeProjectArchive,
} from '../apps/editor-server/src/projectArchive.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'

const packed = (files: Record<string, Uint8Array>) => zipSync(files, { level: 0 })

function alterEntry(
  archive: Uint8Array,
  change: (bytes: Buffer, central: number, local: number) => void,
) {
  const bytes = Buffer.from(archive)
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  change(bytes, central, bytes.readUInt32LE(central + 42))

  return bytes
}

describe('bounded project ZIP codec', async () => {
  it('reads stored, deflated, UTF-8, empty and single-wrapper files', async () => {
    const files = {
      'game.json': strToU8('{}'),
      'assets/Café #1.bin': new Uint8Array([0, 255, 128]),
      '.gitignore': strToU8('private'),
      'empty.txt': new Uint8Array(),
    }

    const archives = [
      zipSync(files, { level: 0 }),
      zipSync(files, { level: 6 }),
      await writeProjectArchive(files),
      packed(
        Object.fromEntries(
          Object.entries(files).map(([name, bytes]) => [`My Project/${name}`, bytes]),
        ),
      ),
    ]

    for (const archive of archives) {
      const decoded = await readProjectArchive(archive)
      expect(Object.keys(decoded).sort()).toEqual(Object.keys(files).sort())

      for (const [path, bytes] of Object.entries(files))
        expect(Buffer.from(decoded[path]!)).toEqual(Buffer.from(bytes))
    }
  })
  it('skips Finder and Explorer clutter around a hand-zipped project folder', async () => {
    const clutter = strToU8('clutter')

    const decoded = await readProjectArchive(
      packed({
        'My Game/game.json': strToU8('{}'),
        'My Game/.DS_Store': clutter,
        'My Game/assets/Thumbs.db': clutter,
        'My Game/assets/hero.png': strToU8('image'),
        '__MACOSX/My Game/._game.json': clutter,
        '__MACOSX/My Game/assets/._hero.png': clutter,
      }),
    )

    expect(Object.keys(decoded).sort()).toEqual(['assets/hero.png', 'game.json'])
    await expect(readProjectArchive(packed({ '__MACOSX/._game.json': clutter }))).rejects.toThrow(
      'Place game.json',
    )
  })
  it.each([
    '../escape',
    '/absolute',
    'C:/absolute',
    'a\\b',
    'a/./b',
    'a//b',
    'a/../b',
    'CON.txt',
    'a/file.',
    'a/file ',
    'a/\u0000b',
    '.env',
    '.env.local',
    '.git/config',
    'node_modules/file',
    '.ancadeba-projects.json',
    '.ancadeba-trash/file',
  ])('rejects unsafe or private path %j', async (path) => {
    await expect(
      readProjectArchive(packed({ 'game.json': strToU8('{}'), [path]: strToU8('unsafe') })),
    ).rejects.toThrow()
  })
  it.each([
    ['A.txt', 'a.txt'],
    ['folder', 'folder/file'],
    ['Assets/a.txt', 'assets/b.txt'],
    ['game.json', 'game.json/child'],
  ])('rejects conflicting paths %s and %s', async (first, second) => {
    await expect(
      readProjectArchive(
        packed({ [first]: strToU8('a'), [second]: strToU8('b'), 'game.json': strToU8('{}') }),
      ),
    ).rejects.toThrow()
  })
  it('rejects incomplete, empty, multi-root and playable-game archives', async () => {
    for (const bytes of [
      strToU8('not zip'),
      packed({}),
      packed({ 'one/a': strToU8('a'), 'two/game.json': strToU8('{}') }),
      packed({ 'index.html': strToU8('engine'), 'game/game.json': strToU8('{}') }),
    ])
      await expect(readProjectArchive(bytes)).rejects.toThrow()
    const zip = packed({ 'game.json': strToU8('{}') })
    await expect(readProjectArchive(zip.slice(0, -1))).rejects.toThrow()
  })
  it('rejects symlinks, encryption, split archives and unsupported methods', async () => {
    const zip = packed({ 'game.json': strToU8('{}') })

    const patches = [
      (bytes: Buffer, central: number) => bytes.writeUInt32LE(0xa1ff0000, central + 38),
      (bytes: Buffer, central: number) => bytes.writeUInt16LE(1, central + 8),
      (bytes: Buffer, central: number) => bytes.writeUInt16LE(99, central + 10),
      (bytes: Buffer, central: number) => bytes.writeUInt16LE(1, central + 34),
      (bytes: Buffer, central: number) => bytes.writeUInt32LE(0xffffffff, central + 42),
    ]

    for (const patch of patches)
      await expect(readProjectArchive(alterEntry(zip, patch))).rejects.toThrow()
  })
  it('rejects CRC failures, mismatched names, duplicate entries and invalid UTF-8', async () => {
    const zip = packed({ 'game.json': strToU8('{}') })
    await expect(
      readProjectArchive(
        alterEntry(zip, (bytes, _central, local) => {
          bytes[local + 30 + 9] = 1
        }),
      ),
    ).rejects.toThrow()
    await expect(
      readProjectArchive(
        alterEntry(zip, (bytes, central) => {
          bytes[central + 46] = 120
        }),
      ),
    ).rejects.toThrow()
    await expect(
      readProjectArchive(
        alterEntry(zip, (bytes, central, local) => {
          bytes.writeUInt16LE(0x800, central + 8)
          bytes.writeUInt16LE(0x800, local + 6)
          bytes[central + 46] = 255
          bytes[local + 30] = 255
        }),
      ),
    ).rejects.toThrow('Use UTF-8')
    const twice = packed({ 'game.json': strToU8('{}'), 'same.json': strToU8('{}') })
    const bytes = Buffer.from(twice)

    const second = bytes.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 4,
    )

    const local = bytes.readUInt32LE(second + 42)
    Buffer.from('game.json').copy(bytes, second + 46)
    Buffer.from('game.json').copy(bytes, local + 30)
    await expect(readProjectArchive(bytes)).rejects.toThrow('Duplicate archive entry')
  })
  it('bounds declared expansion, entry counts and dishonest compressed streams', async () => {
    const zip = packed({ 'game.json': strToU8('{}') })
    await expect(
      readProjectArchive(
        alterEntry(zip, (bytes, central) =>
          bytes.writeUInt32LE(maxProjectUnpackedBytes + 1, central + 24),
        ),
      ),
    ).rejects.toThrow('128 MiB')
    const count = Buffer.from(zip)
    count.writeUInt16LE(maxProjectArchiveEntries + 1, count.length - 14)
    count.writeUInt16LE(maxProjectArchiveEntries + 1, count.length - 12)
    await expect(readProjectArchive(count)).rejects.toThrow('10000')
    const bomb = zipSync({ 'game.json': new Uint8Array(65536) }, { level: 9 })
    await expect(
      readProjectArchive(
        alterEntry(bomb, (bytes, central, local) => {
          bytes.writeUInt32LE(1, central + 24)
          bytes.writeUInt32LE(1, local + 22)
        }),
      ),
    ).rejects.toThrow('oversized compressed entry')
  })
  it('reads streaming ZIPs and rejects damaged streaming descriptors', async () => {
    const chunks: Uint8Array[] = []

    const zip = new Zip((error, data) => {
      if (error) throw error
      chunks.push(data)
    })

    const file = new ZipPassThrough('game.json')
    zip.add(file)
    file.push(strToU8('{}'), true)
    zip.end()
    const streamed = Buffer.concat(chunks)
    expect(strFromU8((await readProjectArchive(streamed))['game.json']!)).toBe('{}')
    const descriptor = streamed.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]))

    if (descriptor < 0) throw new Error('Expected ZIP streaming descriptor')
    streamed[descriptor + 4] = streamed[descriptor + 4]! ^ 1
    await expect(readProjectArchive(streamed)).rejects.toThrow('data descriptor')
  })
})

describe('project source import and export', () => {
  let root: string
  let workspace: FileWorkspace
  let service: EditorProjectService
  let server: Server | undefined

  const createService = (overrides: Partial<ProjectWorkspace> = {}) =>
    new EditorProjectService(
      new WorkspaceProjectRepository({
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        write: (path, bytes) => workspace.write(path, bytes),
        create: (path, bytes) => workspace.create(path, bytes),
        createDirectory: (path) => workspace.createDirectory(path),
        removeDirectory: (path) => workspace.removeDirectory(path),
        removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
        moveDirectory: (from, to) => workspace.moveDirectory(from, to),
        ...overrides,
      }),
      new EditorCoordinator(),
    )

  const exportSource = async (path = 'source') =>
    service.exportProject({ path, expectedRevision: (await service.inspect(path)).revision })

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-project-transfer-', import.meta.url)))
    workspace = await FileWorkspace.open(root)
    service = createService()
    await service.create({ path: 'source', title: 'Original' })
  })
  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      )
    server = undefined
    await rm(root, { recursive: true, force: true })
  })
  it('round-trips a complete sample game with translations, CSS, assets, extensions and unused bytes', async () => {
    await cp(new URL('../sample-games/basic/', import.meta.url), join(root, 'source'), {
      recursive: true,
    })
    await mkdir(join(root, 'source/notes'))
    await writeFile(join(root, 'source/notes/Café #1.bin'), new Uint8Array([0, 255, 128]))
    await writeFile(join(root, 'source/.gitignore'), 'notes')
    const game = JSON.parse(await readFile(join(root, 'source/game.json'), 'utf8'))
    game.extension = { author: 'Keep this' }
    await writeFile(join(root, 'source/game.json'), JSON.stringify(game))
    const source = await service.inspect('source')
    const archive = await exportSource()
    const files = unzipSync(archive.bytes)
    const imported = await service.importProject({ destination: 'copy' }, archive.bytes)
    expect(imported).toMatchObject({
      revision: source.revision,
      game: { id: source.game!.id },
      diagnostics: [],
    })

    for (const [path, bytes] of Object.entries(files))
      expect(Buffer.from(await workspace.read(`copy/${path}`))).toEqual(Buffer.from(bytes))
    expect(JSON.parse(await readFile(join(root, 'copy/game.json'), 'utf8')).extension).toEqual(
      game.extension,
    )
    expect((await service.inspect('source')).revision).toBe(source.revision)
  })
  it('excludes nested games, local secrets, workspace metadata and dependencies', async () => {
    await service.create({ path: 'nested', title: 'Nested' })
    await workspace.moveDirectory('nested', 'source/nested')

    for (const folder of ['.git', 'node_modules', '.ancadeba-trash']) {
      await mkdir(join(root, 'source', folder))
      await writeFile(join(root, 'source', folder, 'secret'), 'private')
    }

    await writeFile(join(root, 'source/.env'), 'secret')
    await writeFile(join(root, 'source/.ancadeba-projects.json'), 'private')
    const files = unzipSync((await exportSource()).bytes)
    expect(Object.keys(files)).not.toContain('nested/game.json')
    expect(
      Object.keys(files).some((path) => path.startsWith('.') || path.startsWith('node_modules')),
    ).toBe(false)
  })

  const addScene = async (id: string, fileName = id) => {
    const original = JSON.parse(await readFile(join(root, 'source/game.json'), 'utf8'))
    const sceneName = original.scenes[0]
    const scene = JSON.parse(await readFile(join(root, `source/scenes/${sceneName}.json`), 'utf8'))
    await writeFile(join(root, `source/scenes/${fileName}.json`), JSON.stringify({ ...scene, id }))
    await writeFile(
      join(root, 'source/game.json'),
      JSON.stringify({ ...original, scenes: [...original.scenes, id] }),
    )
  }

  it.each(['game', 'Game'])('keeps referenced scene files named %s.json', async (id) => {
    await addScene(id)
    const archive = await exportSource()
    expect(unzipSync(archive.bytes)).toHaveProperty(`scenes/${id}.json`)
    expect(
      (await service.importProject({ destination: 'copy' }, archive.bytes)).diagnostics,
    ).toEqual([])
  })
  it('names files whose capitalization differs from their references instead of exporting', async () => {
    await addScene('Extra', 'extra')

    // Case-insensitive disks resolve the reference; simulate that on every platform.
    const insensitive = createService({
      read: (path) => workspace.read(path.replace('scenes/Extra.json', 'scenes/extra.json')),
    })

    const { revision, diagnostics } = await insensitive.inspect('source')
    expect(diagnostics).toEqual([])
    await expect(
      insensitive.exportProject({ path: 'source', expectedRevision: revision }),
    ).rejects.toMatchObject({
      code: 'invalid_project',
      message: expect.stringContaining('scenes/Extra.json is saved as scenes/extra.json'),
    })
  })
  it('preserves IDs while assigning independent preview-save storage after name reuse', async () => {
    const original = await service.inspect('source')

    const renamed = await service.rename({
      path: 'source',
      expectedRevision: original.revision,
      folderName: 'renamed',
    })

    const archive = await exportSource('renamed')
    const imported = await service.importProject({ destination: 'source' }, archive.bytes)
    expect(imported.game!.id).toBe(original.game!.id)
    expect(imported.storageKey).not.toBe(renamed.storageKey)
    expect(imported.storageKey).toMatch(/^project:/)
    expect(unzipSync(archive.bytes)).not.toHaveProperty(projectRegistryFile)
  })
  it('accepts a single containing folder and rejects nested projects', async () => {
    const source = await readProjectArchive((await exportSource()).bytes)

    const wrapped = packed(
      Object.fromEntries(Object.entries(source).map(([path, bytes]) => [`Folder/${path}`, bytes])),
    )

    expect((await service.importProject({ destination: 'wrapped' }, wrapped)).diagnostics).toEqual(
      [],
    )

    for (const manifest of [source['game.json']!, strToU8('{ damaged')]) {
      const nested = packed({ ...source, 'nested/game.json': manifest })
      await expect(service.importProject({ destination: 'bad' }, nested)).rejects.toMatchObject({
        code: 'nested_projects',
      })
    }

    expect(await readdir(root)).not.toContain('bad')
  })
  it('rejects stale exports, invalid imports, incomplete games and occupied destinations without changing files', async () => {
    await expect(
      service.exportProject({ path: 'source', expectedRevision: 'stale' }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    const archive = await exportSource()
    await mkdir(join(root, 'occupied'))
    await expect(
      service.importProject({ destination: 'occupied' }, archive.bytes),
    ).rejects.toMatchObject({ code: 'project_exists' })
    // The occupied folder is reported before the archive itself is examined.
    await expect(
      service.importProject({ destination: 'occupied' }, strToU8('not zip')),
    ).rejects.toMatchObject({ code: 'project_exists' })
    expect(await readdir(join(root, 'occupied'))).toEqual([])

    for (const bytes of [
      packed({ 'game.json': strToU8('{ invalid') }),
      packed({ 'game.json': strToU8('{}') }),
      packed({ 'game.json': (await readProjectArchive(archive.bytes))['game.json']! }),
    ])
      await expect(service.importProject({ destination: 'invalid' }, bytes)).rejects.toMatchObject({
        code: 'invalid_project',
      })
    expect(await readdir(root)).not.toContain('invalid')
    await expect(async () =>
      service.importProject({ destination: '../escape' }, archive.bytes),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })
  it('rolls failed publication back and preserves outside changes during uncertain cleanup', async () => {
    const archive = await exportSource()

    const failing = createService({
      create: async (path, bytes) => {
        if (path === 'copy/game.json') throw new Error('Publication failed')

        return workspace.create(path, bytes)
      },
    })

    await expect(failing.importProject({ destination: 'copy' }, archive.bytes)).rejects.toThrow(
      'Publication failed',
    )
    expect(await readdir(root)).toEqual(['source'])

    const interrupted = createService({
      create: async (path, bytes) => {
        if (path === 'copy/game.json') {
          await workspace.write('copy/outside.txt', strToU8('outside'))
          throw new Error('Interrupted')
        }

        return workspace.create(path, bytes)
      },
    })

    await expect(
      interrupted.importProject({ destination: 'copy' }, archive.bytes),
    ).rejects.toMatchObject({ code: 'project_cleanup_failed' })
    expect(await readFile(join(root, 'copy/outside.txt'), 'utf8')).toBe('outside')
  })
  it('exports workspace-root games while leaving project history unchanged', async () => {
    await cp(join(root, 'source'), join(root), { recursive: true })
    const before = await service.inspect('')
    const archive = await exportSource('')
    expect(strFromU8(unzipSync(archive.bytes)['game.json']!)).toBe(
      await readFile(join(root, 'game.json'), 'utf8'),
    )
    expect((await service.inspect('')).history).toEqual(before.history)
  })
  it('serves source ZIP downloads and imports raw ZIP uploads over HTTP', async () => {
    server = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      undefined,
      service,
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()

    if (!address || typeof address === 'string') throw new Error('Expected TCP server')
    const base = `http://127.0.0.1:${address.port}`

    const response = await fetch(`${base}/api/editor/projects/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'source',
        expectedRevision: (await service.inspect('source')).revision,
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const zip = await response.arrayBuffer()

    const imported = await fetch(`${base}/api/editor/projects/import?destination=http-copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: zip,
    })

    expect(imported.status).toBe(201)
    expect(projectViewSchema.parse(await imported.json()).game!.id).toBe('source')
    expect(
      (
        await fetch(`${base}/api/editor/projects/import?destination=bad`, {
          method: 'POST',
          body: zip,
        })
      ).status,
    ).toBe(415)
    expect(
      (
        await fetch(`${base}/api/editor/projects/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400)
  })
})
