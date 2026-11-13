import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import {
  gameSchema,
  gameRulesSchema,
  inputSchema,
  mapDefinitionSchema,
  sceneSchema,
  validateRuleSources,
  buttonActionSchema,
  ruleEffectSchema,
  type GameRulesDefinition,
  type MapDefinition,
} from '@ancadeba/schemas'
import {
  assembleGameData,
  Engine,
  type EngineMessages,
  type GameSaveStore,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { inspectProject } from '@ancadeba/editor-core'

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'entry',
  title: 'Tile entry',
  version: '1',
  scenes: ['first', 'second'],
  maps: ['terrain'],
  rules: ['travel'],
  input: 'keys',
  'initial-scene': 'first',
})

const input = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['east'],
  keyboard: { KeyD: 'east' },
  contexts: { explore: { east: 'east' } },
  'initial-context': 'explore',
})

const rules = gameRulesSchema.parse({
  state: [{ path: ['entered'], value: false }],
  actions: {
    mark: [{ when: [], effects: [{ type: 'set-state', path: ['entered'], value: true }] }],
    travel: [
      {
        when: [{ type: 'scene-is', scene: 'first' }],
        effects: [{ type: 'enter-scene', scene: 'second' }],
      },
    ],
  },
})

const map = mapDefinitionSchema.parse({
  'schema-version': '1.0.0',
  type: 'square-grid',
  width: 3,
  height: 3,
  terrain: {
    ground: { color: '#ffffff' },
    wall: { color: '#000000', walkable: false },
    road: { color: '#aaaaaa', movementCostMs: 100 },
  },
  tiles: [
    ['ground', 'wall', 'ground'],
    ['ground', 'ground', 'road'],
    ['ground', 'ground', 'ground'],
  ],
  entryTriggers: [
    { id: 'spawn', x: 1, y: 1, action: 'mark' },
    { id: 'exit', x: 2, y: 1, action: 'travel' },
    { id: 'event', x: 1, y: 2, action: 'mark' },
  ],
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
        {
          id: 'map',
          type: 'map-view',
          label: 'Map',
          map: 'terrain',
          placement: { row: 1, column: 1 },
          viewport: { columns: 3, rows: 3 },
          playerSpawn: { x: 1, y: 1 },
        },
        {
          id: 'other-map',
          type: 'map-view',
          label: 'Other',
          map: 'terrain',
          placement: { row: 1, column: 1 },
          viewport: { columns: 3, rows: 3 },
          playerSpawn: { x: 0, y: 2 },
        },
        {
          id: 'directions',
          type: 'action-bar',
          placement: { row: 1, column: 1 },
          slots: {
            '1': {
              label: 'East',
              action: { type: 'move-map', mapView: 'map', direction: 'east' },
              inputBinding: { context: 'explore', input: 'east' },
            },
            '2': {
              label: 'Entrance',
              action: {
                type: 'enter-scene',
                scene: 'second',
                mapView: 'map',
                position: { x: 0, y: 1 },
              },
            },
          },
        },
      ],
    }),
  ]),
)

async function setup(
  store?: GameSaveStore,
  authoredRules: GameRulesDefinition = rules,
  candidateMap: MapDefinition = map,
) {
  const data = assembleGameData(
    manifest,
    scenes,
    input,
    undefined,
    new Map([['terrain', candidateMap]]),
    undefined,
    undefined,
    new Map([['travel', authoredRules]]),
  )

  const tasks: { callback: () => void; delay: number; cancelled: boolean }[] = []
  const messages = new MessageBus<EngineMessages>()
  const applied: string[] = []
  messages.subscribe('action.applied', ({ request }) => {
    applied.push(request.action)
  })

  const engine = new Engine(
    { load: async () => data },
    { mount: () => () => {} },
    { debug: () => '', info: () => '', warn: () => '', error: () => '' },
    () => messages,
    {
      ...(store ? { saveStore: store } : {}),
      clock: { now: () => 0 },
      scheduler: {
        schedule(callback, delay) {
          if (!delay) return () => {}

          const task = { callback, delay, cancelled: false }
          tasks.push(task)

          return () => {
            task.cancelled = true
          }
        },
      },
    },
  )

  onTestFinished(() => engine.stop())
  await engine.start()
  const lifecycle = engine.lifecycle!
  const scene = lifecycle.activeScene!
  const movement = lifecycle.currentGame!.mapMovement!

  const flush = () => {
    for (let i = 0; i < 6; i++) engine.flushMessages()
  }

  flush()

  return { engine, lifecycle, scene, movement, tasks, applied, flush }
}

