import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  applyCommand,
  createStarterProject,
  inspectProject,
  type EditorCommand,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'
import { GameLoader } from '@ancadeba/game-runtime'
import { JsonResourceLoader } from '@ancadeba/utilities'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { WorkspaceProjectRepository } from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'

const css =
  '/* Custom theme — exact bytes */\r\n.ancadeba-scene {\r\n  --ge-scene-color: #f4f1e8;\r\n}\r\n'

const create = (): Extract<EditorCommand, { type: 'game.upsertStylesheet' }> => ({
  type: 'game.upsertStylesheet',
  file: 'styles/custom.css',
  css,
  createOnly: true,
  assign: true,
})

const project = (): ProjectSnapshot => ({
  revision: 'one',
  documents: createStarterProject({ path: 'game', title: 'Styled game', description: '' }),
})

describe('stylesheet commands', () => {
  it('creates and assigns raw CSS immutably, edits it, and retains files when changing assignments', () => {
    const source = project()
    const before = JSON.stringify(source)
    const saved = applyCommand(source, create())
    expect(JSON.stringify(source)).toBe(before)
    expect(saved.createdFiles).toEqual(['styles/custom.css'])
    expect(saved.changedFiles).toEqual(['styles/custom.css', 'game.json'])
    expect(inspectProject(saved.project).stylesheets).toEqual({
      'theme.css': source.documents['theme.css'],
      'styles/custom.css': css,
    })
    const edited = applyCommand(saved.project, { ...create(), createOnly: false, css: '' })
    expect(edited.project.documents['styles/custom.css']).toBe('')
    const detached = applyCommand(edited.project, { type: 'game.assignStylesheet', file: null })
    expect(inspectProject(detached.project).game?.stylesheet).toBeUndefined()
    expect(detached.project.documents['styles/custom.css']).toBe('')

    const assigned = applyCommand(detached.project, {
      type: 'game.assignStylesheet',
      file: 'theme.css',
    })

    expect(inspectProject(assigned.project).game?.stylesheet).toBe('theme.css')
    expect(assigned.project.documents['styles/custom.css']).toBe('')
  })

  it('rejects duplicate paths, case-only replacements, traversal and assignment to missing files', () => {
    const source = project()
    const before = JSON.stringify(source)

    for (const file of ['theme.css', 'THEME.css'])
      expect(() => applyCommand(source, { ...create(), file })).toThrow('already exists')
    expect(() =>
      applyCommand(source, { ...create(), file: 'THEME.css', createOnly: false }),
    ).toThrow('already exists')

    for (const file of [
      '../outside.css',
      '/absolute.css',
      'C:\\theme.css',
      'styles/../theme.css',
      'game.json',
      'styles/file.css/other.css',
    ])
      expect(() => applyCommand(source, { ...create(), file })).toThrow('Invalid editing command')
    expect(() =>
      applyCommand(source, { type: 'game.assignStylesheet', file: 'missing.css' }),
    ).toThrow('existing stylesheet')
    expect(JSON.stringify(source)).toBe(before)
  })

  it('repairs a missing assigned stylesheet by recreating it or removing the assignment', () => {
    const source = project()
    const documents = { ...source.documents }
    delete documents['theme.css']

    const missing = {
      ...source,
      documents,
      sourceDiagnostics: [
        { code: 'missing_file', file: 'theme.css', path: [], message: 'Missing stylesheet' },
      ],
    }

    expect(inspectProject(missing).diagnostics).not.toHaveLength(0)
    expect(
      inspectProject(applyCommand(missing, { ...create(), file: 'theme.css' }).project).diagnostics,
    ).toEqual([])
    expect(
      inspectProject(applyCommand(missing, { type: 'game.assignStylesheet', file: null }).project)
        .diagnostics,
    ).toEqual([])
    const invalid = { ...missing, documents: { ...documents, 'scenes/start.json': null } }
    expect(() => applyCommand(invalid, { ...create(), file: 'theme.css' })).toThrow(
      'Fix project diagnostics',
    )
  })

  it('does not overwrite registered artwork whose source happens to have a CSS extension', () => {
    const source = applyCommand(project(), {
      type: 'assets.upsertImage',
      id: 'art',
      image: {
        format: 'svg',
        source: 'art.css',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        colors: {},
        palettes: {},
      },
    }).project

    expect(() => applyCommand(source, { ...create(), file: 'art.css' })).toThrow(
      'registered artwork',
    )
  })
})

