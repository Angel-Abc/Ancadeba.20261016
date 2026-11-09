import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'
import {
  applyCommand,
  createStarterProject,
  inspectProject,
  object,
  type EditorCommand,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'
import { questSchema, textComponentSchema } from '@ancadeba/schemas'
import { GameBindings, GameLoader, observeText, type EngineMessages } from '@ancadeba/game-runtime'
import { JsonResourceLoader, MessageBus } from '@ancadeba/utilities'
import { FileWorkspace } from '../apps/editor-server/src/workspace.js'
import { WorkspaceProjectRepository } from '../apps/editor-server/src/editorProjectRepository.js'
import { EditorProjectService } from '../apps/editor-server/src/editorProjectService.js'
import { EditorCoordinator } from '../apps/editor-server/src/editorCoordinator.js'
import {
  previewTextBindings,
  textBindingChoices,
  textBindingId,
} from '../apps/editor-ui/src/textBindingChoices.js'

const rules: EditorCommand = {
  type: 'game.updateRules',
  ruleId: 'state',
  rules: {
    state: [
      { path: ['gold'], value: 0 },
      { path: ['collected'], value: 0 },
      { path: ['flag'], value: false },
      { path: ['name'], value: '' },
    ],
    actions: {},
  },
}

const quest: EditorCommand = {
  type: 'game.upsertQuest',
  quest: questSchema.parse({
    'schema-version': '1.0.0',
    id: 'delivery',
    label: 'Delivery',
    stages: [
      {
        id: 'collect',
        label: 'Collect',
        objectives: [
          {
            id: 'tokens',
            label: 'Tokens',
            progress: { binding: { source: 'game.state', path: ['collected'] }, target: 3 },
          },
        ],
      },
    ],
  }),
}

const component = () =>
  textComponentSchema.parse({
    id: 'hud',
    type: 'text',
    text: 'Gold {{gold}} · Tokens {{tokens}}/3 · {{quest}}',
    placement: { row: 3, column: 1 },
    bindings: {
      gold: { source: 'game.state', path: ['gold'] },
      tokens: { source: 'game.state', path: ['collected'] },
      quest: { source: 'game.quests', path: ['delivery', 'status'] },
    },
  })

const save = (): EditorCommand => ({
  type: 'scene.upsertComponent',
  sceneId: 'adventure',
  component: component(),
})

const project = (): ProjectSnapshot => {
  const initial = {
    revision: 'one',
    documents: createStarterProject({ path: 'game', title: 'Text bindings', description: '' }),
  }

  return applyCommand(applyCommand(initial, rules).project, quest).project
}

describe('text binding authoring', () => {
  it('exposes state and quest fields and preserves zero, false and empty preview values', () => {
    const view = inspectProject(project())
    const choices = textBindingChoices(view)
    expect(
      choices.find(
        (choice) => choice.id === textBindingId({ source: 'game.state', path: ['gold'] }),
      ),
    ).toMatchObject({ label: 'State · gold', initial: 0 })
    expect(
      choices
        .filter((choice) => choice.binding.source === 'game.quests')
        .map((choice) => choice.binding.path),
    ).toEqual([
      ['delivery', 'status'],
      ['delivery', 'stage'],
      ['delivery', 'tracked'],
    ])

    const draft = textComponentSchema.parse({
      ...component(),
      text: '{{zero}}|{{false}}|{{empty}}',
      bindings: {
        zero: { source: 'game.state', path: ['gold'] },
        false: { source: 'game.state', path: ['flag'] },
        empty: { source: 'game.state', path: ['name'] },
      },
    })

    expect(previewTextBindings(view, draft)).toEqual({ text: '0|false|', diagnostics: [] })
  })

  it('previews missing custom paths with fallback and translated templates using the same aliases', () => {
    const view = inspectProject(project())
    const draft = component()
    draft.text = 'Gold {{gold}}'
    draft.bindings!.gold = {
      source: 'game.state',
      path: ['heroes', 0, 'gold'],
      fallback: 'Unknown hero',
    }
    expect(previewTextBindings(view, draft)).toMatchObject({
      text: 'Gold Unknown hero',
      diagnostics: [{ alias: 'gold' }],
    })
    draft.textKey = 'hud'
    draft.bindings!.gold = { source: 'game.state', path: ['gold'] }
    expect(
      previewTextBindings({ ...view, translations: { hud: 'Coins: {{gold}}' } }, draft).text,
    ).toBe('Coins: 0')
  })

  it('saves complete bindings without mutating source definitions and validates quest references', () => {
    const source = project()
    const before = JSON.stringify(source)
    const saved = applyCommand(source, save())
    expect(JSON.stringify(source)).toBe(before)
    expect(
      inspectProject(saved.project)
        .scenes.find((scene) => scene.id === 'adventure')!
        .components.find((entry) => entry.id === 'hud'),
    ).toMatchObject({ bindings: component().bindings })
    const invalid = component()
    invalid.bindings!.quest!.path = ['missing', 'status']
    expect(() =>
      applyCommand(source, {
        type: 'scene.upsertComponent',
        sceneId: 'adventure',
        component: invalid,
      }),
    ).toThrow('invalid project')
  })

  it('retains binding extensions while clearing fallback and removed aliases', () => {
    const source = applyCommand(project(), save()).project
    const scene = object(source.documents['scenes/adventure.json'])

    const components = Array.isArray(scene.components)
      ? scene.components.map((entry) =>
          object(entry).id === 'hud'
            ? {
                ...object(entry),
                extension: 'component',
                bindings: {
                  ...component().bindings,
                  gold: { ...component().bindings!.gold, fallback: 'Old', extension: 'binding' },
                  unused: { source: 'game.state', path: ['flag'] },
                },
              }
            : entry,
        )
      : []

    const extended = {
      ...source,
      documents: { ...source.documents, 'scenes/adventure.json': { ...scene, components } },
    }

    const saved = applyCommand(extended, save()).project
    const stored = object(saved.documents['scenes/adventure.json']).components

    const raw = Array.isArray(stored)
      ? stored.find((entry) => object(entry).id === 'hud')
      : undefined

    expect(raw).toMatchObject({
      extension: 'component',
      bindings: { gold: { extension: 'binding' } },
    })
    expect(JSON.parse(JSON.stringify(object(raw).bindings))).not.toHaveProperty('unused')
    expect(JSON.parse(JSON.stringify(object(object(raw).bindings).gold))).not.toHaveProperty(
      'fallback',
    )
  })
})

describe('text binding persistence and play', () => {
  let root: string
  let workspace: FileWorkspace
  let service: EditorProjectService
  beforeEach(async () => {
    root = await mkdtemp(fileURLToPath(new URL('./.tmp-text-bindings-', import.meta.url)))
    workspace = await FileWorkspace.open(root)
    service = new EditorProjectService(
      new WorkspaceProjectRepository(workspace),
      new EditorCoordinator(),
    )
    await service.create({ path: 'game', title: 'Text bindings' })
    await apply(rules)
    await apply(quest)
  })
  afterEach(async () => {
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

  it('restores exact scene bytes with Undo/Redo and persists fallback removal', async () => {
    const before = await workspace.read('game/scenes/adventure.json')
    const draft = component()
    draft.bindings!.gold!.fallback = 'Unavailable'
    await apply({ type: 'scene.upsertComponent', sceneId: 'adventure', component: draft })
    const saved = await workspace.read('game/scenes/adventure.json')
    await restore('undo')
    expect(await workspace.read('game/scenes/adventure.json')).toEqual(before)
    await restore('redo')
    expect(await workspace.read('game/scenes/adventure.json')).toEqual(saved)
    await apply(save())

    const scene = object(
      JSON.parse(Buffer.from(await workspace.read('game/scenes/adventure.json')).toString()),
    )

    const text = Array.isArray(scene.components)
      ? scene.components.find((entry) => object(entry).id === 'hud')
      : undefined

    expect(object(object(text).bindings).gold).not.toHaveProperty('fallback')
  })

  it('loads authored bindings through the normal pipeline and updates state and quest text live', async () => {
    await apply(save())

    const game = await new GameLoader(
      new JsonResourceLoader(
        {
          readText: async (path) => Buffer.from(await workspace.read(`game/${path}`)).toString(),
          readBytes: (path) => workspace.read(`game/${path}`),
        },
        { debug: () => '', info: () => '', warn: () => '', error: () => '' },
      ),
    ).load()

    const text = game.scenes.get('adventure')!.components.find((entry) => entry.id === 'hud')

    if (text?.type !== 'text') throw new Error('Expected text')
    const state = { gold: 0, collected: 0 }

    const status = new Map<string, string | boolean>([
      ['status', 'not-started'],
      ['stage', ''],
      ['tracked', false],
    ])

    const messages = new MessageBus<EngineMessages>()

    const bindings = new GameBindings(
      {
        state: () => state,
        progression: () => ({ turn: 0, worldTimeMs: 0 }),
        quests: () => new Map([['delivery', status]]),
      },
      messages,
    )

    const updates: string[] = []
    const stop = observeText(text, bindings, (result) => updates.push(result.text))

    try {
      state.gold = 10
      state.collected = 1
      status.set('status', 'active')
      bindings.invalidate()
      expect(updates).toEqual([
        'Gold 0 · Tokens 0/3 · not-started',
        'Gold 10 · Tokens 1/3 · active',
      ])
    } finally {
      stop()
      bindings.dispose()
    }
  })
})
