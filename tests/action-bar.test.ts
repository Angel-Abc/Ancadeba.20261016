import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import {
  actionBarComponentSchema,
  actionBarIssues,
  gameSchema,
  inputSchema,
  sceneSchema,
  localizeDefinitions,
  assertGameLanguages,
} from '@ancadeba/schemas'
import {
  assembleGameData,
  Engine,
  GameLifecycle,
  GameActionBar,
  type EngineMessages,
  type GameActionHandler,
  type ActionRequest,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { applyCommand, validateProject } from '@ancadeba/editor-core'

const placement = { row: 1, column: 1, rowSpan: 1, columnSpan: 1 }

const slot = {
  label: 'Act',
  action: { type: 'request-action', action: 'first' },
  inputBinding: { context: 'gameplay', input: 'claim' },
}

const bar = { id: 'commands', type: 'action-bar', placement, slots: { '1': slot } }

const input = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['primary', 'alternate', 'spare', 'unmapped'],
  keyboard: { KeyQ: 'primary', Digit1: 'primary', KeyJ: 'alternate', KeyE: 'spare' },
  contexts: {
    gameplay: { primary: 'claim', alternate: 'claim', spare: 'spare', unmapped: 'programmatic' },
    menu: { primary: 'menu', spare: 'spare' },
  },
  'initial-context': 'gameplay',
})

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'demo',
  title: 'Demo',
  version: '1',
  input: 'controls',
  scenes: ['first', 'second', 'plain'],
  'initial-scene': 'first',
})

function scenes() {
  return new Map(
    ['first', 'second', 'plain'].map((id) => [
      id,
      sceneSchema.parse({
        'schema-version': '1.0.0',
        id,
        title: id,
        type: 'game',
        screen: { type: 'grid', grid: { rows: 1, columns: 1 } },
        components:
          id === 'plain'
            ? []
            : [
                {
                  ...bar,
                  slots: {
                    '1': {
                      ...slot,
                      action: {
                        type: 'request-action',
                        action: id,
                        enabledWhen: { source: 'game.state', path: ['enabled'] },
                      },
                    },
                    '15': { label: 'Back', action: { type: 'enter-scene', scene: 'plain' } },
                  },
                },
              ],
      }),
    ]),
  )
}

async function setup() {
  const game = assembleGameData(manifest, scenes(), input)
  const requests: ActionRequest[] = []

  const handler =
    (id: string): GameActionHandler =>
    (request) => {
      requests.push(request)

      if (id === 'disable') {
        // SAFETY: the paired lifecycle factory creates the enabled state field.
        const state = engine.lifecycle!.currentGame!.state as { enabled: boolean }
        state.enabled = false
      }

      return { status: 'applied' }
    }

  const engine = new Engine(
    { load: async () => game },
    { mount: () => () => {} },
    { debug: () => '', info: () => '', warn: () => '', error: () => '' },
    () => new MessageBus<EngineMessages>(),
    {
      clock: { now: () => 0 },
      scheduler: { schedule: () => () => {} },
      createGameLifecycle: (data) =>
        new GameLifecycle(data, {
          createGameState: () => ({ enabled: true }),
          createSceneState: () => undefined,
        }),
      createGameRules: () => ({
        handlers: new Map(
          ['first', 'second', 'fallback', 'spare', 'disable'].map((id) => [id, handler(id)]),
        ),
        inputBindings: [
          ...(['pressed', 'released', 'cancelled'] as const).map((phase) => ({
            context: 'gameplay',
            input: 'claim',
            action: 'fallback',
            phase,
          })),
          { context: 'gameplay', input: 'spare', action: 'spare' },
          { context: 'menu', input: 'menu', action: 'fallback' },
        ],
      }),
    },
  )

  onTestFinished(() => engine.stop())
  await engine.start()

  const flush = () => {
    for (let index = 0; index < 4; index++) engine.flushMessages()
  }

  const press = (code = 'KeyQ') => {
    engine.input!.pressKey(code)
    engine.input!.releaseKey(code)
    flush()
  }

  return { engine, game, requests, flush, press }
}

