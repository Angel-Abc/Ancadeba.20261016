import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import { gameSchema, inputSchema, mapDefinitionSchema, sceneSchema } from '@ancadeba/schemas'
import {
  assembleGameData,
  Engine,
  type EngineMessages,
  type GameRules,
  type GameActionHandler,
  type WorldTimePolicy,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { applyCommand, inspectProject } from '@ancadeba/editor-core'

const placement = { row: 1, column: 1 }

const input = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['north', 'east', 'south', 'west'],
  keyboard: { KeyI: 'north', KeyL: 'east', ArrowRight: 'east', KeyK: 'south', KeyJ: 'west' },
  contexts: { explore: { north: 'north', east: 'east', south: 'south', west: 'west' } },
  'initial-context': 'explore',
})

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'movement',
  title: 'Movement',
  version: '1',
  scenes: ['first', 'second', 'menu'],
  maps: ['terrain'],
  input: 'movement',
  'initial-scene': 'first',
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
          map: 'terrain',
          label: 'Map',
          placement,
          viewport: { columns: 3, rows: 3 },
          playerSpawn: { x: 1, y: 1 },
        },
        {
          id: 'other-map',
          type: 'map-view',
          map: 'terrain',
          label: 'Other map',
          placement,
          viewport: { columns: 3, rows: 3 },
          playerSpawn: { x: 0, y: 2 },
        },
        {
          id: 'directions',
          type: 'action-bar',
          placement,
          slots: Object.fromEntries(
            ['north', 'east', 'south', 'west'].map((direction, index) => [
              String(index + 1),
              {
                label: direction,
                action: { type: 'move-map', mapView: 'map', direction },
                inputBinding: { context: 'explore', input: direction },
              },
            ]),
          ),
        },
      ],
    }),
  ]),
)

scenes.set(
  'menu',
  sceneSchema.parse({
    'schema-version': '1.0.0',
    id: 'menu',
    title: 'Menu',
    type: 'stand-alone',
    screen: { type: 'grid', grid: { rows: 1, columns: 1 } },
    components: [],
  }),
)

async function setup(rules?: GameRules, now: () => number = () => 0) {
  const game = assembleGameData(manifest, scenes, input, undefined, new Map([['terrain', map]]))
  const tasks: { callback: () => void; delay: number; cancelled: boolean }[] = []
  const fallback = vi.fn(() => ({ status: 'applied' as const }))

  const engine = new Engine(
    { load: async () => game },
    { mount: () => () => {} },
    { debug: () => '', info: () => '', warn: () => '', error: () => '' },
    () => new MessageBus<EngineMessages>(),
    {
      clock: { now },
      scheduler: {
        schedule(callback, delay) {
          if (delay === 0) return () => {}

          const task = { callback, delay, cancelled: false }
          tasks.push(task)

          return () => {
            task.cancelled = true
          }
        },
      },
      createGameRules: () =>
        rules ?? {
          handlers: new Map([['fallback', fallback]]),
          inputBindings: ['north', 'east'].flatMap((input) =>
            (['pressed', 'released', 'cancelled'] as const).map((phase) => ({
              context: 'explore',
              input,
              phase,
              action: 'fallback',
            })),
          ),
        },
    },
  )

  onTestFinished(() => engine.stop())
  await engine.start()
  const lifecycle = engine.lifecycle!
  const scene = lifecycle.activeScene!
  const movement = lifecycle.currentGame!.mapMovement!
  const bar = lifecycle.currentGame!.actionBar!

  const flush = () => {
    for (let i = 0; i < 4; i++) engine.flushMessages()
  }

  const press = (code: string) => {
    engine.input!.pressKey(code)
    engine.input!.releaseKey(code)
    flush()
  }

  return { engine, lifecycle, scene, movement, bar, tasks, fallback, flush, press }
}

