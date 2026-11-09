import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  applyCommand,
  commandSchema,
  createStarterProject,
  inspectProject,
  object,
  projectViewSchema,
  type EditorCommand,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'
import { textComponentSchema, localizeDefinitions } from '@ancadeba/schemas'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { WorkspaceProjectRepository } from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'

const project = (): ProjectSnapshot => ({
  revision: 'one',
  documents: createStarterProject({ path: 'game', title: 'Localization', description: '' }),
})

const command = (): Extract<EditorCommand, { type: 'game.updateLocalization' }> => ({
  type: 'game.updateLocalization',
  languages: { default: 'en', available: ['en', 'nl', 'en-US'] },
  catalogs: {
    en: { 'greeting.title': 'Welcome', 'greeting.body': 'Hello\ntraveler' },
    nl: { 'greeting.title': 'Welkom' },
    'en-US': {},
  },
})

const translated = (source: ProjectSnapshot) =>
  applyCommand(source, {
    type: 'scene.upsertComponent',
    sceneId: 'adventure',
    component: textComponentSchema.parse({
      id: 'translated',
      type: 'text',
      textKey: 'greeting.body',
      placement: { row: 3, column: 1 },
    }),
  }).project

describe('localization authoring commands', () => {
  it('creates complete source catalogs and exposes them with default-language picker previews', () => {
    const source = project()
    const before = JSON.stringify(source)
    const result = applyCommand(source, command())
    expect(JSON.stringify(source)).toBe(before)
    expect(result.createdFiles).toEqual([
      'languages/en/messages.json',
      'languages/nl/messages.json',
      'languages/en-US/messages.json',
    ])
    const view = projectViewSchema.parse(inspectProject(result.project))
    expect(view.languageCatalogs).toEqual(command().catalogs)
    expect(view.translations).toEqual(command().catalogs.en)
    expect(view.translationKeys).toEqual(['greeting.body', 'greeting.title'])
  })

  it('keeps sparse fallback and explicit empty translations distinct', () => {
    const source = translated(applyCommand(project(), command()).project)
    const update = command()
    update.catalogs.nl!['greeting.body'] = ''
    const view = inspectProject(applyCommand(source, update).project)
    const scenes = new Map(view.scenes.map((scene) => [scene.id, scene]))

    const localized = localizeDefinitions(view.game!, scenes, {
      fallback: view.languageCatalogs!.en!,
      messages: view.languageCatalogs!.nl!,
    })

    expect(
      localized.scenes
        .get('adventure')!
        .components.find((component) => component.id === 'translated'),
    ).toMatchObject({ text: '' })
    delete update.catalogs.nl!['greeting.body']
    const fallback = inspectProject(applyCommand(source, update).project)
    expect(
      localizeDefinitions(fallback.game!, scenes, {
        fallback: fallback.languageCatalogs!.en!,
        messages: fallback.languageCatalogs!.nl!,
      })
        .scenes.get('adventure')!
        .components.find((component) => component.id === 'translated'),
    ).toMatchObject({ text: 'Hello\ntraveler' })
  })

  it('rejects translated templates that introduce undeclared binding placeholders', () => {
    let source = applyCommand(project(), command()).project
    source = applyCommand(source, {
      type: 'game.updateRules',
      ruleId: 'state',
      rules: { state: [{ path: ['name'], value: 'Mira' }], actions: {} },
    }).project
    source = applyCommand(source, {
      type: 'scene.upsertComponent',
      sceneId: 'adventure',
      component: textComponentSchema.parse({
        id: 'bound',
        type: 'text',
        textKey: 'greeting.body',
        placement: { row: 3, column: 1 },
        bindings: { name: { source: 'game.state', path: ['name'] } },
      }),
    }).project
    const update = command()
    update.catalogs.nl!['greeting.body'] = 'Hallo {{missing}}'
    expect(() => applyCommand(source, update)).toThrow('invalid project')
  })

  it.each(['missing default key', 'empty required title'])(
    'rejects %s without changing the source',
    (problem) => {
      let source = translated(applyCommand(project(), command()).project)
      const update = command()

      if (problem === 'missing default key') delete update.catalogs.en!['greeting.body']
      else {
        source = {
          ...source,
          documents: {
            ...source.documents,
            'game.json': { ...object(source.documents['game.json']), titleKey: 'greeting.title' },
          },
        }
        update.catalogs.nl!['greeting.title'] = ''
      }

      const before = JSON.stringify(source)
      expect(() => applyCommand(source, update)).toThrow('invalid project')
      expect(JSON.stringify(source)).toBe(before)
    },
  )

  it.each(['duplicate tags', 'missing catalog', 'extra catalog', 'invalid tag', 'invalid key'])(
    'rejects %s at the command boundary',
    (problem) => {
      const update = command()

      if (problem === 'duplicate tags') update.languages.available.push('EN')

      if (problem === 'missing catalog') delete update.catalogs.nl

      if (problem === 'extra catalog') update.catalogs.fr = {}

      if (problem === 'invalid tag') update.languages.available[0] = '../en'

      if (problem === 'invalid key') update.catalogs.en!['invalid key'] = 'Text'
      expect(commandSchema.safeParse(update).success).toBe(false)
    },
  )

  it('changes the default, removes a language and unused keys, and preserves manifest extensions', () => {
    const source = applyCommand(project(), command()).project

    const extended = {
      ...source,
      documents: {
        ...source.documents,
        'game.json': {
          ...object(source.documents['game.json']),
          extension: true,
          languages: { ...command().languages, extension: 'keep' },
        },
      },
    }

    const update = command()
    update.languages = { default: 'nl', available: ['nl', 'en-US'] }
    update.catalogs = { nl: { 'greeting.body': 'Hallo' }, 'en-US': {} }
    const result = applyCommand(extended, update)
    expect(result.removedFiles).toEqual(['languages/en/messages.json'])
    expect(result.project.documents['game.json']).toMatchObject({
      extension: true,
      languages: { default: 'nl', extension: 'keep' },
    })
    expect(inspectProject(result.project).translations).toEqual({ 'greeting.body': 'Hallo' })
  })

  it('protects unlisted catalogs and rejects case-only tag replacements', () => {
    const source = project()
    expect(() =>
      applyCommand(
        {
          ...source,
          documents: { ...source.documents, 'languages/en/messages.json': { keep: 'mine' } },
        },
        command(),
      ),
    ).toThrow('already exists')
    const current = applyCommand(source, command()).project
    const update = command()
    update.languages.available[0] = 'EN'
    update.languages.default = 'EN'
    update.catalogs.EN = update.catalogs.en!
    delete update.catalogs.en
    expect(() => applyCommand(current, update)).toThrow('existing language tag: en')
  })
})

