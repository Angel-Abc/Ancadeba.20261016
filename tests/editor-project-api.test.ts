import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import type { Server } from 'node:http'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader, type ILogger } from '@ancadeba/utilities'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import type { ProjectView } from '@ancadeba/editor-core'

const manifest = {
  'schema-version': '1.0.0',
  id: 'test',
  title: 'Game',
  description: '',
  version: '1',
  scenes: [],
  extension: 'keep',
}

const scene = {
  'schema-version': '1.0.0',
  id: 'shop',
  title: 'Shop',
  description: '',
  type: 'stand-alone',
  screen: { type: 'grid', grid: { rows: 12, columns: 16, extension: 'keep' } },
  components: [],
  extension: 'keep',
}

describe('shared editor project API', () => {
  let root: string
  let base: string
  let workspace: FileWorkspace
  let server: Server
  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-editor-project-', import.meta.url)))
    await mkdir(join(root, 'basic'))
    await writeFile(join(root, 'basic/game.json'), JSON.stringify(manifest))
    workspace = await FileWorkspace.open(root)

    const projects = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )

    server = createEditorServer(
      { workFolder: root, host: '127.0.0.1', port: 3100 },
      workspace,
      undefined,
      projects,
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    // SAFETY: this server is listening on a TCP loopback port, not a Unix socket.
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(root, { recursive: true, force: true })
  })

  // SAFETY: this helper calls our editor project route, whose success response is ProjectView.
  const inspect = async () =>
    (await fetch(`${base}/api/editor/project?path=basic`)).json() as Promise<ProjectView>

  const command = (revision: string, operation: unknown, path = 'basic') =>
    fetch(`${base}/api/editor/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, expectedRevision: revision, command: operation }),
    })

  it('discovers, creates, edits, and loads the saved game through the unchanged engine loader', async () => {
    const capabilities = await fetch(`${base}/api/editor/capabilities`)
    expect((await capabilities.json()).commands).toHaveLength(10)
    const initial = await inspect()
    const created = await command(initial.revision, { type: 'scene.create', scene })
    expect(created.status).toBe(200)
    // SAFETY: the successful scene.create route returns the updated ProjectView.
    const first = (await created.json()) as ProjectView
    expect(first.revision).not.toBe(initial.revision)
    expect(first.game?.scenes).toEqual(['shop'])

    const updated = await command(first.revision, {
      type: 'scene.updateLayout',
      sceneId: 'shop',
      rows: 20,
      columns: 25,
    })

    expect(updated.status).toBe(200)
    const bytes = await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')
    expect(JSON.parse(bytes)).toMatchObject({
      extension: 'keep',
      screen: { grid: { rows: 20, columns: 25, extension: 'keep' } },
    })
    expect(JSON.parse(await readFile(join(root, 'basic/game.json'), 'utf8'))).toHaveProperty(
      'extension',
      'keep',
    )

    const logger: ILogger = {
      debug() {
        return ''
      },
      info() {
        return ''
      },
      warn() {
        return ''
      },
      error() {
        return ''
      },
    }

    const loader = new GameLoader(
      new JsonResourceLoader(
        {
          readText: async (path) =>
            Buffer.from(await workspace.read(`basic/${path}`)).toString('utf8'),
          readBytes: (path) => workspace.read(`basic/${path}`),
        },
        logger,
      ),
    )

    expect((await loader.load()).scenes.get('shop')?.screen.grid.rows).toBe(20)
    const inspected = await fetch(`${base}/api/editor/scene?path=basic&id=shop`)
    expect((await inspected.json()).scene.id).toBe('shop')
  })

  it('lets only one competing revision-checked edit succeed', async () => {
    const initial = await inspect()
    const operation = { type: 'game.updateMetadata', title: 'A', description: '', version: '1' }

    const results = await Promise.all([
      command(initial.revision, operation),
      command(initial.revision, { ...operation, title: 'B' }),
    ])

    expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 409])
    const rejected = results.find((result) => result.status === 409)!
    expect((await rejected.json()).code).toBe('revision_conflict')
  })

  it('detects raw API writes, direct filesystem changes, and input-file changes', async () => {
    const initial = await inspect()
    await fetch(`${base}/api/files?path=basic/game.json`, {
      method: 'PUT',
      body: JSON.stringify({ ...manifest, title: 'External' }),
    })

    const rejected = await command(initial.revision, {
      type: 'game.updateMetadata',
      title: 'Old',
      description: '',
      version: '1',
    })

    expect(rejected.status).toBe(409)
    await writeFile(
      join(root, 'basic/game.json'),
      JSON.stringify({ ...manifest, input: 'input.json' }),
    )

    const input = {
      'schema-version': '1.0.0',
      'virtual-keys': ['confirm'],
      keyboard: { Enter: 'confirm' },
      contexts: { menu: { confirm: 'accept' } },
      'initial-context': 'menu',
    }

    await writeFile(join(root, 'basic/input.json'), JSON.stringify(input))
    const before = await inspect()
    await writeFile(
      join(root, 'basic/input.json'),
      JSON.stringify({ ...input, keyboard: { Space: 'confirm' } }),
    )
    expect((await inspect()).revision).not.toBe(before.revision)
    const repository = new WorkspaceProjectRepository(workspace)
    expect((await repository.load('basic')).revision).toBe((await inspect()).revision)
  })

  it('does not overwrite orphan files and reports missing or malformed referenced documents', async () => {
    await mkdir(join(root, 'basic/scenes'))
    await writeFile(join(root, 'basic/scenes/shop.json'), 'orphan')
    const before = await inspect()
    const response = await command(before.revision, { type: 'scene.create', scene })
    expect(response.status).toBe(409)
    expect(await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')).toBe('orphan')
    expect((await inspect()).game?.scenes).toEqual([])
    await writeFile(
      join(root, 'basic/game.json'),
      JSON.stringify({ ...manifest, scenes: ['missing', 'shop'] }),
    )
    const invalid = await inspect()
    expect(invalid.diagnostics.map((item) => item.file)).toEqual([
      'scenes/missing.json',
      'scenes/shop.json',
    ])

    const rejected = await command(invalid.revision, {
      type: 'game.updateMetadata',
      title: 'X',
      description: '',
      version: '1',
    })

    expect(rejected.status).toBe(422)
    expect((await rejected.json()).diagnostics[0]).toHaveProperty('path')
  })

  it('rejects invalid commands and unsafe folders without changing saved content', async () => {
    const initial = await inspect()

    const invalid = await command(initial.revision, {
      type: 'scene.create',
      scene: { ...scene, id: '../escape' },
    })

    expect(invalid.status).toBe(400)
    expect((await invalid.json()).diagnostics.length).toBeGreaterThan(0)

    const badLayout = await command(initial.revision, {
      type: 'scene.updateLayout',
      sceneId: 'shop',
      rows: 0,
      columns: 1,
    })

    expect(badLayout.status).toBe(400)

    for (const path of ['../outside', 'C:/outside', 'basic/../outside']) {
      expect(
        (await command(initial.revision, { type: 'scene.create', scene }, path)).status,
      ).toBeGreaterThanOrEqual(400)
    }

    expect((await inspect()).revision).toBe(initial.revision)
    const plain = await fetch(`${base}/api/editor/commands`, { method: 'POST', body: '{}' })
    expect(plain.status).toBe(415)

    const malformed = await fetch(`${base}/api/editor/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })

    expect(malformed.status).toBe(400)
  })

  it('rejects scene writes through links', async () => {
    await mkdir(join(root, 'outside'))
    await symlink(
      join(root, 'outside'),
      join(root, 'basic/scenes'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const response = await command((await inspect()).revision, { type: 'scene.create', scene })
    expect(response.status).toBe(403)
    await expect(readFile(join(root, 'outside/shop.json'))).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('cleans a created scene after a failed manifest save and leaves the project usable', async () => {
    const failing: ProjectWorkspace = {
      list: (path) => workspace.list(path),
      read: (path) => workspace.read(path),
      create: (path, contents) => workspace.create(path, contents),
      removeCreated: (path, contents) => workspace.removeCreated(path, contents),
      write: async () => {
        throw new Error('Disk failure')
      },
    }

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(failing),
      new EditorCoordinator(),
    )

    const current = await service.inspect('basic')
    await expect(
      service.apply({
        path: 'basic',
        expectedRevision: current.revision,
        command: { type: 'scene.create', scene },
      }),
    ).rejects.toThrow('Disk failure')
    await expect(readFile(join(root, 'basic/scenes/shop.json'))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    )
    expect((await inspect()).revision).toBe(current.revision)
    const success = await command(current.revision, { type: 'scene.create', scene })
    expect(success.status).toBe(200)
  })

  it('reports failed cleanup and never deletes a scene changed by another writer', async () => {
    const failing: ProjectWorkspace = {
      list: (path) => workspace.list(path),
      read: (path) => workspace.read(path),
      create: (path, contents) => workspace.create(path, contents),
      removeCreated: (path, contents) => workspace.removeCreated(path, contents),
      write: async () => {
        await writeFile(join(root, 'basic/scenes/shop.json'), 'external edit')
        throw new Error('Disk failure')
      },
    }

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(failing),
      new EditorCoordinator(),
    )

    const current = await service.inspect('basic')
    await expect(
      service.apply({
        path: 'basic',
        expectedRevision: current.revision,
        command: { type: 'scene.create', scene },
      }),
    ).rejects.toMatchObject({ code: 'scene_cleanup_failed' })
    expect(await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')).toBe('external edit')
    expect((await inspect()).game?.scenes).toEqual([])
  })

  it('keeps a committed scene when manifest writing reports an error after publication', async () => {
    const uncertain: ProjectWorkspace = {
      list: (path) => workspace.list(path),
      read: (path) => workspace.read(path),
      create: (path, contents) => workspace.create(path, contents),
      removeCreated: (path, contents) => workspace.removeCreated(path, contents),
      write: async (path, contents) => {
        await workspace.write(path, contents)
        throw new Error('Cleanup failed after publication')
      },
    }

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(uncertain),
      new EditorCoordinator(),
    )

    const current = await service.inspect('basic')

    const result = await service.apply({
      path: 'basic',
      expectedRevision: current.revision,
      command: { type: 'scene.create', scene },
    })

    expect(result.view.game?.scenes).toEqual(['shop'])
    expect(result.view.diagnostics).toEqual([])
    expect(JSON.parse(await readFile(join(root, 'basic/scenes/shop.json'), 'utf8')).id).toBe('shop')
  })

  it('refuses rollback when a different manifest already references the created scene', async () => {
    const uncertain: ProjectWorkspace = {
      list: (path) => workspace.list(path),
      read: (path) => workspace.read(path),
      create: (path, contents) => workspace.create(path, contents),
      removeCreated: (path, contents) => workspace.removeCreated(path, contents),
      write: async (path) => {
        await workspace.write(
          path,
          Buffer.from(JSON.stringify({ ...manifest, title: 'External', scenes: ['shop'] })),
        )
        throw new Error('Publication outcome changed')
      },
    }

    const service = new EditorProjectService(
      new WorkspaceProjectRepository(uncertain),
      new EditorCoordinator(),
    )

    const current = await service.inspect('basic')
    await expect(
      service.apply({
        path: 'basic',
        expectedRevision: current.revision,
        command: { type: 'scene.create', scene },
      }),
    ).rejects.toMatchObject({ code: 'scene_cleanup_failed' })
    const saved = await inspect()
    expect(saved.game?.scenes).toEqual(['shop'])
    expect(saved.diagnostics).toEqual([])
  })
})
