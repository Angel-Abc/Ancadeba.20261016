import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import { gameSchema, inputSchema, sceneSchema } from '@ancadeba/schemas'
import {
  assembleGameData,
  Engine,
  GameLifecycle,
  type ActionRequest,
  type EngineMessages,
  type GameActionHandler,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { applyCommand, inspectProject } from '@ancadeba/editor-core'

const placement = { row: 1, column: 1 }

const input = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['scene', 'talk', 'take'],
  keyboard: { KeyQ: 'scene', KeyT: 'talk', Digit1: 'talk', KeyG: 'take' },
  contexts: { play: { scene: 'scene', talk: 'talk', take: 'take' } },
  'initial-context': 'play',
})

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'nearby-demo',
  title: 'Nearby',
  version: '1',
  input: 'keys',
  scenes: ['first', 'second'],
  'initial-scene': 'first',
})

const scenes = new Map(
  ['first', 'second'].map((id) => [
    id,
    sceneSchema.parse({
      'schema-version': '1.0.0',
      id,
      title: id,
      type: 'game',
      screen: { type: 'grid', grid: { rows: 1, columns: 1 } },
      components: [
        { id: 'narrative', type: 'text', text: 'A quiet room.', placement },
        {
          id: 'nearby',
          type: 'nearby',
          label: 'Nearby',
          placement,
          descriptionTarget: 'narrative',
          entries: {
            guide: {
              kind: 'character',
              label: 'Guide',
              description: 'A patient guide.',
              actions: { talk: { action: 'talk' } },
            },
            statue: {
              kind: 'object',
              label: 'Statue',
              description: 'A stone heron.',
              visibleWhen: { source: 'game.state', path: ['present'] },
              actions: {
                talk: { action: 'examine' },
                take: { action: 'take', enabledWhen: { source: 'game.state', path: ['enabled'] } },
              },
            },
          },
        },
        {
          id: 'bar',
          type: 'action-bar',
          placement,
          slots: {
            '1': {
              label: 'Scene',
              action: { type: 'request-action', action: 'scene' },
              inputBinding: { context: 'play', input: 'scene' },
            },
            '2': {
              label: 'Talk',
              action: { type: 'nearby-action', nearby: 'nearby', action: 'talk' },
              inputBinding: { context: 'play', input: 'talk' },
            },
            '3': {
              label: 'Take',
              action: { type: 'nearby-action', nearby: 'nearby', action: 'take' },
              inputBinding: { context: 'play', input: 'take' },
            },
            '4': {
              label: 'Click only',
              action: { type: 'nearby-action', nearby: 'nearby', action: 'talk' },
            },
          },
        },
      ],
    }),
  ]),
)

async function setup() {
  const game = assembleGameData(manifest, scenes, input)
  const requests: ActionRequest[] = []
  const state = { present: true, enabled: false }

  const handler: GameActionHandler = (request) => {
    requests.push(request)

    if (request.action === 'hide') state.present = false

    if (request.action === 'show') state.present = true

    if (request.action === 'enable') state.enabled = true

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
          createGameState: () => state,
          createSceneState: () => undefined,
        }),
      createGameRules: () => ({
        handlers: new Map(
          ['talk', 'examine', 'take', 'scene', 'hide', 'show', 'enable', 'fallback'].map((id) => [
            id,
            handler,
          ]),
        ),
        inputBindings: ['talk', 'take'].flatMap((input) =>
          (['pressed', 'released', 'cancelled'] as const).map((phase) => ({
            context: 'play',
            input,
            phase,
            action: 'fallback',
          })),
        ),
      }),
    },
  )

  onTestFinished(() => engine.stop())
  await engine.start()
  const lifecycle = engine.lifecycle!
  const gameInstance = lifecycle.currentGame!
  const scene = lifecycle.activeScene!
  const nearby = gameInstance.nearby!
  const bar = gameInstance.actionBar!

  const flush = () => {
    for (let i = 0; i < 4; i++) engine.flushMessages()
  }

  const press = (code: string) => {
    engine.input!.pressKey(code)
    engine.input!.releaseKey(code)
    flush()
  }

  return { engine, lifecycle, gameInstance, scene, nearby, bar, requests, flush, press }
}

