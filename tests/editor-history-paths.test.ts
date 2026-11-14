import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import {
  WorkspaceProjectRepository,
  type ProjectWorkspace,
} from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'

describe('project history path identity', () => {
  let root: string
  let workspace: FileWorkspace
  let service: EditorProjectService

  const createService = (source: ProjectWorkspace) =>
    new EditorProjectService(new WorkspaceProjectRepository(source), new EditorCoordinator())

  const save = async (path: string, title: string) =>
    service.apply({
      path,
      expectedRevision: (await service.inspect(path)).revision,
      command: { type: 'game.updateMetadata', title, description: '', version: '1' },
    })

  const restore = async (path: string, direction: 'undo' | 'redo') =>
    service.restore({ path, direction, expectedRevision: (await service.inspect(path)).revision })

  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-history-paths-', import.meta.url)))
    workspace = await FileWorkspace.open(root)
    service = createService(workspace)
    await service.create({ path: 'game', title: 'Original' })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe.runIf(process.platform === 'win32')('Windows filesystem aliases', () => {
    it('shares a nested project stack across aliases when saving, undoing and redoing', async () => {
      await workspace.createDirectory('group')
      await workspace.moveDirectory('game', 'group/game')
      await save('group/game', 'First')
      const second = await save('GROUP/GAME', 'Second')

      expect((await service.inspect('GrOuP/GaMe')).history).toEqual(second.view.history)
      expect((await restore('GROUP/game', 'undo')).game?.title).toBe('First')
      expect((await restore('group/GAME', 'undo')).game?.title).toBe('Original')
      expect((await service.inspect('GROUP/GAME')).history).toMatchObject({
        canUndo: false,
        canRedo: true,
      })
      expect((await restore('GrOuP/GaMe', 'redo')).game?.title).toBe('First')
      expect((await restore('group/game', 'redo')).game?.title).toBe('Second')
    })

    it('clears the shared redo branch after an edit through another alias', async () => {
      await save('game', 'First')
      await restore('GAME', 'undo')
      await save('GaMe', 'Branch')

      expect((await service.inspect('GAME')).history).toMatchObject({
        canUndo: true,
        canRedo: false,
      })
      await expect(restore('game', 'redo')).rejects.toMatchObject({ code: 'history_empty' })
      expect((await restore('GAME', 'undo')).game?.title).toBe('Original')
    })

    it.each(['title', 'move', 'delete'] as const)(
      'clears shared history after project management through an alias: %s',
      async (operation) => {
        await save('game', 'Changed')
        const { revision } = await service.inspect('GAME')

        if (operation === 'title') {
          await service.rename({ path: 'GaMe', expectedRevision: revision, title: 'Renamed' })
        } else if (operation === 'move') {
          const moved = await service.rename({
            path: 'GAME',
            expectedRevision: revision,
            folderName: 'moved',
          })

          expect(moved.history).toMatchObject({ canUndo: false, canRedo: false })
          await service.rename({
            path: 'MOVED',
            expectedRevision: moved.revision,
            folderName: 'game',
          })
        } else {
          const deleted = await service.delete({
            path: 'GAME',
            expectedRevision: revision,
            confirm: true,
          })

          await service.restoreProject({
            trashId: deleted.trashId,
            expectedRevision: deleted.revision,
          })
        }

        expect((await service.inspect('game')).history).toMatchObject({
          canUndo: false,
          canRedo: false,
        })
        await expect(restore('GAME', 'undo')).rejects.toMatchObject({ code: 'history_empty' })
      },
    )

    it('shares exact repair history with clients using the original path', async () => {
      const file = 'scenes/start.json'
      const original = await workspace.read(`game/${file}`)
      const broken = Buffer.from('{')
      await workspace.write(`game/${file}`, broken)
      const current = await service.inspect('GAME')
      await service.repair({
        path: 'GaMe',
        expectedRevision: current.revision,
        file,
        text: Buffer.from(original).toString('utf8'),
      })

      expect((await service.inspect('game')).history?.canUndo).toBe(true)
      await restore('game', 'undo')
      expect(await workspace.read(`game/${file}`)).toEqual(broken)
      await restore('GAME', 'redo')
      expect(await workspace.read(`game/${file}`)).toEqual(original)
    })

    it('shares imported asset history across aliases', async () => {
      const { revision } = await service.inspect('GAME')
      await service.importAsset(
        { path: 'GaMe', expectedRevision: revision, id: 'icon', format: 'svg' },
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>'),
      )

      expect((await service.inspect('game')).history?.canUndo).toBe(true)
      expect((await restore('game', 'undo')).assets).toBeUndefined()
      expect((await restore('GAME', 'redo')).assets?.images.icon).toBeDefined()
    })
  })

  it('keeps distinct projects from a case-sensitive repository separate', async () => {
    // Separate backing folders model a case-sensitive backend on any host filesystem.
    const physical = (path: string) =>
      path.replace(/^game(?=\/|$)/, 'lower').replace(/^GAME(?=\/|$)/, 'upper')

    service = createService({
      canonicalDirectoryPath: async (path) => path,
      list: (path) => workspace.list(physical(path)),
      read: (path) => workspace.read(physical(path)),
      write: (path, bytes) => workspace.write(physical(path), bytes),
      create: (path, bytes) => workspace.create(physical(path), bytes),
      removeCreated: (path, bytes) => workspace.removeCreated(physical(path), bytes),
      createDirectory: (path) => workspace.createDirectory(physical(path)),
      removeDirectory: (path) => workspace.removeDirectory(physical(path)),
    })
    await service.create({ path: 'game', title: 'Lower original' })
    await service.create({ path: 'GAME', title: 'Upper original' })
    await save('game', 'Lower change')
    await save('GAME', 'Upper change')

    expect((await restore('game', 'undo')).game?.title).toBe('Lower original')
    expect((await service.inspect('GAME')).game?.title).toBe('Upper change')
    expect((await service.inspect('GAME')).history?.canUndo).toBe(true)
    expect((await restore('GAME', 'undo')).game?.title).toBe('Upper original')
    expect((await restore('game', 'redo')).game?.title).toBe('Lower change')
  })
})