describe('localization persistence', () => {
  let root: string
  let workspace: FileWorkspace
  let service: EditorProjectService
  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-localization-authoring-', import.meta.url)))
    workspace = await FileWorkspace.open(root)
    service = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )
    await service.create({ path: 'game', title: 'Localization' })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  const apply = async (edit: EditorCommand) =>
    service.apply({
      path: 'game',
      expectedRevision: (await service.inspect('game')).revision,
      command: edit,
    })

  const restore = async (direction: 'undo' | 'redo') =>
    service.restore({
      path: 'game',
      expectedRevision: (await service.inspect('game')).revision,
      direction,
    })

  it('creates and edits catalogs with exact shared undo/redo, including language removal', async () => {
    const manifest = await workspace.read('game/game.json')
    await apply(command())
    const saved = await workspace.read('game/languages/en/messages.json')
    expect((await service.inspect('game')).languageCatalogs).toEqual(command().catalogs)
    await restore('undo')
    expect(await workspace.read('game/game.json')).toEqual(manifest)
    await expect(workspace.read('game/languages/en/messages.json')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await restore('redo')
    expect(await workspace.read('game/languages/en/messages.json')).toEqual(saved)
    const update = command()
    update.languages.available = ['en', 'nl']
    delete update.catalogs['en-US']
    update.catalogs.en!['greeting.body'] = 'Updated'
    await apply(update)
    await expect(workspace.read('game/languages/en-US/messages.json')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await restore('undo')
    expect(await workspace.read('game/languages/en/messages.json')).toEqual(saved)
    expect((await service.inspect('game')).game!.languages!.available).toContain('en-US')
  })

  it('rolls back partially written updates of existing catalogs', async () => {
    await apply(command())
    const english = await workspace.read('game/languages/en/messages.json')
    const dutch = await workspace.read('game/languages/nl/messages.json')
    const write = workspace.write.bind(workspace)
    let failed = false
    vi.spyOn(workspace, 'write').mockImplementation(async (path, bytes) => {
      if (!failed && path.endsWith('languages/nl/messages.json')) {
        failed = true
        throw new Error('Simulated disk failure')
      }

      return write(path, bytes)
    })
    const update = command()
    update.catalogs.en!['greeting.body'] = 'Changed'
    update.catalogs.nl!['greeting.body'] = 'Veranderd'
    await expect(apply(update)).rejects.toThrow('Simulated disk failure')
    expect(await workspace.read('game/languages/en/messages.json')).toEqual(english)
    expect(await workspace.read('game/languages/nl/messages.json')).toEqual(dutch)
  })

  it('protects existing unlisted files and rejects stale revisions without overwriting catalogs', async () => {
    await workspace.write('game/languages/en/messages.json', Buffer.from('protected'))
    await expect(apply(command())).rejects.toMatchObject({ status: 409 })
    expect(Buffer.from(await workspace.read('game/languages/en/messages.json')).toString()).toBe(
      'protected',
    )
    const update = command()
    update.languages = { default: 'fr', available: ['fr'] }
    update.catalogs = { fr: {} }
    await apply(update)
    const revision = (await service.inspect('game')).revision
    await apply({ type: 'game.updateMetadata', title: 'Changed', description: '', version: '1' })
    await expect(
      service.apply({ path: 'game', expectedRevision: revision, command: update }),
    ).rejects.toMatchObject({ status: 409 })
  })
})
