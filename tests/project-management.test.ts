import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import {
  managedProjectPathSchema,
  projectRegistryFile,
  projectTrashDirectory,
} from '@ancadeba/editor-core'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { listWorkspaceProjects } from '../apps/editor-server/src/workspaceProjects.js'
import { createEditorServer } from '../apps/editor-server/src/server.js'

describe('project renaming and recoverable deletion', () => {
  let root: string
  let workspace: FileWorkspace
  let service: EditorProjectService
  let server: Server | undefined

  const withWorkspace = (overrides: Partial<ProjectWorkspace> = {}) =>
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

  const revision = async (path = 'source') => (await service.inspect(path)).revision

  const remove = async (path = 'source') =>
    service.delete({ path, expectedRevision: await revision(path), confirm: true })

  const rename = async (fields: { title?: string; folderName?: string }, path = 'source') =>
    service.rename({ path, expectedRevision: await revision(path), ...fields })

  const manifest = async (path = 'source') =>
    JSON.parse(await readFile(join(root, path, 'game.json'), 'utf8'))

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-project-management-', import.meta.url)))
    workspace = await FileWorkspace.open(root)
    service = withWorkspace()
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
  it('renames title and directory, preserves ID, arbitrary files and preview save namespace', async () => {
    const original = await service.inspect('source')
    await writeFile(join(root, 'source', 'notes.txt'), 'Keep me')
    const result = await rename({ title: ' Renamed ', folderName: 'renamed' })
    expect(result).toMatchObject({
      path: 'renamed',
      previousPath: 'source',
      storageKey: 'source',
      game: { id: original.game!.id, title: 'Renamed' },
    })
    expect(await readFile(join(root, 'renamed', 'notes.txt'), 'utf8')).toBe('Keep me')
    expect(await readdir(root)).not.toContain('source')
    const reopened = withWorkspace()
    expect((await reopened.inspect('renamed')).storageKey).toBe('source')
    await reopened.create({ path: 'source', title: 'Another' })
    expect((await reopened.inspect('source')).storageKey).toMatch(/^project:/)
  })
  it('title-only changes preserve extensions and remove the title translation key', async () => {
    const game = await manifest()
    await writeFile(
      join(root, 'source', 'game.json'),
      JSON.stringify({ ...game, titleKey: 'title', extension: { author: 'Test' } }),
    )
    const result = await rename({ title: 'Literal title' })
    expect(result.path).toBe('source')
    expect(await manifest()).toMatchObject({
      ...game,
      title: 'Literal title',
      extension: { author: 'Test' },
    })
    expect(await manifest()).not.toHaveProperty('titleKey')
    expect(await readdir(root)).toEqual(['source'])
  })
  it('folder-only rename keeps exact manifest bytes and content revision', async () => {
    const before = await readFile(join(root, 'source', 'game.json'))
    const old = await revision()
    const result = await rename({ folderName: 'moved' })
    expect(result.revision).toBe(old)
    expect(await readFile(join(root, 'moved', 'game.json'))).toEqual(before)
    expect((await rename({ folderName: 'again' }, 'moved')).storageKey).toBe('source')
  })
  it('keeps the parent of a nested project folder', async () => {
    await mkdir(join(root, 'parent'))
    await workspace.moveDirectory('source', 'parent/source')
    expect((await rename({ folderName: 'new' }, 'parent/source')).path).toBe('parent/new')
    expect(await readdir(join(root, 'parent'))).toEqual(['new'])
  })
  it('moves projects with a missing manifest without changing their guarded recovery revision', async () => {
    await rm(join(root, 'source', 'game.json'))
    const before = await revision()
    expect((await rename({ folderName: 'new' })).revision).toBe(before)
    const deleted = await remove('new')
    expect(
      (
        await service.restoreProject({
          trashId: deleted.trashId,
          expectedRevision: deleted.revision,
        })
      ).revision,
    ).toBe(before)
  })
  it('does not treat arbitrary workspace folders as projects', async () => {
    await mkdir(join(root, 'notes'))
    await expect(rename({ folderName: 'moved' }, 'notes')).rejects.toMatchObject({
      code: 'project_not_found',
    })
    await expect(remove('notes')).rejects.toMatchObject({ code: 'project_not_found' })
    expect(await readdir(root)).toContain('notes')
  })
  it('permits root title changes and protects the workspace directory from moves and deletion', async () => {
    await cp(join(root, 'source', 'game.json'), join(root, 'game.json'))
    expect((await rename({ title: 'Workspace title' }, '')).path).toBe('')
    await expect(rename({ folderName: 'root' }, '')).rejects.toMatchObject({
      code: 'protected_project',
    })
    await expect(remove('')).rejects.toMatchObject({ code: 'invalid_request' })
    expect((await manifest('')).title).toBe('Workspace title')
  })
  it.each([
    '',
    '../outside',
    'a/../b',
    '/root',
    'C:/root',
    '.git/game',
    'a/.ancadeba-trash',
    'node_modules/game',
    'game/',
    'a//b',
    'game.',
    'CON',
    'a\\b',
  ])('rejects unmanaged path %j', (path) => {
    expect(managedProjectPathSchema.safeParse(path).success).toBe(false)
  })
  it('rejects missing confirmation, stale revisions and a rename without changes', async () => {
    await expect(async () =>
      service.delete({ path: 'source', expectedRevision: await revision() }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(async () =>
      service.rename({ path: 'source', expectedRevision: await revision() }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      service.rename({ path: 'source', expectedRevision: 'stale', title: 'New' }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    await expect(
      service.delete({ path: 'source', expectedRevision: 'stale', confirm: true }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    expect((await manifest()).title).toBe('Original')
  })
  it('does not overwrite occupied empty folders or edit their manifest', async () => {
    await mkdir(join(root, 'occupied'))
    await expect(rename({ folderName: 'occupied', title: 'New' })).rejects.toMatchObject({
      status: 409,
    })
    expect(await readdir(join(root, 'occupied'))).toEqual([])
    expect((await manifest()).title).toBe('Original')
  })
  it('refuses to move or delete a folder containing another game, including a damaged manifest', async () => {
    await mkdir(join(root, 'source', 'child'))
    await writeFile(join(root, 'source', 'child', 'game.json'), '{ damaged')
    await expect(rename({ folderName: 'new' })).rejects.toMatchObject({ code: 'nested_projects' })
    await expect(remove()).rejects.toMatchObject({ code: 'nested_projects' })
    expect((await rename({ title: 'Parent title' })).game!.title).toBe('Parent title')
  })
  it('moves all project files into trash, hides them from discovery, and restores them', async () => {
    const original = await service.inspect('source')
    await writeFile(join(root, 'source', '.env'), 'private-data')
    const deleted = await remove()
    expect(deleted).toMatchObject({
      path: 'source',
      title: 'Original',
      revision: original.revision,
    })
    expect(await listWorkspaceProjects(workspace)).toEqual([])
    expect(await service.listDeleted()).toEqual([deleted])

    const restored = await withWorkspace().restoreProject({
      trashId: deleted.trashId,
      expectedRevision: deleted.revision,
    })

    expect(restored).toMatchObject({
      path: 'source',
      storageKey: 'source',
      game: { id: original.game!.id },
    })
    expect(await readFile(join(root, 'source', '.env'), 'utf8')).toBe('private-data')
    expect(await service.listDeleted()).toEqual([])
  })
  it('restores to an alternate unused destination when the original name is reused', async () => {
    const deleted = await remove()
    await service.create({ path: 'source', title: 'Replacement' })
    const replacement = await service.inspect('source')
    expect(replacement.storageKey).not.toBe('source')
    await expect(
      service.restoreProject({ trashId: deleted.trashId, expectedRevision: deleted.revision }),
    ).rejects.toMatchObject({ status: 409 })

    const restored = await service.restoreProject({
      trashId: deleted.trashId,
      expectedRevision: deleted.revision,
      destination: 'recovered',
    })

    expect(restored.storageKey).toBe('source')
    expect((await service.inspect('source')).storageKey).toBe(replacement.storageKey)
    expect((await manifest()).title).toBe('Replacement')
  })
  it('checks the current trash revision before restoration', async () => {
    const deleted = await remove()
    const path = `${projectTrashDirectory}/${deleted.trashId}/project`
    const game = await manifest(path)
    await writeFile(
      join(root, path, 'game.json'),
      JSON.stringify({ ...game, title: 'Recovered externally' }),
    )
    await expect(
      service.restoreProject({ trashId: deleted.trashId, expectedRevision: deleted.revision }),
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    const listed = (await service.listDeleted())[0]!
    expect(listed.revision).not.toBe(deleted.revision)
    expect(
      (await service.restoreProject({ trashId: listed.trashId, expectedRevision: listed.revision }))
        .game!.title,
    ).toBe('Recovered externally')
  })
  it('keeps damaged trash records on disk and excludes them from the restore list', async () => {
    const deleted = await remove()
    const record = join(root, projectTrashDirectory, deleted.trashId, 'record.json')
    await writeFile(record, '{}')
    expect(await service.listDeleted()).toEqual([])
    await expect(
      service.restoreProject({ trashId: deleted.trashId, expectedRevision: deleted.revision }),
    ).rejects.toMatchObject({ code: 'invalid_trash_entry' })
    expect(await readFile(record, 'utf8')).toBe('{}')
  })
  it('rolls back the directory and title if save-namespace publication fails', async () => {
    const failing = withWorkspace({
      create: async (path, bytes) => {
        if (path === projectRegistryFile) throw new Error('Cannot publish registry')

        return workspace.create(path, bytes)
      },
    })

    const old = await readFile(join(root, 'source', 'game.json'))
    await expect(
      failing.rename({
        path: 'source',
        expectedRevision: await revision(),
        folderName: 'new',
        title: 'New',
      }),
    ).rejects.toBeDefined()
    expect(await readdir(root)).toEqual(['source'])
    expect(await readFile(join(root, 'source', 'game.json'))).toEqual(old)
  })
  it('rolls deletion back if save-namespace publication fails', async () => {
    const failing = withWorkspace({
      create: async (path, bytes) => {
        if (path === projectRegistryFile) throw new Error('Cannot publish registry')

        return workspace.create(path, bytes)
      },
    })

    await expect(
      failing.delete({ path: 'source', expectedRevision: await revision(), confirm: true }),
    ).rejects.toBeDefined()
    expect((await manifest()).title).toBe('Original')
    expect(await service.listDeleted()).toEqual([])
  })
  it('rolls restoration back if namespace publication fails and keeps the trash recoverable', async () => {
    const deleted = await remove()

    const failing = withWorkspace({
      write: async (path, bytes) => {
        if (path === projectRegistryFile) throw new Error('Cannot publish registry')

        return workspace.write(path, bytes)
      },
    })

    await expect(
      failing.restoreProject({ trashId: deleted.trashId, expectedRevision: deleted.revision }),
    ).rejects.toBeDefined()
    expect(await readdir(root)).not.toContain('source')
    expect(await service.listDeleted()).toEqual([deleted])
    expect(
      (
        await service.restoreProject({
          trashId: deleted.trashId,
          expectedRevision: deleted.revision,
        })
      ).path,
    ).toBe('source')
  })
  it('preserves outside edits and rolls back when a nested game appears during rename', async () => {
    const conflicting = withWorkspace({
      moveDirectory: async (from, to) => {
        await workspace.moveDirectory(from, to)

        if (from === 'source') {
          await mkdir(join(root, to, 'child'))
          await writeFile(join(root, to, 'child', 'game.json'), '{ outside change')
        }
      },
    })

    await expect(
      conflicting.rename({ path: 'source', expectedRevision: await revision(), folderName: 'new' }),
    ).rejects.toMatchObject({ code: 'nested_projects' })
    expect(await readFile(join(root, 'source', 'child', 'game.json'), 'utf8')).toBe(
      '{ outside change',
    )
    expect(await readdir(root)).toEqual(['source'])
  })
  it.skipIf(process.platform !== 'win32')(
    'supports a case-only folder rename while keeping its save namespace',
    async () => {
      const result = await rename({ folderName: 'Source' })
      expect(result).toMatchObject({ path: 'Source', storageKey: 'source' })
      expect(await readdir(root)).toContain('Source')
    },
  )
  it('clears authoring undo history after project operations', async () => {
    await service.apply({
      path: 'source',
      expectedRevision: await revision(),
      command: { type: 'game.updateMetadata', title: 'Edited', description: '', version: '1' },
    })
    expect((await service.inspect('source')).history?.canUndo).toBe(true)
    expect((await rename({ folderName: 'new' })).history?.canUndo).toBe(false)
    const deleted = await remove('new')
    expect(
      (
        await service.restoreProject({
          trashId: deleted.trashId,
          expectedRevision: deleted.revision,
        })
      ).history?.canUndo,
    ).toBe(false)
  })
  it('supports HTTP rename/delete/list/restore and blocks direct access to managed metadata', async () => {
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

    const post = (operation: string, body: unknown) =>
      fetch(`${base}/api/editor/projects/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    expect(
      (
        await post('rename', {
          path: 'source',
          expectedRevision: await revision(),
          folderName: 'new',
        })
      ).status,
    ).toBe(200)

    const deletedResponse = await post('delete', {
      path: 'new',
      expectedRevision: await revision('new'),
      confirm: true,
    })

    expect(deletedResponse.status).toBe(200)
    const deleted = await deletedResponse.json()
    expect(await (await fetch(`${base}/api/editor/projects/trash`)).json()).toEqual({
      projects: [deleted],
    })

    for (const endpoint of ['files', 'workspace', 'editor/project']) {
      expect(
        (
          await fetch(
            `${base}/api/${endpoint}?path=${projectTrashDirectory}/${deleted.trashId}/project/game.json`,
          )
        ).status,
      ).toBe(403)
    }

    expect(
      (await fetch(`${base}/api/files?path=${projectRegistryFile}`, { method: 'PUT', body: '{}' }))
        .status,
    ).toBe(403)
    expect(
      (await post('restore', { trashId: deleted.trashId, expectedRevision: deleted.revision }))
        .status,
    ).toBe(200)
    expect(
      (await fetch(`${base}/api/editor/projects/rename`, { method: 'POST', body: '{}' })).status,
    ).toBe(415)
  })
  it('renames and deletes a project whose referenced document is named Game.json', async () => {
    await mkdir(join(root, 'source/inventory'))
    await writeFile(
      join(root, 'source/inventory/Game.json'),
      JSON.stringify({ 'schema-version': '1.0.0', itemTypes: {}, owners: {}, items: {} }),
    )
    await writeFile(
      join(root, 'source/game.json'),
      JSON.stringify({ ...(await manifest()), inventory: ['Game'] }),
    )
    expect((await service.inspect('source')).diagnostics).toEqual([])
    expect((await rename({ folderName: 'renamed' })).path).toBe('renamed')
    await expect(remove('renamed')).resolves.toMatchObject({ path: 'renamed' })
  })
})