describe('map movement actions', () => {
  it('charges one turn and terrain time only on completed steps across input and map views', async () => {
    const { engine, scene, movement, bar, tasks, press } = await setup()
    const actions = engine.lifecycle!.currentGame!.actions!
    expect(movement.move(scene, 'map', 'north')).toBe(false)
    expect(actions.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    press('KeyL')
    expect(movement.move(scene, 'map', 'west')).toBe(false)
    expect(actions.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    tasks[0]!.callback()
    expect(actions.progression).toEqual({ turn: 1, worldTimeMs: 100 })
    tasks[0]!.callback()
    expect(actions.progression).toEqual({ turn: 1, worldTimeMs: 100 })
    bar.activate(scene, 'directions', '3')
    expect(actions.progression).toEqual({ turn: 2, worldTimeMs: 100 })
    movement.move(scene, 'other-map', 'east')
    expect(actions.progression).toEqual({ turn: 3, worldTimeMs: 100 })
  })

  it.each<WorldTimePolicy['mode']>(['action-driven', 'elapsed', 'hybrid'])(
    'uses the configured %s world clock when a timed step completes',
    async (mode) => {
      let now = 0

      const { engine, scene, movement, tasks, flush } = await setup(
        { handlers: new Map(), worldTime: { mode, rate: 2 } },
        () => now,
      )

      movement.move(scene, 'map', 'east')
      now = 100
      tasks.find((task) => task.delay === 100)!.callback()
      flush()
      expect(engine.lifecycle!.currentGame!.actions!.progression).toEqual({
        turn: 1,
        worldTimeMs: mode === 'action-driven' ? 100 : mode === 'elapsed' ? 200 : 300,
      })
    },
  )

  it('commits position and progression before observers and world-time scheduled actions run', async () => {
    const due = vi.fn<GameActionHandler>(() => ({ status: 'applied' }))

    const { engine, scene, movement, tasks, flush } = await setup({
      handlers: new Map([['due', due]]),
    })

    const actions = engine.lifecycle!.currentGame!.actions!
    actions.scheduleWorld('due', 100)
    const snapshots: unknown[] = []
    movement.subscribeChanges(() => {
      if (!movement.isMoving(scene, 'map'))
        snapshots.push({
          position: movement.getPosition(scene, 'map'),
          progression: actions.progression,
        })
    })
    movement.move(scene, 'map', 'east')
    flush()
    expect(due).not.toHaveBeenCalled()
    tasks[0]!.callback()
    expect(snapshots).toEqual([
      { position: { x: 2, y: 1 }, progression: { turn: 1, worldTimeMs: 100 } },
    ])
    flush()
    expect(due).toHaveBeenCalledTimes(1)
    expect(due.mock.calls[0]?.[1].progression).toEqual({ turn: 1, worldTimeMs: 100 })
    expect(actions.progression).toEqual({ turn: 1, worldTimeMs: 100 })
  })

  it('preserves a committed step and charges once when a movement observer throws', async () => {
    const { engine, scene, movement, tasks } = await setup()
    const actions = engine.lifecycle!.currentGame!.actions!
    movement.move(scene, 'map', 'east')

    const unsubscribe = movement.subscribeChanges(() => {
      expect(actions.progression).toEqual({ turn: 1, worldTimeMs: 100 })
      expect(movement.getPosition(scene, 'map')).toEqual({ x: 2, y: 1 })
      throw new Error('Observer failure')
    })

    expect(() => tasks[0]!.callback()).toThrow('Map arrival subscribers failed')
    unsubscribe()
    tasks[0]!.callback()
    expect(actions.progression).toEqual({ turn: 1, worldTimeMs: 100 })
    expect(movement.getPosition(scene, 'map')).toEqual({ x: 2, y: 1 })
  })

  it('advances the progression counter without rotating independently configured actor turns', async () => {
    const { engine, scene, movement, tasks } = await setup({
      handlers: new Map(),
      turns: { actors: ['player', 'enemy'], phases: ['act'], actionPolicies: new Map() },
    })

    const actions = engine.lifecycle!.currentGame!.actions!
    const turn = actions.turnState
    movement.move(scene, 'map', 'east')
    tasks[0]!.callback()
    expect(actions.progression).toEqual({ turn: 1, worldTimeMs: 100 })
    expect(actions.turnState).toBe(turn)
  })

  it('does not charge cancelled steps, scene entrances, restores or new-game spawns', async () => {
    const { engine, scene, movement, lifecycle, tasks } = await setup()
    const actions = lifecycle.currentGame!.actions!
    movement.move(scene, 'map', 'east')
    lifecycle.enterScene('second')
    tasks[0]!.callback()

    const returned = lifecycle.enterScene('first', {
      mapView: 'map',
      position: { x: 2, y: 1 },
    })

    expect(actions.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    lifecycle.enterScene('first', { mapView: 'map', position: { x: 1, y: 1 } })
    movement.move(returned, 'map', 'east')
    lifecycle.startGame()
    const fresh = lifecycle.enterScene('first')
    tasks[1]!.callback()
    expect(engine.lifecycle!.currentGame!.actions!.progression).toEqual({ turn: 0, worldTimeMs: 0 })
    expect(lifecycle.currentGame!.mapMovement!.getPosition(fresh, 'map')).toEqual({ x: 1, y: 1 })
  })

  it('resumes each scene and map view independently, including after visiting a stand-alone menu', async () => {
    const { scene, movement, lifecycle, tasks } = await setup()
    expect(movement.move(scene, 'map', 'east')).toBe(true)
    tasks[0]!.callback()
    expect(movement.move(scene, 'other-map', 'east')).toBe(true)
    const second = lifecycle.enterScene('second')
    expect(movement.getPosition(second, 'map')).toEqual({ x: 1, y: 1 })
    expect(movement.move(second, 'map', 'west')).toBe(true)
    expect(movement.getPosition(second, 'other-map')).toEqual({ x: 0, y: 2 })
    const returned = lifecycle.enterScene('first')
    expect(movement.getPosition(returned, 'map')).toEqual({ x: 2, y: 1 })
    expect(movement.getPosition(returned, 'other-map')).toEqual({ x: 1, y: 2 })
    lifecycle.enterScene('menu')
    const resumed = lifecycle.enterScene('first')
    expect(movement.getPosition(resumed, 'map')).toEqual({ x: 2, y: 1 })
    expect(movement.getPosition(lifecycle.enterScene('second'), 'map')).toEqual({ x: 0, y: 1 })
    lifecycle.startGame()
    const fresh = lifecycle.enterScene('first')
    expect(lifecycle.currentGame!.mapMovement!.getPosition(fresh, 'map')).toEqual({ x: 1, y: 1 })
    expect(lifecycle.currentGame!.mapMovement!.getPosition(fresh, 'other-map')).toEqual({
      x: 0,
      y: 2,
    })
    expect(movement.getPosition(fresh, 'map')).toBeUndefined()
  })

  it('cancels an unfinished step and retains the last completed position when returning', async () => {
    const { scene, movement, lifecycle, tasks } = await setup()
    movement.move(scene, 'map', 'east')
    tasks[0]!.callback()
    movement.move(scene, 'map', 'west')
    movement.move(scene, 'map', 'east')
    const unfinished = tasks[1]!
    lifecycle.enterScene('second')
    expect(unfinished.cancelled).toBe(true)
    const returned = lifecycle.enterScene('first')
    unfinished.callback()
    expect(movement.getPosition(returned, 'map')).toEqual({ x: 1, y: 1 })
    movement.move(returned, 'map', 'east')
    tasks[2]!.callback()
    lifecycle.leaveScene()
    expect(movement.getPosition(lifecycle.enterScene('first'), 'map')).toEqual({ x: 2, y: 1 })
  })

  it('shares timed steps across keyboard and click, respects walls and boundaries, and isolates map views', async () => {
    const { scene, movement, bar, tasks, press, fallback } = await setup()
    const changes = vi.fn()
    const unsubscribe = movement.subscribeChanges(changes)
    expect(movement.getPosition(scene, 'map')).toEqual({ x: 1, y: 1 })
    expect(bar.isEnabled(scene, 'directions', '1')).toBe(false)
    press('KeyI')
    expect(fallback).not.toHaveBeenCalled()
    press('KeyL')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.delay).toBe(100)
    expect(movement.getPosition(scene, 'map')).toEqual({ x: 1, y: 1 })
    expect(bar.isEnabled(scene, 'directions', '3')).toBe(false)
    press('ArrowRight')
    bar.activate(scene, 'directions', '3')
    expect(tasks).toHaveLength(1)
    tasks[0]!.callback()
    expect(movement.getPosition(scene, 'map')).toEqual({ x: 2, y: 1 })
    expect(bar.isEnabled(scene, 'directions', '2')).toBe(false)
    bar.activate(scene, 'directions', '3')
    expect(movement.getPosition(scene, 'map')).toEqual({ x: 2, y: 2 })
    expect(bar.isEnabled(scene, 'directions', '3')).toBe(false)
    expect(movement.getPosition(scene, 'other-map')).toEqual({ x: 0, y: 2 })
    expect(movement.move(scene, 'other-map', 'east')).toBe(true)
    expect(movement.getPosition(scene, 'other-map')).toEqual({ x: 1, y: 2 })
    expect(movement.getPosition(scene, 'map')).toEqual({ x: 2, y: 2 })
    expect(fallback).not.toHaveBeenCalled()
    expect(changes).toHaveBeenCalledTimes(4)
    unsubscribe()
  })

  it('discards queued and held gestures after a scene change and cancels steps on scene replacement and restart', async () => {
    const { engine, lifecycle, scene, movement, bar, tasks, flush, fallback } = await setup()
    engine.input!.pressKey('KeyL')
    lifecycle.enterScene('second')
    const second = lifecycle.activeScene!
    flush()
    engine.input!.releaseKey('KeyL')
    flush()
    expect(tasks).toHaveLength(0)
    expect(movement.getPosition(second, 'map')).toEqual({ x: 1, y: 1 })
    expect(movement.move(scene, 'map', 'east')).toBe(false)
    bar.activate(second, 'directions', '2')
    const staleTask = tasks[0]!
    lifecycle.enterScene('first')
    const replacement = lifecycle.activeScene!
    expect(staleTask.cancelled).toBe(true)
    staleTask.callback()
    expect(movement.getPosition(replacement, 'map')).toEqual({ x: 1, y: 1 })
    bar.activate(replacement, 'directions', '2')
    const pending = tasks[1]!
    engine.stop()
    expect(pending.cancelled).toBe(true)
    pending.callback()
    expect(movement.getPosition(replacement, 'map')).toBeUndefined()
    await engine.start()
    const restarted = engine.lifecycle!.activeScene!
    expect(engine.lifecycle!.currentGame!.mapMovement!.getPosition(restarted, 'map')).toEqual({
      x: 1,
      y: 1,
    })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('keeps disabled movement ownership for cancelled input and rejects invalid runtime targets', async () => {
    const { engine, scene, movement, fallback, flush } = await setup()
    engine.input!.pressKey('KeyI')
    engine.input!.reset()
    flush()
    expect(fallback).not.toHaveBeenCalled()
    expect(movement.move(scene, 'directions', 'east')).toBe(false)
    expect(movement.move(scene, 'missing', 'east')).toBe(false)
  })

  it('validates scene-local interactive targets and round-trips movement slots through the editor', () => {
    const scene = scenes.get('first')!
    const actionBar = scene.components.find((c) => c.type === 'action-bar')!

    const project = {
      revision: 'one',
      documents: {
        'game.json': manifest,
        'input/movement.json': input,
        'maps/terrain.json': map,
        ...Object.fromEntries([...scenes].map(([id, scene]) => [`scenes/${id}.json`, scene])),
      },
    }

    const edited = applyCommand(project, {
      type: 'scene.setActionBar',
      sceneId: 'first',
      component: actionBar,
    })

    expect(inspectProject(edited.project).scenes[0]!.components).toContainEqual(actionBar)

    for (const mapView of ['missing', 'directions']) {
      expect(() =>
        sceneSchema.parse({
          ...scene,
          components: [
            ...scene.components,
            {
              id: 'move-button',
              type: 'button',
              placement,
              label: 'North',
              action: { type: 'move-map', mapView, direction: 'north' },
            },
          ],
        }),
      ).toThrow('interactive map view')
    }

    for (const override of [{ interactive: false }, { playerSpawn: undefined }]) {
      expect(() =>
        sceneSchema.parse({
          ...scene,
          components: scene.components.map((c) => (c.id === 'map' ? { ...c, ...override } : c)),
        }),
      ).toThrow('interactive map view')
    }

    expect(() => sceneSchema.parse({ ...scene, type: 'stand-alone' })).toThrow('same game scene')
  })
})