describe('action bar configuration', () => {
  it('validates slots, unique input pairs, and one bar per game scene', () => {
    expect(actionBarComponentSchema.parse(bar).slots['1']?.label).toBe('Act')

    for (const slots of [
      { '0': slot },
      { '16': slot },
      { '01': slot },
      { '1': slot, '2': slot },
      { '1': { ...slot, label: '' } },
    ])
      expect(actionBarComponentSchema.safeParse({ ...bar, slots }).success).toBe(false)
    const scene = scenes().get('first')!
    expect(
      sceneSchema.safeParse({ ...scene, components: [bar, { ...bar, id: 'other' }] }).success,
    ).toBe(false)
    expect(
      sceneSchema.safeParse({ ...scene, type: 'stand-alone', components: [bar] }).success,
    ).toBe(false)
  })

  it('shares input and navigation reference checks between assembly and editor diagnostics', () => {
    const definitions = scenes()
    const scene = definitions.get('first')!
    scene.components = [
      actionBarComponentSchema.parse({
        ...bar,
        slots: {
          '1': { ...slot, inputBinding: { context: 'missing', input: 'claim' } },
          '2': { ...slot, inputBinding: { context: 'gameplay', input: 'missing' } },
          '3': { label: 'Broken', action: { type: 'enter-scene', scene: 'absent' } },
          '4': { ...slot, inputBinding: { context: 'gameplay', input: 'programmatic' } },
        },
      }),
    ]
    expect(
      actionBarIssues(actionBarComponentSchema.parse(scene.components[0]), input, definitions),
    ).toHaveLength(3)
    expect(() => assembleGameData(manifest, definitions, input)).toThrow('Unknown input binding')

    const documents = {
      'game.json': manifest,
      'input/controls.json': input,
      ...Object.fromEntries([...definitions].map(([id, value]) => [`scenes/${id}.json`, value])),
    }

    expect(
      validateProject(documents).filter(({ code }) => code === 'invalid_action_bar'),
    ).toHaveLength(3)
  })

  it('localizes nested slot labels and copies nested configuration', () => {
    const definitions = scenes()
    definitions.get('first')!.components = [
      actionBarComponentSchema.parse({
        ...bar,
        slots: {
          '1': { ...slot, label: '', labelKey: 'act' },
        },
      }),
    ]
    expect(() => assertGameLanguages(manifest, definitions)).toThrow('Translation keys')

    const localized = localizeDefinitions(manifest, definitions, {
      fallback: { act: 'Act' },
      messages: { act: 'Doe' },
    })

    const localizedBar = localized.scenes
      .get('first')!
      .components.find((component) => component.type === 'action-bar')!

    expect(localizedBar.slots['1']!.label).toBe('Doe')

    const data = assembleGameData(
      { ...manifest, languages: { default: 'en', available: ['en'] } },
      localized.scenes,
      input,
    )

    localizedBar.slots['1']!.inputBinding!.input = 'changed'
    expect(
      data.scenes.get('first')!.components.find((component) => component.type === 'action-bar')!
        .slots['1']!.inputBinding!.input,
    ).toBe('claim')
  })

  it('protects slot action references and boolean enablement when editing rules', () => {
    const rules = {
      state: [{ path: ['enabled'], value: true }],
      actions: { first: [{ when: [], effects: [] }], second: [{ when: [], effects: [] }] },
    }

    const project = {
      revision: 'test',
      documents: {
        'game.json': { ...manifest, rules: ['controls'] },
        'input/controls.json': input,
        'rules/controls.json': rules,
        ...Object.fromEntries([...scenes()].map(([id, scene]) => [`scenes/${id}.json`, scene])),
      },
    }

    expect(() =>
      applyCommand(project, {
        type: 'game.updateRules',
        ruleId: 'controls',
        rules: { ...rules, actions: {} },
      }),
    ).toThrow('Unlink action')
    expect(() =>
      applyCommand(project, {
        type: 'game.updateRules',
        ruleId: 'controls',
        rules: { ...rules, state: [{ path: ['enabled'], value: 1 }] },
      }),
    ).toThrow('boolean rule state field')
  })
})