describe('nearby target context', () => {
  it('resolves selected target actions, payloads and origin while retaining scene and click-only actions', async () => {
    const { engine, scene, nearby, bar, requests, press, flush } = await setup()
    expect(bar.getSlot(scene, 'bar', '2')).toBeUndefined()
    expect(nearby.getEntry(scene, 'nearby', 'toString')).toBeUndefined()
    nearby.select(scene, 'nearby', 'guide')
    expect(nearby.getSelection(scene, 'nearby')?.entry).toBe('guide')
    expect(bar.getSlot(scene, 'bar', '3')).toBeUndefined()
    press('KeyT')
    expect(requests[0]).toMatchObject({
      action: 'talk',
      payload: 'guide',
      origin: { type: 'input', event: { context: 'play', input: 'talk', phase: 'pressed' } },
    })
    bar.activate(scene, 'bar', '4')
    bar.activate(scene, 'bar', '1')
    flush()
    expect(requests.map((request) => [request.action, request.payload])).toEqual([
      ['talk', 'guide'],
      ['talk', 'guide'],
      ['scene', undefined],
    ])
    nearby.select(scene, 'nearby', 'statue')
    expect(bar.isEnabled(scene, 'bar', '3')).toBe(false)
    press('KeyG')
    expect(requests).toHaveLength(3)
    engine.actions!.request('enable')
    flush()
    expect(bar.isEnabled(scene, 'bar', '3')).toBe(true)
    press('KeyG')
    expect(requests.at(-1)).toMatchObject({ action: 'take', payload: 'statue' })
    nearby.select(scene, 'nearby')
    press('KeyT')
    expect(requests.slice(-2).map((request) => request.action)).toEqual(['fallback', 'fallback'])
  })

  it('never retargets queued or held gestures across selection and scene changes', async () => {
    const { engine, lifecycle, scene, nearby, requests, flush } = await setup()
    nearby.select(scene, 'nearby', 'guide')
    engine.input!.pressKey('KeyT')
    nearby.select(scene, 'nearby', 'statue')
    flush()
    engine.input!.releaseKey('KeyT')
    flush()
    expect(requests).toEqual([])
    nearby.select(scene, 'nearby', 'guide')
    engine.input!.pressKey('KeyT')
    lifecycle.enterScene('second')
    const second = lifecycle.activeScene!
    nearby.select(second, 'nearby', 'guide')
    flush()
    engine.input!.releaseKey('KeyT')
    flush()
    expect(requests).toEqual([])
    nearby.select(scene, 'nearby', 'statue')
    expect(nearby.getSelection(second, 'nearby')?.entry).toBe('guide')
  })

  it('clears disappearing targets, consumes cancelled phases, and releases context on restart', async () => {
    const { engine, scene, nearby, bar, requests, flush } = await setup()
    nearby.select(scene, 'nearby', 'statue')
    engine.input!.pressKey('KeyG')
    engine.input!.reset()
    flush()
    expect(requests).toEqual([])
    engine.actions!.request('hide')
    flush()
    expect(nearby.getSelection(scene, 'nearby')).toBeUndefined()
    expect(bar.getSlot(scene, 'bar', '2')).toBeUndefined()
    nearby.select(scene, 'nearby', 'statue')
    expect(nearby.getSelection(scene, 'nearby')).toBeUndefined()
    engine.actions!.request('show')
    flush()
    expect(nearby.getSelection(scene, 'nearby')).toBeUndefined()
    nearby.select(scene, 'nearby', 'guide')
    engine.stop()
    expect(nearby.getEntry(scene, 'nearby', 'guide')).toBeUndefined()
    await engine.start()
    const next = engine.lifecycle!.activeScene!
    expect(engine.lifecycle!.currentGame!.nearby!.getSelection(next, 'nearby')).toBeUndefined()
  })

  it('validates panel and text references and protects linked actions and visibility fields in editor changes', () => {
    const first = scenes.get('first')!
    expect(() =>
      sceneSchema.parse({
        ...first,
        components: first.components.map((component) =>
          component.type === 'nearby' ? { ...component, descriptionTarget: 'bar' } : component,
        ),
      }),
    ).toThrow('text component')

    const project = {
      revision: 'one',
      documents: {
        'game.json': { ...manifest, rules: ['targets'] },
        'input/keys.json': input,
        ...Object.fromEntries([...scenes].map(([id, scene]) => [`scenes/${id}.json`, scene])),
        'rules/targets.json': {
          state: [
            { path: ['present'], value: true },
            { path: ['enabled'], value: false },
          ],
          actions: { talk: [{ when: [], effects: [] }] },
        },
      },
    }

    const panel = first.components.find((component) => component.type === 'nearby')!

    const edited = applyCommand(project, {
      type: 'scene.upsertNearby',
      sceneId: 'first',
      component: panel,
    })

    expect(inspectProject(edited.project).scenes[0]!.components).toContainEqual(panel)
    expect(() =>
      applyCommand(edited.project, {
        type: 'game.updateRules',
        ruleId: 'targets',
        rules: {
          state: [
            { path: ['present'], value: true },
            { path: ['enabled'], value: false },
          ],
          actions: {},
        },
      }),
    ).toThrow('Unlink action')
    expect(() =>
      applyCommand(edited.project, {
        type: 'game.updateRules',
        ruleId: 'targets',
        rules: {
          state: [{ path: ['enabled'], value: false }],
          actions: { talk: [{ when: [], effects: [] }] },
        },
      }),
    ).toThrow('boolean rule state')
    const bar = first.components.find((component) => component.type === 'action-bar')!
    expect(() =>
      applyCommand(project, {
        type: 'scene.setActionBar',
        sceneId: 'first',
        component: {
          ...bar,
          slots: {
            '1': {
              label: 'Talk',
              action: { type: 'nearby-action', nearby: 'missing', action: 'talk' },
            },
          },
        },
      }),
    ).toThrow('invalid project')
  })
})
