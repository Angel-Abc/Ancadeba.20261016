import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createProjectRequestSchema,
  createStarterProject,
  projectViewSchema,
  validateProject,
} from '@ancadeba/editor-core'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader, type ILogger } from '@ancadeba/utilities'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { exportGame } from '../tooling/game-export.js'

const request = { path: 'my-adventure', title: 'My adventure', description: 'A new story' }
const logger: ILogger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

describe('new project creation', () => {
  let root: string
  let workspace: FileWorkspace
  let service: EditorProjectService
  let server: Server
  let base: string

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-project-creation-', import.meta.url)))
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

  const post = (body: unknown) =>
    fetch(`${base}/api/editor/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  const withWorkspace = (overrides: Partial<ProjectWorkspace>) =>
    new EditorProjectService(
      new WorkspaceProjectRepository({
        list: (path) => workspace.list(path),
        read: (path) => workspace.read(path),
        write: (path, bytes) => workspace.write(path, bytes),
        create: (path, bytes) => workspace.create(path, bytes),
        removeCreated: (path, bytes) => workspace.removeCreated(path, bytes),
        createDirectory: (path) => workspace.createDirectory(path),
        removeDirectory: (path) => workspace.removeDirectory(path),
        ...overrides,
      }),
      new EditorCoordinator(),
    )

  it('creates a valid, discoverable, editable starter game that loads and exports', async () => {
    expect(validateProject(createStarterProject(request))).toEqual([])
    const response = await post(request)
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const view = projectViewSchema.parse(await response.json())
    expect(view.diagnostics).toEqual([])
    expect(view.game).toMatchObject({
      id: request.path,
      title: request.title,
      'initial-scene': 'start',
    })
    expect(view.scenes.map(({ id }) => id)).toEqual(['start', 'adventure'])
    expect(view.scenes[0]!.components.find(({ id }) => id === 'play')).toMatchObject({
      action: { type: 'new-game', scene: 'adventure' },
    })
    await expect(service.inspect(request.path)).resolves.toEqual(view)
    const listing = await fetch(`${base}/api/editor/projects`)
    await expect(listing.json()).resolves.toEqual({
      projects: [{ path: request.path, title: request.title }],
    })

    const game = await new GameLoader(
      new JsonResourceLoader(
        {
          readText: async (file) =>
            Buffer.from(await workspace.read(`${request.path}/${file}`)).toString('utf8'),
          readBytes: (file) => workspace.read(`${request.path}/${file}`),
        },
        logger,
      ),
    ).load()

    expect(game.initialScene).toBe('start')
    expect(game.scenes.get('adventure')?.type).toBe('game')
    expect(game.stylesheet).toContain('--ge-scene-font-size: clamp(14px, 3cqw, 22px)')
    await expect(
      service.apply({
        path: request.path,
        expectedRevision: view.revision,
        command: {
          type: 'game.updateMetadata',
          title: 'Edited',
          description: '',
          version: '1.0.0',
        },
      }),
    ).resolves.toMatchObject({ view: { game: { title: 'Edited' } } })
    await exportGame({
      gameDirectory: join(root, request.path),
      outputDirectory: join(root, 'exported'),
    })
    expect(await readFile(join(root, 'exported/index.html'), 'utf8')).toContain('<!doctype html>')
  })

  it.each([
    '',
    '../escape',
    '/absolute',
    'nested/game',
    'folder\\game',
    'bad name',
    'CON',
    'NUL.txt',
  ])('rejects unsafe or unsupported destination %j without creating files', async (path) => {
    expect((await post({ ...request, path })).status).toBe(400)
    expect(await readdir(root)).toEqual([])
  })

  it.each(['', '   '])('rejects an empty title %j', async (title) => {
    expect((await post({ ...request, title })).status).toBe(400)
    expect(await readdir(root)).toEqual([])
  })

  it('rejects unsupported fields, malformed JSON, and incorrect content types', async () => {
    expect(
      createProjectRequestSchema.safeParse({ ...request, title: 'x'.repeat(201) }).success,
    ).toBe(false)
    expect((await post({ ...request, overwrite: true })).status).toBe(400)
    expect(
      (
        await fetch(`${base}/api/editor/projects`, {
          method: 'POST',
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(415)
    expect(
      (
        await fetch(`${base}/api/editor/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400)
    expect(await readdir(root)).toEqual([])
  })

  it('never reuses existing empty folders, game folders, files, or links', async () => {
    await mkdir(join(root, 'empty'))
    await writeFile(join(root, 'file'), 'keep')
    await service.create(request)
    const original = await workspace.read(`${request.path}/game.json`)
    const linked = join(root, 'linked')
    await symlink(
      join(root, request.path),
      linked,
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    for (const path of ['empty', 'file', request.path])
      expect((await post({ ...request, path })).status).toBe(409)
    expect((await post({ ...request, path: 'linked' })).status).toBe(403)
    expect(await readdir(join(root, 'empty'))).toEqual([])
    expect(await readFile(join(root, 'file'), 'utf8')).toBe('keep')
    expect(await workspace.read(`${request.path}/game.json`)).toEqual(original)
  })

  it('allows only one concurrent creator for the same folder', async () => {
    const responses = await Promise.all([post(request), post(request)])
    expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual([201, 409])
    expect((await service.inspect(request.path)).diagnostics).toEqual([])
  })

  it.each(['scenes/start.json', 'game.json'])(
    'cleans a failed publication of %s so creation can be retried',
    async (target) => {
      const failing = withWorkspace({
        create: async (path, bytes) => {
          if (path === `${request.path}/${target}`) throw new Error('Disk failure')
          await workspace.create(path, bytes)
        },
      })

      await expect(failing.create(request)).rejects.toThrow('Disk failure')
      expect(await readdir(root)).toEqual([])
      await expect(service.create(request)).resolves.toMatchObject({ diagnostics: [] })
    },
  )

  it('recognizes a manifest saved before a storage error was reported', async () => {
    const failing = withWorkspace({
      create: async (path, bytes) => {
        await workspace.create(path, bytes)

        if (path.endsWith('/game.json')) throw new Error('Cleanup failed after publication')
      },
    })

    await expect(failing.create(request)).resolves.toMatchObject({ diagnostics: [] })
  })

  it('identifies a committed project if reopening its saved files fails', async () => {
    const failing = withWorkspace({
      read: async () => {
        throw new Error('Read failed')
      },
    })

    await expect(failing.create(request)).rejects.toMatchObject({
      code: 'project_creation_uncertain',
    })
    expect((await service.inspect(request.path)).diagnostics).toEqual([])
  })

  it('preserves external changes during rollback and reports the uncertain folder', async () => {
    const failing = withWorkspace({
      create: async (path, bytes) => {
        if (path.endsWith('/game.json')) {
          await workspace.write(`${request.path}/scenes/start.json`, Buffer.from('external edit'))
          throw new Error('Disk failure')
        }

        await workspace.create(path, bytes)
      },
    })

    await expect(failing.create(request)).rejects.toMatchObject({ code: 'project_cleanup_failed' })
    expect(await readFile(join(root, request.path, 'scenes/start.json'), 'utf8')).toBe(
      'external edit',
    )
    await expect(service.create(request)).rejects.toMatchObject({ code: 'project_exists' })
  })
})