describe('action bar runtime routing', () => {
  it('claims all gesture phases and aggregates alternate physical bindings into one activation', async () => {
    const { engine, requests, flush, press } = await setup()
    engine.input!.pressKey('KeyQ')
    engine.input!.pressKey('Digit1')
    engine.input!.pressKey('KeyJ')
    engine.input!.releaseKey('KeyQ')
    engine.input!.releaseKey('Digit1')
    engine.input!.releaseKey('KeyJ')
    flush()
    expect(requests.map(({ action }) => action)).toEqual(['first'])
    expect(requests[0]!.origin).toEqual({
      type: 'input',
      event: { context: 'gameplay', input: 'claim', phase: 'pressed' },
    })
    engine.input!.pressKey('KeyQ')
    engine.input!.reset()
    flush()
    expect(requests.map(({ action }) => action)).toEqual(['first', 'first'])
    press('KeyE')
    expect(requests.at(-1)!.action).toBe('spare')
  })

  it('shares enablement between clicks and keyboard, while disabled slots retain ownership', async () => {
    const { engine, requests, flush, press } = await setup()
    const scene = engine.lifecycle!.activeScene!
    const actions = engine.lifecycle!.currentGame!.actionBar!
    expect(actions.isEnabled(scene, 'commands', '1')).toBe(true)
    actions.activate(scene, 'commands', '1')
    flush()
    expect(requests[0]!.origin).toEqual({ type: 'direct' })
    engine.actions!.request('disable')
    flush()
    expect(actions.isEnabled(scene, 'commands', '1')).toBe(false)
    actions.activate(scene, 'commands', '1')
    press()
    expect(requests.map(({ action }) => action)).toEqual(['first', 'disable'])
    actions.activate(scene, 'commands', '15')
    expect(engine.lifecycle!.activeScene!.data.id).toBe('plain')
    press()
    expect(requests.slice(-2).map(({ action }) => action)).toEqual(['fallback', 'fallback'])
  })

  it('discards queued slot input after scene disposal and never transfers a held press', async () => {
    const { engine, requests, flush, press } = await setup()
    const oldScene = engine.lifecycle!.activeScene!
    engine.input!.pressKey('KeyQ')
    engine.lifecycle!.enterScene('second')
    flush()
    engine.input!.pressKey('KeyQ')
    engine.input!.releaseKey('KeyQ')
    flush()
    expect(requests).toEqual([])
    engine.lifecycle!.currentGame!.actionBar!.activate(oldScene, 'commands', '1')
    flush()
    expect(requests).toEqual([])
    press()
    expect(requests.map(({ action }) => action)).toEqual(['second'])
  })

  it('keeps unclaimed input on the normal route when a later scene has a matching slot', async () => {
    const { engine, requests, flush } = await setup()
    engine.lifecycle!.enterScene('plain')
    engine.input!.pressKey('KeyQ')
    engine.lifecycle!.enterScene('second')
    engine.input!.releaseKey('KeyQ')
    flush()
    expect(requests.map(({ action }) => action)).toEqual(['fallback', 'fallback'])
  })

  it('consumes cancellation across contexts and cleans up retained references on restart', async () => {
    const { engine, requests, flush, press } = await setup()
    engine.input!.pressKey('KeyQ')
    engine.input!.setContext('menu')
    flush()
    expect(requests.map(({ action }) => action)).toEqual(['first'])
    engine.input!.releaseKey('KeyQ')
    press()
    expect(requests.at(-1)!.action).toBe('fallback')
    const oldInput = engine.input!
    const oldBar = engine.lifecycle!.currentGame!.actionBar!
    const oldScene = engine.lifecycle!.activeScene!
    engine.stop()
    oldBar.activate(oldScene, 'commands', '1')
    expect(oldInput.pressKey('KeyQ')).toBe(false)
    await engine.start()
    press()
    expect(requests.filter(({ action }) => action === 'first')).toHaveLength(2)
  })

  it('can route a programmatic virtual input without a physical key binding', async () => {
    const { engine } = await setup()
    const scene = engine.lifecycle!.activeScene!
    const definition = scene.data.components.find((component) => component.type === 'action-bar')!
    definition.slots['1']!.inputBinding = { context: 'gameplay', input: 'programmatic' }
    const bar = new GameActionBar(engine.lifecycle!)
    const request = vi.fn()
    expect(engine.input!.getKeyboardCodes('gameplay', 'programmatic')).toEqual([])
    expect(
      bar.handleInput({ context: 'gameplay', input: 'programmatic', phase: 'pressed' }, request),
    ).toBe(true)
    expect(request).toHaveBeenCalledExactlyOnceWith('first')
    expect(
      bar.handleInput({ context: 'gameplay', input: 'programmatic', phase: 'released' }, request),
    ).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    bar.dispose()
  })

  it('navigates and starts a fresh playthrough from keyboard-bound navigation slots', async () => {
    const { engine, requests, press } = await setup()
    const scene = engine.lifecycle!.activeScene!
    const definition = scene.data.components.find((component) => component.type === 'action-bar')!
    definition.slots['1']!.action = { type: 'new-game', scene: 'second' }
    const previous = engine.lifecycle!.currentGame!
    press()
    expect(previous.disposed).toBe(true)
    expect(engine.lifecycle!.currentGame).not.toBe(previous)
    expect(engine.lifecycle!.activeScene!.data.id).toBe('second')
    expect(requests).toEqual([])
    press()
    expect(requests.map(({ action }) => action)).toEqual(['second'])
  })
})