describe('map tile-entry actions', () => {
  it('updates the authored clock before movement observers and tile-entry log effects', async () => {
    const authored = gameRulesSchema.parse({
      ...rules,
      clock: { path: ['clock'], startMinute: 540 },
      log: { path: ['log'], capacity: 5, initial: [] },
      actions: {
        ...rules.actions,
        travel: [
          {
            when: [],
            effects: [
              { type: 'append-log', text: 'Arrived' },
              { type: 'enter-scene', scene: 'second' },
            ],
          },
        ],
      },
    })

    const timedMap = structuredClone(map)
    timedMap.terrain.road!.movementCostMs = 60_000
    const { lifecycle, scene, movement, tasks, flush } = await setup(undefined, authored, timedMap)
    const game = lifecycle.currentGame!
    const observed: unknown[] = []
    movement.subscribeChanges(() => {
      if (!movement.isMoving(scene, 'map') && movement.getPosition(scene, 'map')?.x === 2)
        observed.push(game.bindings!.read({ source: 'game.state', path: ['clock'] }))
    })
    movement.move(scene, 'map', 'east')
    expect(game.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    tasks[0]!.callback()
    expect(observed).toEqual([{ status: 'resolved', value: '09:01' }])
    expect(game.actions!.progression).toEqual({ turn: 1, worldTimeMs: 60_000 })
    flush()
    expect(lifecycle.activeScene!.data.id).toBe('second')
    expect(game.bindings!.read({ source: 'game.state', path: ['log'] })).toEqual({
      status: 'resolved',
      value: '09:01  Arrived',
    })
    expect(game.actions!.progression).toEqual({ turn: 1, worldTimeMs: 60_000 })
  })

  it('fires on completed entry, repeats on re-entry, and does not fire at spawn or after blocked movement', async () => {
    const { lifecycle, scene, movement, applied, flush } = await setup()
    expect(applied).toEqual([])
    expect(movement.move(scene, 'map', 'north')).toBe(false)
    flush()
    expect(applied).toEqual([])
    expect(movement.move(scene, 'map', 'south')).toBe(true)
    expect(movement.getPosition(scene, 'map')).toEqual({ x: 1, y: 2 })
    flush()
    expect(applied).toEqual(['mark'])
    expect(lifecycle.currentGame!.state).toEqual(new Map([['entered', true]]))
    movement.move(scene, 'map', 'west')
    movement.move(scene, 'map', 'east')
    flush()
    expect(applied).toEqual(['mark', 'mark'])
    lifecycle.enterScene('second')
    lifecycle.enterScene('first')
    expect(movement.getPosition(lifecycle.activeScene!, 'map')).toEqual({ x: 1, y: 2 })
    flush()
    expect(applied).toEqual(['mark', 'mark'])
  })

  it('runs an authored scene transition only after the terrain delay, including keyboard action-bar movement', async () => {
    const { engine, lifecycle, scene, movement, tasks, applied, flush } = await setup()
    engine.input!.pressKey('KeyD')
    engine.input!.releaseKey('KeyD')
    flush()
    expect(tasks.map((task) => task.delay)).toEqual([100])
    expect(lifecycle.activeScene).toBe(scene)
    expect(movement.getPosition(scene, 'map')).toEqual({ x: 1, y: 1 })
    expect(applied).toEqual([])
    tasks[0]!.callback()
    expect(movement.getPosition(scene, 'map')).toEqual({ x: 2, y: 1 })
    expect(lifecycle.activeScene).toBe(scene)
    flush()
    expect(applied).toEqual(['travel'])
    expect(lifecycle.activeScene!.data.id).toBe('second')
    lifecycle.enterScene('first')
    expect(movement.getPosition(lifecycle.activeScene!, 'map')).toEqual({ x: 2, y: 1 })
    flush()
    expect(applied).toEqual(['travel'])
  })

  it('uses the entering map view and leaves other views alone', async () => {
    const { scene, movement, applied, flush } = await setup()
    movement.move(scene, 'other-map', 'east')
    flush()
    expect(applied).toEqual(['mark'])
    expect(movement.getPosition(scene, 'map')).toEqual({ x: 1, y: 1 })
    expect(movement.getPosition(scene, 'other-map')).toEqual({ x: 1, y: 2 })
  })

  it('ignores cancelled delayed arrivals even if their scheduler callback still runs', async () => {
    const { lifecycle, scene, movement, tasks, applied, flush } = await setup()
    movement.move(scene, 'map', 'east')
    lifecycle.enterScene('second')
    expect(tasks[0]!.cancelled).toBe(true)
    tasks[0]!.callback()
    lifecycle.enterScene('first')
    flush()
    expect(applied).toEqual([])
    expect(movement.getPosition(lifecycle.activeScene!, 'map')).toEqual({ x: 1, y: 1 })
  })

  it('drops queued entry actions when their scene is left, including a return before delivery', async () => {
    const { lifecycle, scene, movement, applied, flush } = await setup()
    movement.move(scene, 'map', 'south')
    lifecycle.enterScene('second')
    lifecycle.enterScene('first')
    flush()
    expect(applied).toEqual([])
    expect(lifecycle.currentGame!.state).toEqual(new Map([['entered', false]]))
  })

  it('does not activate triggers when a save restores a player onto their tile', async () => {
    const slots = new Map<string, string>()

    const store = {
      read: (id: string) => slots.get(id),
      write: (id: string, value: string) => {
        slots.set(id, value)
      },
    }

    const first = await setup(store)
    first.movement.move(first.scene, 'map', 'south')
    first.flush()
    expect(first.engine.saves!.save()).toBe(true)
    const second = await setup(store)
    expect(second.engine.saves!.load()).toBe(true)
    second.flush()
    const game = second.lifecycle.currentGame!
    expect(game.mapMovement!.getPosition(second.lifecycle.activeScene!, 'map')).toEqual({
      x: 1,
      y: 2,
    })
    expect(game.state).toEqual(new Map([['entered', true]]))
    expect(second.applied).toEqual([])
  })
})

function directedRules(position: { x: number; y: number }, mapView = 'map') {
  return gameRulesSchema.parse({
    ...rules,
    actions: {
      ...rules.actions,
      travel: [
        {
          when: [{ type: 'scene-is', scene: 'first' }],
          effects: [{ type: 'enter-scene', scene: 'second', mapView, position }],
        },
      ],
    },
  })
}

describe('scene entrance coordinates', () => {
  it('places a map-exit arrival before rendering, overrides only the selected remembered map and persists the entrance', async () => {
    const slots = new Map<string, string>()

    const store = {
      read: (id: string) => slots.get(id),
      write: (id: string, value: string) => {
        slots.set(id, value)
      },
    }

    const authored = directedRules({ x: 1, y: 2 }, 'other-map')

    const { engine, lifecycle, scene, movement, tasks, applied, flush } = await setup(
      store,
      authored,
    )

    lifecycle.enterScene('second', { mapView: 'other-map', position: { x: 2, y: 2 } })
    lifecycle.enterScene('second', { mapView: 'map', position: { x: 0, y: 1 } })
    lifecycle.enterScene('first')
    const observed: unknown[] = []
    lifecycle.subscribeSceneChanges(({ current }) => {
      if (current?.data.id === 'second') observed.push(movement.getPosition(current, 'other-map'))
    })
    movement.move(lifecycle.activeScene!, 'map', 'east')
    tasks.find((task) => task.delay === 100 && !task.cancelled)!.callback()
    flush()
    expect(scene.disposed).toBe(true)
    expect(observed).toEqual([{ x: 1, y: 2 }])
    expect(movement.getPosition(lifecycle.activeScene!, 'map')).toEqual({ x: 0, y: 1 })
    expect(applied).toEqual(['travel'])
    expect(lifecycle.currentGame!.state).toEqual(new Map([['entered', false]]))
    expect(engine.saves!.save()).toBe(true)
    const loaded = await setup(store, authored)
    expect(loaded.engine.saves!.load()).toBe(true)
    loaded.flush()
    expect(
      loaded.lifecycle.currentGame!.mapMovement!.getPosition(
        loaded.lifecycle.activeScene!,
        'other-map',
      ),
    ).toEqual({ x: 1, y: 2 })
    expect(loaded.applied).toEqual([])
  })

  it('charges authored travel time from the entrance tile rather than the spawn tile', async () => {
    const { lifecycle, scene, movement, tasks, flush } = await setup(
      undefined,
      directedRules({ x: 2, y: 1 }),
    )

    movement.move(scene, 'map', 'east')
    tasks[0]!.callback()
    flush()
    // The step and the independently authored scene-travel effect each cost 100 ms.
    expect(lifecycle.currentGame!.actions!.progression).toEqual({ turn: 1, worldTimeMs: 200 })
    expect(movement.getPosition(lifecycle.activeScene!, 'map')).toEqual({ x: 2, y: 1 })
  })

  it('places direct action-bar navigation and later resumes that position without coordinates', async () => {
    const { lifecycle, scene, movement, applied, flush } = await setup()
    lifecycle.currentGame!.actionBar!.activate(scene, 'directions', '2')
    expect(lifecycle.activeScene!.data.id).toBe('second')
    expect(movement.getPosition(lifecycle.activeScene!, 'map')).toEqual({ x: 0, y: 1 })
    lifecycle.enterScene('first')
    lifecycle.enterScene('second')
    expect(movement.getPosition(lifecycle.activeScene!, 'map')).toEqual({ x: 0, y: 1 })
    flush()
    expect(applied).toEqual([])
  })

  it('supports same-scene placement and cancels the displaced pending step without firing triggers', async () => {
    const { lifecycle, scene, movement, tasks, applied, flush } = await setup()
    movement.move(scene, 'map', 'east')
    expect(lifecycle.enterScene('first', { mapView: 'map', position: { x: 1, y: 2 } })).toBe(scene)
    expect(tasks[0]!.cancelled).toBe(true)
    tasks[0]!.callback()
    flush()
    expect(movement.getPosition(scene, 'map')).toEqual({ x: 1, y: 2 })
    expect(applied).toEqual([])
  })

  it.each([
    { x: -1, y: 0 },
    { x: 3, y: 0 },
    { x: 0, y: 3 },
    { x: 0.5, y: 1 },
    { x: 1, y: 0 },
  ])(
    'rejects invalid runtime entrances before leaving or cancelling the current scene: %j',
    async (position) => {
      const { lifecycle, scene, movement, tasks } = await setup()
      movement.move(scene, 'map', 'east')
      expect(() => lifecycle.enterScene('second', { mapView: 'map', position })).toThrow(
        'Invalid destination map position',
      )
      expect(lifecycle.activeScene).toBe(scene)
      expect(scene.disposed).toBe(false)
      expect(tasks[0]!.cancelled).toBe(false)
      expect(movement.getPosition(scene, 'map')).toEqual({ x: 1, y: 1 })
    },
  )

  it('validates destination coordinates and map references in schemas, runtime loading and editor diagnostics', () => {
    for (const schema of [buttonActionSchema, ruleEffectSchema]) {
      expect(
        schema.safeParse({ type: 'enter-scene', scene: 'second', position: { x: 0, y: 1 } })
          .success,
      ).toBe(false)
      expect(
        schema.safeParse({
          type: 'enter-scene',
          scene: 'second',
          mapView: 'map',
          position: { x: 0.5, y: 1 },
        }).success,
      ).toBe(false)
    }

    for (const [mapView, position] of [
      ['missing', { x: 0, y: 1 }],
      ['map', { x: 1, y: 0 }],
      ['map', { x: 3, y: 0 }],
    ] as const) {
      const authored = directedRules(position, mapView)
      expect(() =>
        assembleGameData(
          manifest,
          scenes,
          input,
          undefined,
          new Map([['terrain', map]]),
          undefined,
          undefined,
          new Map([['travel', authored]]),
        ),
      ).toThrow(/destination|Destination/)

      const view = inspectProject({
        revision: 'entrance',
        documents: {
          'game.json': manifest,
          'maps/terrain.json': map,
          'rules/travel.json': authored,
          'input/keys.json': input,
          ...Object.fromEntries([...scenes].map(([id, scene]) => [`scenes/${id}.json`, scene])),
        },
      })

      expect(view.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ file: 'rules/travel.json' })]),
      )
    }
  })

  it.each(['no-player', 'display-only'])('rejects an entrance into a %s map view', (kind) => {
    const target = scenes.get('second')!
    const invalid = new Map(scenes)
    invalid.set(
      'second',
      sceneSchema.parse({
        ...target,
        components: target.components
          .filter((component) => component.type !== 'action-bar')
          .map((component) =>
            component.id === 'map'
              ? {
                  ...component,
                  ...(kind === 'no-player' ? { playerSpawn: undefined } : { interactive: false }),
                }
              : component,
          ),
      }),
    )
    const authored = directedRules({ x: 1, y: 2 })
    expect(
      validateRuleSources(
        [{ file: 'rules/travel.json', rules: authored }],
        invalid,
        new Map([['terrain', map]]),
        undefined,
        undefined,
      ).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['actions', 'travel', 0, 'effects', 0, 'mapView'] }),
      ]),
    )
  })

  it('keeps arrival placement and authored writes committed when a scene observer throws', async () => {
    const authored = directedRules({ x: 1, y: 2 })
    authored.actions.travel![0]!.effects.push({ type: 'set-state', path: ['entered'], value: true })
    const { lifecycle, scene, movement, tasks, applied, flush } = await setup(undefined, authored)

    const removeObserver = lifecycle.subscribeSceneChanges(() => {
      throw new Error('Observer failed')
    })

    movement.move(scene, 'map', 'east')
    tasks[0]!.callback()
    flush()
    removeObserver()
    expect(lifecycle.activeScene!.data.id).toBe('second')
    expect(movement.getPosition(lifecycle.activeScene!, 'map')).toEqual({ x: 1, y: 2 })
    expect(lifecycle.currentGame!.state).toEqual(new Map([['entered', true]]))
    expect(applied).toEqual(['travel'])
  })
})

