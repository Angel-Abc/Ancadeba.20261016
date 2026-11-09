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
  it('assigns project and scene metadata keys without changing literal fallbacks or extension fields', () => {
    const source = applyCommand(project(), command()).project
    object(source.documents['game.json']).extension = 'game'
    object(source.documents['scenes/adventure.json']).extension = 'scene'
    const before = JSON.stringify(source)

    const game = applyCommand(source, {
      type: 'game.updateMetadata',
      title: 'Literal game',
      description: 'Literal description',
      version: '2',
      titleKey: 'greeting.title',
      descriptionKey: 'greeting.body',
    }).project

    const saved = applyCommand(game, {
      type: 'scene.updateMetadata',
      sceneId: 'adventure',
      title: 'Literal scene',
      description: 'Scene fallback',
      titleKey: 'greeting.title',
      descriptionKey: 'greeting.body',
    }).project

    expect(JSON.stringify(source)).toBe(before)
    expect(saved.documents['game.json']).toMatchObject({
      title: 'Literal game',
      titleKey: 'greeting.title',
      description: 'Literal description',
      descriptionKey: 'greeting.body',
      extension: 'game',
    })
    expect(saved.documents['scenes/adventure.json']).toMatchObject({
      title: 'Literal scene',
      titleKey: 'greeting.title',
      description: 'Scene fallback',
      descriptionKey: 'greeting.body',
      extension: 'scene',
    })
    const view = inspectProject(saved)

    const localized = localizeDefinitions(
      view.game!,
      new Map(view.scenes.map((scene) => [scene.id, scene])),
      {
        fallback: view.languageCatalogs!.en!,
        messages: view.languageCatalogs!.nl!,
      },
    )

    expect(localized.game).toMatchObject({ title: 'Welkom', description: 'Hello\ntraveler' })
    expect(localized.scenes.get('adventure')).toMatchObject({
      title: 'Welkom',
      description: 'Hello\ntraveler',
    })
  })

  it('preserves omitted metadata keys for older clients and explicitly clears them with null', () => {
    let source = applyCommand(project(), command()).project

    const game = {
      type: 'game.updateMetadata' as const,
      title: 'Game fallback',
      description: 'Description',
      version: '1',
    }

    const scene = {
      type: 'scene.updateMetadata' as const,
      sceneId: 'adventure',
      title: 'Scene fallback',
      description: 'Description',
    }

    source = applyCommand(source, {
      ...game,
      titleKey: 'greeting.title',
      descriptionKey: 'greeting.body',
    }).project
    source = applyCommand(source, {
      ...scene,
      titleKey: 'greeting.title',
      descriptionKey: 'greeting.body',
    }).project
    source = applyCommand(applyCommand(source, game).project, scene).project
    expect(source.documents['game.json']).toMatchObject({
      titleKey: 'greeting.title',
      descriptionKey: 'greeting.body',
    })
    expect(source.documents['scenes/adventure.json']).toMatchObject({
      titleKey: 'greeting.title',
      descriptionKey: 'greeting.body',
    })

    const cleared = applyCommand(
      applyCommand(source, { ...game, titleKey: null, descriptionKey: null }).project,
      { ...scene, titleKey: null, descriptionKey: null },
    ).project

    for (const file of ['game.json', 'scenes/adventure.json']) {
      const saved: unknown = JSON.parse(JSON.stringify(cleared.documents[file]))
      expect(saved).not.toHaveProperty('titleKey')
      expect(saved).not.toHaveProperty('descriptionKey')
    }
  })

  it('validates metadata keys and rejects clearing the only title without changing source', () => {
    const source = applyCommand(project(), command()).project

    const game = {
      type: 'game.updateMetadata' as const,
      title: '',
      description: '',
      version: '1',
      titleKey: 'greeting.title',
    }

    const saved = applyCommand(source, game).project

    const scene = {
      type: 'scene.updateMetadata' as const,
      sceneId: 'adventure',
      title: '',
      description: '',
      titleKey: 'greeting.title',
    }

    expect(() => applyCommand(source, scene)).not.toThrow()
    const before = JSON.stringify(saved)

    for (const edit of [
      { ...game, titleKey: 'missing.key' },
      { ...game, titleKey: null },
      { ...game, descriptionKey: 'missing.key' },
    ])
      expect(() => applyCommand(saved, edit)).toThrow('invalid project')
    expect(() => applyCommand(source, { ...scene, titleKey: 'missing.key' })).toThrow(
      'invalid project',
    )
    expect(commandSchema.safeParse({ ...game, titleKey: '' }).success).toBe(false)
    expect(JSON.stringify(saved)).toBe(before)
  })
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

  it('persists metadata key assignments and clearing with exact undo and redo', async () => {
    await apply(command())

    for (const edit of [
      {
        type: 'game.updateMetadata' as const,
        title: '',
        description: 'Fallback',
        version: '1',
        titleKey: 'greeting.title',
        descriptionKey: 'greeting.body',
      },
      {
        type: 'scene.updateMetadata' as const,
        sceneId: 'adventure',
        title: '',
        description: 'Fallback',
        titleKey: 'greeting.title',
        descriptionKey: 'greeting.body',
      },
    ]) {
      const file =
        edit.type === 'game.updateMetadata' ? 'game/game.json' : 'game/scenes/adventure.json'

      const before = await workspace.read(file)
      await apply(edit)
      const saved = await workspace.read(file)
      await restore('undo')
      expect(await workspace.read(file)).toEqual(before)
      await restore('redo')
      expect(await workspace.read(file)).toEqual(saved)
      await apply({ ...edit, title: 'Literal title', titleKey: null, descriptionKey: null })
      const cleared = JSON.parse(Buffer.from(await workspace.read(file)).toString('utf8'))
      expect(cleared).not.toHaveProperty('titleKey')
      expect(cleared).not.toHaveProperty('descriptionKey')
      await restore('undo')
      expect(await workspace.read(file)).toEqual(saved)
    }
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