describe('stylesheet persistence', () => {
  let root: string
  let workspace: FileWorkspace
  let service: EditorProjectService
  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-stylesheet-authoring-', import.meta.url)))
    workspace = await FileWorkspace.open(root)
    service = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )
    await service.create({ path: 'game', title: 'Styled game' })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  const apply = async (command: EditorCommand) =>
    service.apply({
      path: 'game',
      expectedRevision: (await service.inspect('game')).revision,
      command,
    })

  const restore = async (direction: 'undo' | 'redo') =>
    service.restore({
      path: 'game',
      expectedRevision: (await service.inspect('game')).revision,
      direction,
    })

  it('saves exact CSS bytes and replays creation, edits and assignment through shared history', async () => {
    const manifest = await workspace.read('game/game.json')
    await apply(create())
    expect(Buffer.from(await workspace.read('game/styles/custom.css')).toString()).toBe(css)
    const savedManifest = await workspace.read('game/game.json')
    await restore('undo')
    expect(await workspace.read('game/game.json')).toEqual(manifest)
    await expect(workspace.read('game/styles/custom.css')).rejects.toMatchObject({ code: 'ENOENT' })
    await restore('redo')
    expect(await workspace.read('game/game.json')).toEqual(savedManifest)
    expect(Buffer.from(await workspace.read('game/styles/custom.css')).toString()).toBe(css)
    await apply({ ...create(), css: '', createOnly: false })
    expect(Buffer.from(await workspace.read('game/styles/custom.css')).toString()).toBe('')
    await restore('undo')
    expect(Buffer.from(await workspace.read('game/styles/custom.css')).toString()).toBe(css)
    await apply({ type: 'game.assignStylesheet', file: null })
    const unassigned = await service.inspect('game')
    expect(unassigned.game?.stylesheet).toBeUndefined()
    expect(unassigned.stylesheets?.['styles/custom.css']).toBe(css)
    await restore('undo')
    expect((await service.inspect('game')).game?.stylesheet).toBe('styles/custom.css')
  })

  it('discovers unassigned CSS, excludes nested games and dependency folders, and detects external changes', async () => {
    await workspace.create('game/styles/blue.css', Buffer.from(css))
    await workspace.create('game/nested/game.json', Buffer.from('{}'))
    await workspace.create('game/nested/other.css', Buffer.from('other'))
    await workspace.create('game/node_modules/package/style.css', Buffer.from('dependency'))
    const initial = await service.inspect('game')
    expect(Object.keys(initial.stylesheets ?? {})).toEqual(['theme.css', 'styles/blue.css'])
    await workspace.write('game/styles/blue.css', Buffer.from('changed'))
    expect((await service.inspect('game')).revision).not.toBe(initial.revision)
    await expect(
      service.apply({
        path: 'game',
        expectedRevision: initial.revision,
        command: { type: 'game.assignStylesheet', file: 'styles/blue.css' },
      }),
    ).rejects.toMatchObject({ status: 409 })
    await apply({ type: 'game.assignStylesheet', file: 'styles/blue.css' })
    expect((await service.inspect('game')).game?.stylesheet).toBe('styles/blue.css')
  })

  it('rolls back failed publication without leaving an assignment or overwriting an existing stylesheet', async () => {
    const before = await workspace.read('game/game.json')
    const originalTheme = await workspace.read('game/theme.css')
    const write = workspace.write.bind(workspace)
    let fail = true
    vi.spyOn(workspace, 'write').mockImplementation(async (file, bytes) => {
      if (fail && file === 'game/game.json') {
        fail = false
        throw new Error('Simulated manifest failure')
      }

      return write(file, bytes)
    })
    await expect(apply(create())).rejects.toThrow('Simulated manifest failure')
    expect(await workspace.read('game/game.json')).toEqual(before)
    expect(await workspace.read('game/theme.css')).toEqual(originalTheme)
    await expect(workspace.read('game/styles/custom.css')).rejects.toMatchObject({ code: 'ENOENT' })
    await workspace.create('game/styles/custom.css', Buffer.from('existing'))
    await expect(apply(create())).rejects.toThrow('already exists')
    expect(Buffer.from(await workspace.read('game/styles/custom.css')).toString()).toBe('existing')
  })

  it('repairs a missing CSS file and loads authored styling through the normal runtime pipeline', async () => {
    await workspace.removeCreated('game/theme.css', await workspace.read('game/theme.css'))
    expect((await service.inspect('game')).diagnostics).toContainEqual(
      expect.objectContaining({ file: 'theme.css', code: 'missing_file' }),
    )
    await apply({ ...create(), file: 'theme.css' })

    const game = await new GameLoader(
      new JsonResourceLoader(
        {
          readText: async (file) => Buffer.from(await workspace.read(`game/${file}`)).toString(),
          readBytes: (file) => workspace.read(`game/${file}`),
        },
        { debug: () => '', info: () => '', warn: () => '', error: () => '' },
      ),
    ).load()

    expect(game.stylesheet).toBe(css)
    expect((await service.inspect('game')).diagnostics).toEqual([])
  })
})