describe('tile-entry trigger validation', () => {
  it.each([
    [{ id: 'exit', x: -1, y: 0, action: 'travel' }],
    [{ id: 'exit', x: 3, y: 0, action: 'travel' }],
    [{ id: 'exit', x: 0, y: 3, action: 'travel' }],
    [{ id: 'exit', x: 0.5, y: 0, action: 'travel' }],
    [
      { id: 'exit', x: 0, y: 0, action: 'travel' },
      { id: 'exit', x: 1, y: 1, action: 'mark' },
    ],
    [
      { id: 'exit', x: 0, y: 0, action: 'travel' },
      { id: 'event', x: 0, y: 0, action: 'mark' },
    ],
  ])('rejects malformed or duplicate tiles %#', (...entryTriggers) => {
    expect(mapDefinitionSchema.safeParse({ ...map, entryTriggers }).success).toBe(false)
  })

  it('rejects missing actions in both runtime loading and editor validation, including games without Rules', () => {
    const missing = { ...map, entryTriggers: [{ id: 'exit', x: 0, y: 0, action: 'absent' }] }
    expect(() =>
      assembleGameData(
        { ...manifest, rules: [] },
        scenes,
        input,
        undefined,
        new Map([['terrain', missing]]),
      ),
    ).toThrow('Unknown tile-entry action: absent')

    const view = inspectProject({
      revision: 'test',
      documents: {
        'game.json': manifest,
        'maps/terrain.json': missing,
        'rules/travel.json': rules,
        'input/keys.json': input,
        ...Object.fromEntries([...scenes].map(([id, scene]) => [`scenes/${id}.json`, scene])),
      },
    })

    expect(view.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'maps/terrain.json',
          message: 'Unknown tile-entry action: absent',
        }),
      ]),
    )
  })

  it('rejects unreachable triggers on ground and visible collision layers', () => {
    const validate = (candidate: MapDefinition) =>
      validateRuleSources(
        [{ file: 'rules/travel.json', rules }],
        scenes,
        new Map([['terrain', candidate]]),
        undefined,
        undefined,
      ).issues

    expect(
      validate({ ...map, entryTriggers: [{ id: 'wall', x: 1, y: 0, action: 'mark' }] }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Tile-entry triggers require a walkable tile' }),
      ]),
    )

    const layered = {
      ...map,
      layers: [
        {
          id: 'walls',
          tiles: [
            [null, null, null],
            [null, null, null],
            [null, 'wall', null],
          ],
        },
      ],
    }

    expect(validate(layered)).toHaveLength(1)
    expect(validate({ ...layered, layers: [{ ...layered.layers[0]!, visible: false }] })).toEqual(
      [],
    )
  })
})
