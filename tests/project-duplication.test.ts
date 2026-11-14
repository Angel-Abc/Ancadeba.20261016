import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  duplicateProjectManifest,
  duplicateProjectRequestSchema,
  maxDuplicateProjectBytes,
  maxDuplicateProjectFiles,
  projectViewSchema,
} from '@ancadeba/editor-core'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader } from '@ancadeba/utilities'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'
import { readProjectCopyFiles } from '../apps/editor-server/src/projectDuplication.js'

const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

describe('project duplication', () => {
  let root: string
  let workspace: FileWorkspace
  let service: EditorProjectService
  let server: Server
  let base: string

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-project-duplication-', import.meta.url)))
    await cp(new URL('../sample-games/basic/', import.meta.url), join(root, 'source'), {
      recursive: true,
    })
    workspace = await FileWorkspace.open(root)
    service = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )
    server = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      undefined,
      service,
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()

    if (!address || typeof address === 'string') throw new Error('Expected a TCP server')
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  })

  const request = async (path = 'source', destination = 'copy') => ({
    path,
    destination,
    title: 'Copied adventure',
    expectedRevision: (await service.inspect(path)).revision,
  })

  const post = (body: unknown, contentType = 'application/json') =>
    fetch(`${base}/api/editor/projects/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: JSON.stringify(body),
    })

  const withWorkspace = (overrides: Partial<ProjectWorkspace>) =>
    new EditorProjectService(
      new WorkspaceProjectRepository({
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        write: (path, bytes) => workspace.write(path, bytes),
        createDirectory: (path) => workspace.createDirectory(path),
        removeDirectory: (path) => workspace.removeDirectory(path),
        create: (path, bytes) => workspace.create(path, bytes),
        removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
        ...overrides,
      }),
      new EditorCoordinator(),
    )

  it('copies saved definitions, catalogs, stylesheets, binary and unused assets without changing the source', async () => {
    const original = JSON.parse(await readFile(join(root, 'source/game.json'), 'utf8'))
    original.extension = { keep: true }
    original.assets = 'pictures'
    await mkdir(join(root, 'source/assets/images'), { recursive: true })
    await writeFile(
      join(root, 'source/assets/images/potion.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#336699"/></svg>',
    )
    await writeFile(
      join(root, 'source/assets/pictures.json'),
      JSON.stringify({
        'schema-version': '1.0.0',
        images: {
          potion: {
            format: 'svg',
            source: 'assets/images/potion.svg',
            bounds: { x: 0, y: 0, width: 32, height: 32 },
          },
        },
      }),
    )
    await writeFile(join(root, 'source/game.json'), JSON.stringify(original))
    await mkdir(join(root, 'source/notes/deep'), { recursive: true })
    await writeFile(
      join(root, 'source/notes/deep/unused.bin'),
      new Uint8Array([0, 255, 128, 13, 10]),
    )
    await writeFile(join(root, 'source/notes/empty.txt'), '')
    const before = await service.inspect('source')
    const sourceBytes = await workspace.read('source/game.json')
    const response = await post({ ...(await request()), title: '  Copied adventure  ' })
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const view = projectViewSchema.parse(await response.json())
    expect(view.diagnostics).toEqual([])
    expect(view.game).toMatchObject({
      id: 'copy',
      title: 'Copied adventure',
      version: before.game!.version,
    })
    const manifest = JSON.parse(await readFile(join(root, 'copy/game.json'), 'utf8'))
    expect(manifest.extension).toEqual({ keep: true })
    expect(manifest).not.toHaveProperty('titleKey')
    expect(await workspace.read('source/game.json')).toEqual(sourceBytes)
    expect((await service.inspect('source')).revision).toBe(before.revision)

    for (const file of [
      'scenes/standard.json',
      'rules/rules.json',
      'museum.css',
      'languages/nl/messages.json',
      'notes/deep/unused.bin',
      'notes/empty.txt',
      ...Object.values(before.assets!.images).map((image) => image.source),
    ]) {
      expect(await workspace.read(`copy/${file}`)).toEqual(await workspace.read(`source/${file}`))
    }

    const game = await new GameLoader(
      new JsonResourceLoader(
        {
          readText: async (file) =>
            Buffer.from(await workspace.read(`copy/${file}`)).toString('utf8'),
          readBytes: (file) => workspace.read(`copy/${file}`),
        },
        logger,
      ),
    ).load()

    game.localization!.select('nl')
    expect(game.localization!.current.title).toBe('Copied adventure')
    expect((await (await fetch(`${base}/api/editor/projects`)).json()).projects).toContainEqual({
      path: 'copy',
      title: 'Copied adventure',
    })
    expect(view.history).toEqual({ canUndo: false, canRedo: false })
  })

  it.each(['', 'group/original'])(
    'copies a project at %j without including nested games or workspace metadata',
    async (path) => {
      await cp(join(root, 'source'), path ? join(root, path) : root, { recursive: true })
      const source = path ? join(root, path) : root
      await mkdir(join(source, 'nested'))
      await writeFile(join(source, 'nested/game.json'), '{}')
      await mkdir(join(source, '.git'))
      await writeFile(join(source, '.git/keep'), 'metadata')
      await writeFile(join(source, '.env.local'), 'TEST_ONLY=example')
      await mkdir(join(source, 'node_modules'))
      await writeFile(join(source, 'node_modules/keep'), 'dependency')
      await symlink(join(root, 'source/museum.css'), join(source, 'linked.css'), 'file')
      expect((await post(await request(path))).status).toBe(201)
      const contents = await readdir(join(root, 'copy'))

      for (const excluded of [
        'nested',
        '.git',
        '.env.local',
        'node_modules',
        'linked.css',
        'source',
      ])
        expect(contents).not.toContain(excluded)
      expect((await service.inspect('copy')).diagnostics).toEqual([])
    },
  )

  it('keeps the new game ID different when the destination matches the source ID', async () => {
    const source = await service.inspect('source')
    const copy = await service.duplicate(await request('source', source.game!.id))
    expect(copy.game!.id).not.toBe(source.game!.id)
    expect(copy.game!.id).toBe(`${source.game!.id}-copy`)
    expect(
      duplicateProjectManifest(source.game, { destination: 'different', title: 'Copy' }).id,
    ).toBe('different')
  })

  it.each([
    '',
    '../outside',
    '/absolute',
    'nested/game',
    'bad name',
    'bad\\name',
    'CON',
    'x'.repeat(65),
  ])('rejects destination %j without changing the workspace', async (destination) => {
    const input = { ...(await request()), destination }
    expect((await post(input)).status).toBe(400)
    expect(await readdir(root)).toEqual(['source'])
  })

  it('rejects invalid titles, extra fields, malformed JSON and incorrect content types', async () => {
    const input = await request()
    expect(duplicateProjectRequestSchema.safeParse({ ...input, overwrite: true }).success).toBe(
      false,
    )
    expect((await post({ ...input, title: ' ' })).status).toBe(400)
    expect((await post({ ...input, title: 'x'.repeat(201) })).status).toBe(400)
    expect((await post({ ...input, overwrite: true })).status).toBe(400)
    expect((await post(input, 'text/plain')).status).toBe(415)
    expect(
      (
        await fetch(`${base}/api/editor/projects/duplicate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400)
    expect(await readdir(root)).toEqual(['source'])
  })

  it('rejects existing destinations and concurrent copies without overwriting them', async () => {
    await mkdir(join(root, 'empty'))
    await writeFile(join(root, 'file'), 'keep')

    for (const destination of ['source', 'empty', 'file'])
      expect((await post(await request('source', destination))).status).toBe(409)
    const input = await request()
    const results = await Promise.all([post(input), post(input)])
    expect(results.map(({ status }) => status).sort((a, b) => a - b)).toEqual([201, 409])
    expect((await service.inspect('copy')).diagnostics).toEqual([])
    expect(await readFile(join(root, 'file'), 'utf8')).toBe('keep')
    expect(await readdir(join(root, 'empty'))).toEqual([])
  })

  it('rejects a stale source revision or invalid project before creating a destination', async () => {
    const input = await request()
    const manifest = JSON.parse(await readFile(join(root, 'source/game.json'), 'utf8'))
    await writeFile(
      join(root, 'source/game.json'),
      JSON.stringify({ ...manifest, title: 'Changed' }),
    )
    expect((await post(input)).status).toBe(409)
    await writeFile(join(root, 'source/scenes/standard.json'), '{')
    expect((await post(await request())).status).toBe(422)
    expect(await readdir(root)).toEqual(['source'])
  })

  it('rolls back an incomplete destination when writing fails', async () => {
    const failing = withWorkspace({
      create: async (file, bytes) => {
        if (file === 'copy/scenes/standard.json') throw new Error('Disk failure')

        return workspace.create(file, bytes)
      },
    })

    await expect(failing.duplicate(await request())).rejects.toThrow('Disk failure')
    expect(await readdir(root)).toEqual(['source'])
    expect((await service.inspect('source')).diagnostics).toEqual([])
  })

  it('checks the source again before publication and rolls back copies of changed files', async () => {
    let changed = false

    const failing = withWorkspace({
      create: async (file, bytes) => {
        await workspace.create(file, bytes)

        if (!changed) {
          changed = true

          const manifest = JSON.parse(
            Buffer.from(await workspace.read('source/game.json')).toString('utf8'),
          )

          await workspace.write(
            'source/game.json',
            Buffer.from(JSON.stringify({ ...manifest, title: 'External change' })),
          )
        }
      },
    })

    await expect(failing.duplicate(await request())).rejects.toMatchObject({
      code: 'revision_conflict',
    })
    expect(await readdir(root)).toEqual(['source'])
    expect((await service.inspect('source')).game!.title).toBe('External change')
  })

  it('preserves files edited by another writer during failed-copy cleanup and reports uncertainty', async () => {
    const failing = withWorkspace({
      create: async (file, bytes) => {
        await workspace.create(file, bytes)
        await workspace.write(file, Buffer.from('External destination edit'))
        throw new Error('Disk failure')
      },
    })

    await expect(failing.duplicate(await request())).rejects.toMatchObject({
      code: 'project_cleanup_failed',
      outcome: 'unknown',
    })
    const files = await readdir(join(root, 'copy'), { recursive: true })
    expect(files.length).toBeGreaterThan(0)
    expect((await service.inspect('source')).diagnostics).toEqual([])
  })

  it('reports a completed copy that cannot be reopened without retrying its creation', async () => {
    const repository = new WorkspaceProjectRepository(workspace)

    const failing = new EditorProjectService(
      {
        duplicate: (input) => repository.duplicate(input),
        load: async (path) => {
          if (path === 'copy') throw new Error('Read failed')

          return repository.load(path)
        },
        save: (path, change) => repository.save(path, change),
      },
      new EditorCoordinator(),
    )

    await expect(failing.duplicate(await request())).rejects.toMatchObject({
      code: 'project_duplication_uncertain',
      outcome: 'unknown',
    })
    expect((await service.inspect('copy')).diagnostics).toEqual([])
  })

  it('bounds project bytes and file counts before creating any destination', async () => {
    await expect(
      readProjectCopyFiles(
        {
          list: async () => ({ entries: [{ name: 'large.bin', type: 'file' }] }),
          read: async () => new Uint8Array(maxDuplicateProjectBytes + 1),
        },
        'source',
        new Set(),
      ),
    ).rejects.toMatchObject({
      status: 413,
      code: 'project_too_large',
      message: 'Project duplication and export support at most 128 MiB',
    })
    await expect(
      readProjectCopyFiles(
        {
          list: async () => ({
            entries: Array.from({ length: maxDuplicateProjectFiles + 1 }, (_, index) => ({
              name: String(index),
              type: 'file' as const,
            })),
          }),
          read: async () => new Uint8Array(),
        },
        'source',
        new Set(),
      ),
    ).rejects.toMatchObject({ status: 413, code: 'project_too_large' })
  })

  it('copies a directory whose referenced document is named game.json', async () => {
    const original = JSON.parse(await readFile(join(root, 'source/game.json'), 'utf8'))

    const scene = JSON.parse(
      await readFile(join(root, `source/scenes/${original.scenes[0]}.json`), 'utf8'),
    )

    await writeFile(join(root, 'source/scenes/game.json'), JSON.stringify({ ...scene, id: 'game' }))
    await writeFile(
      join(root, 'source/game.json'),
      JSON.stringify({ ...original, scenes: [...original.scenes, 'game'] }),
    )
    expect((await service.duplicate(await request())).diagnostics).toEqual([])
    expect(await readFile(join(root, 'copy/scenes/game.json'), 'utf8')).toBe(
      await readFile(join(root, 'source/scenes/game.json'), 'utf8'),
    )
  })
})
