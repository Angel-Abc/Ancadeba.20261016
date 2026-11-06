import { describe, it, expect, vi, onTestFinished } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatComponentSchema,
  combatIssues,
  localizeCombat,
  gameSchema,
  gameRulesSchema,
  sceneSchema,
  inputSchema,
} from '@ancadeba/schemas'
import {
  Engine,
  GameLifecycle,
  MapStateTransactions,
  assembleGameData,
  type EngineMessages,
  type CombatSnapshot,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { applyCommand, inspectProject, object, validateProject } from '@ancadeba/editor-core'

const encounter = combatDefinitionSchema.parse({
  'schema-version': '1.0.0',
  id: 'training',
  label: 'Training',
  seed: 1234,
  allowEscape: true,
  roundTimeMs: 250,
  player: {
    id: 'player',
    label: 'Player',
    health: { source: 'game.state', path: ['health'] },
    maximumHealth: 50,
    moves: ['attack', 'heavy', 'guard'],
  },
  enemies: ['first', 'second'].map((id) => ({
    id,
    label: id,
    health: { source: 'game.state', path: [id] },
    maximumHealth: 30,
    moves: ['attack', 'guard'],
    rotation: ['guard', 'attack'],
  })),
  moves: {
    attack: { type: 'attack', label: '<b>Attack</b>', apCost: 1, damage: { min: 4, max: 8 } },
    heavy: { type: 'attack', label: 'Heavy', apCost: 2, damage: { min: 9, max: 12 } },
    guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 6 },
  },
  outcomes: { victory: 'other', defeat: 'other', escaped: 'other' },
})

const rules = gameRulesSchema.parse({
  state: [
    { path: ['health'], value: 50 },
    { path: ['first'], value: 30 },
    { path: ['second'], value: 30 },
  ],
  actions: {},
})

const view = combatComponentSchema.parse({
  id: 'combat',
  type: 'combat',
  encounter: 'training',
  textTarget: 'narrative',
  placement: { row: 1, column: 1 },
})

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'combat',
  title: 'Combat',
  version: '1',
  rules: ['values'],
  combat: ['training'],
  scenes: ['fight', 'other'],
  'initial-scene': 'fight',
  input: 'keys',
})

const commands = {
  '1': { type: 'queue-move', move: 'attack' },
  '2': { type: 'queue-move', move: 'heavy' },
  '3': { type: 'queue-move', move: 'guard' },
  '4': { type: 'undo' },
  '5': { type: 'clear' },
  '6': { type: 'next-target' },
  '7': { type: 'previous-target' },
  '8': { type: 'escape' },
  '14': { type: 'continue' },
  '15': { type: 'end-turn' },
}

const scene = sceneSchema.parse({
  'schema-version': '1.0.0',
  id: 'fight',
  title: 'Fight',
  type: 'game',
  screen: { type: 'grid', grid: { rows: 4, columns: 5 } },
  components: [
    view,
    { id: 'narrative', type: 'text', text: 'Training', placement: { row: 1, column: 1 } },
    {
      id: 'bar',
      type: 'action-bar',
      placement: { row: 4, column: 1 },
      slots: Object.fromEntries(
        Object.entries(commands).map(([id, command]) => [
          id,
          {
            label: id,
            action: { type: 'combat-action', combat: 'combat', command },
            inputBinding: { context: 'combat', input: `slot-${id}` },
          },
        ]),
      ),
    },
  ],
})

const input = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': Object.keys(commands).map((id) => `slot-${id}`),
  keyboard: Object.fromEntries(
    Object.keys(commands).map((id, index) => [`Key${'QWERTASDBC'[index]}`, `slot-${id}`]),
  ),
  contexts: {
    combat: Object.fromEntries(Object.keys(commands).map((id) => [`slot-${id}`, `slot-${id}`])),
    menu: { 'slot-1': 'menu' },
  },
  'initial-context': 'combat',
})

async function setup(
  options: {
    single?: boolean
    adapter?: boolean
    outerTurns?: boolean
    guardOverflow?: boolean
    lethal?: boolean
  } = {},
) {
  const definition = combatDefinitionSchema.parse({
    ...encounter,
    enemies: options.single ? [encounter.enemies[0]] : encounter.enemies,
    moves: {
      ...encounter.moves,
      ...(options.guardOverflow
        ? { guard: { ...encounter.moves.guard, guard: Number.MAX_SAFE_INTEGER } }
        : {}),
      ...(options.lethal
        ? { attack: { ...encounter.moves.attack, damage: { min: 30, max: 30 } } }
        : {}),
    },
  })

  const scenes = new Map([
    ['fight', scene],
    ['other', sceneSchema.parse({ ...scene, id: 'other', components: [] })],
  ])

  const data = assembleGameData(
    manifest,
    scenes,
    input,
    undefined,
    new Map(),
    new Map(),
    undefined,
    new Map([['values', rules]]),
    new Map([['training', definition]]),
  )

  const fallback = vi.fn(() => ({ status: 'applied' as const }))
  const logger = { debug: () => '', info: () => '', warn: () => '', error: vi.fn(() => '') }

  const engine = new Engine(
    { load: async () => data },
    { mount: () => () => {} },
    logger,
    () => new MessageBus<EngineMessages>(),
    {
      clock: { now: () => 0 },
      scheduler: { schedule: () => () => {} },
      createGameLifecycle: (data) =>
        new GameLifecycle(data, {
          createGameState: () =>
            new Map<string, unknown>(rules.state.map((field) => [field.path[0]!, field.value])),
          createSceneState: () => undefined,
        }),
      createStateTransactions: (game) =>
        game.state instanceof Map && options.adapter !== false
          ? new MapStateTransactions(
              game.state,
              rules.state.map((field) => field.path),
            )
          : undefined,
      createGameRules: () => ({
        handlers: new Map([
          ['fallback', fallback],
          ['changed', () => ({ status: 'applied' as const })],
        ]),
        ...(options.outerTurns
          ? {
              turns: {
                actors: ['explorer'],
                phases: ['exploration'],
                actionPolicies: new Map([
                  ['fallback', { scope: 'global' as const }],
                  ['changed', { scope: 'global' as const }],
                ]),
              },
            }
          : {}),
        inputBindings: (['pressed', 'released', 'cancelled'] as const).map((phase) => ({
          context: 'combat',
          input: 'slot-1',
          phase,
          action: 'fallback',
        })),
      }),
    },
  )

  await engine.start()
  onTestFinished(() => engine.stop())
  const game = () => engine.lifecycle!.currentGame!
  const active = () => engine.lifecycle!.activeScene!
  const snapshot = () => game().combat!.snapshot(active(), 'combat')!

  const flush = () => {
    for (let i = 0; i < 6; i++) engine.flushMessages()
  }

  const bar = (slot: string) => {
    game().actionBar!.activate(active(), 'bar', slot)
    flush()
  }

  const select = (id = 'first') => game().combat!.selectTarget(active(), 'combat', id)

  const state = () => {
    const state = game().state

    if (!(state instanceof Map)) throw new Error('Expected Map')

    return state
  }

  return { engine, game, active, snapshot, flush, bar, select, state, fallback, logger, definition }
}

describe('AP combat planning and resolution', () => {
  it('requires multi-enemy target selection, reserves AP, and supports undo, clear, and repeated moves', async () => {
    const { game, active, snapshot, bar, select } = await setup()
    expect(snapshot().target).toBeUndefined()
    expect(game().actionBar!.isEnabled(active(), 'bar', '1')).toBe(false)
    select()
    bar('1')
    bar('2')
    expect(snapshot().remainingAp).toBe(0)
    expect(snapshot().plan.map((move) => move.target)).toEqual(['first', 'first'])
    expect(game().actionBar!.isEnabled(active(), 'bar', '1')).toBe(false)
    bar('4')
    expect(snapshot().remainingAp).toBe(2)
    select('second')
    bar('1')
    expect(snapshot().plan.map((move) => move.target)).toEqual(['first', 'second'])
    bar('5')
    expect(snapshot().remainingAp).toBe(3)
    expect(snapshot().health).toEqual({ player: 50, first: 30, second: 30 })
  })

  it('preserves rapid move input ordering before End Turn and advances game progression once', async () => {
    const { engine, select, flush, snapshot, game } = await setup()
    select()

    for (const key of ['KeyQ', 'KeyW', 'KeyC']) {
      engine.input!.pressKey(key)
      engine.input!.releaseKey(key)
    }

    flush()
    expect(snapshot().round).toBe(2)
    expect(snapshot().log.filter((entry) => entry.actor === 'player')).toHaveLength(2)
    expect(game().actions!.progression).toEqual({ turn: 1, worldTimeMs: 250 })
    expect(snapshot().remainingAp).toBe(3)
  })

  it('rolls only on commitment with reproducible inclusive ranges and stable enemy plans', async () => {
    const first = await setup()
    const second = await setup()
    const enemyPlans = first.snapshot().enemyPlans
    first.select()
    first.bar('1')
    first.bar('4')
    first.select('second')
    first.bar('5')
    expect(first.snapshot().enemyPlans).toEqual(enemyPlans)
    first.select()
    second.select()

    for (const state of [first, second]) {
      state.bar('1')
      state.bar('15')
    }

    expect(first.snapshot().log).toEqual(second.snapshot().log)

    const damage = first
      .snapshot()
      .log.find((entry) => entry.type === 'attack' && entry.actor === 'player')!.damage!

    expect(damage).toBeGreaterThanOrEqual(4)
    expect(damage).toBeLessThanOrEqual(8)
  })

  it('allows empty plans, keeps enemy guard for the next player queue, and expires it at the enemy turn', async () => {
    const { snapshot, bar, select } = await setup({ single: true })
    expect(snapshot().target).toBe('first')
    bar('15')
    expect(snapshot().guard.first).toBe(12)
    select()
    bar('1')
    bar('15')

    const attacks = snapshot().log.filter(
      (entry) => entry.type === 'attack' && entry.actor === 'player',
    )

    expect(attacks[0]!.damage).toBe(0)
    expect(attacks[0]!.blocked).toBeGreaterThan(0)
    expect(snapshot().round).toBe(3)
  })

  it('skips defeated targets without retargeting or extra rolls and immediately records victory', async () => {
    const { select, bar, snapshot, engine } = await setup({ lethal: true })
    select()
    bar('1')
    bar('1')
    select('second')
    bar('1')
    bar('15')
    expect(snapshot().outcome).toBe('victory')
    expect(snapshot().log.map((entry) => entry.type)).toEqual([
      'attack',
      'skipped',
      'attack',
      'victory',
    ])
    bar('14')
    expect(engine.lifecycle!.activeScene!.data.id).toBe('other')
    engine.lifecycle!.enterScene('fight')
    expect(snapshot().outcome).toBe('victory')
  })

  it('stops on defeat and allows author-enabled guaranteed escape as the entire plan', async () => {
    const defeat = await setup({ single: true })
    defeat.state().set('health', 1)
    defeat.bar('15')
    expect(defeat.snapshot().outcome).toBe('defeat')
    expect(defeat.snapshot().health.player).toBe(0)
    const escaping = await setup()
    escaping.select()
    escaping.bar('1')
    escaping.bar('8')
    expect(escaping.snapshot().plan).toHaveLength(0)
    expect(escaping.snapshot().remainingAp).toBe(0)
    escaping.bar('4')
    expect(escaping.snapshot().remainingAp).toBe(3)
    escaping.bar('8')
    escaping.bar('15')
    expect(escaping.snapshot().outcome).toBe('escaped')
    expect(escaping.snapshot().health.player).toBe(50)
    expect(escaping.snapshot().log).toEqual([{ type: 'escaped' }])
    expect(escaping.game().actions!.progression.turn).toBe(1)
  })

  it('pauses plans, intentions, and RNG on scene changes and resets only on New Game', async () => {
    const { select, bar, snapshot, engine, state } = await setup()
    select()
    bar('1')
    const before = snapshot()
    engine.lifecycle!.enterScene('other')
    engine.lifecycle!.enterScene('fight')
    expect(snapshot()).toEqual(before)
    bar('15')
    const health = state().get('health')
    engine.lifecycle!.enterScene('other')
    engine.lifecycle!.enterScene('fight')
    expect(state().get('health')).toBe(health)
    engine.lifecycle!.startGame()
    engine.lifecycle!.enterScene('fight')
    expect(snapshot().round).toBe(1)
    expect(snapshot().plan).toHaveLength(0)
    expect(state().get('health')).toBe(50)
  })

  it.each(['target', 'scene', 'restart', 'round'])(
    'discards queued moves after changing %s and consumes held terminal phases',
    async (change) => {
      const { select, engine, flush, game, active, snapshot, fallback } = await setup()
      select()
      engine.input!.pressKey('KeyQ')

      if (change === 'target') select('second')

      if (change === 'scene') {
        engine.lifecycle!.enterScene('other')
        engine.lifecycle!.enterScene('fight')
      }

      if (change === 'restart') {
        engine.lifecycle!.startGame()
        engine.lifecycle!.enterScene('fight')
      }

      if (change === 'round') {
        const capture = game().combat!.capture(active(), 'combat', { type: 'end-turn' })!
        // Queue End Turn ahead of delivery of the captured move command.
        game().combat!.request(active(), 'combat', { type: 'end-turn' }, capture)
      }

      flush()
      engine.input!.releaseKey('KeyQ')
      flush()
      expect(snapshot().plan).toHaveLength(0)
      expect(fallback).not.toHaveBeenCalled()
    },
  )

  it('claims disabled inputs, cancels on context changes, and leaves game actor turns intact', async () => {
    const { engine, flush, fallback, bar, game, snapshot } = await setup({ outerTurns: true })
    engine.input!.pressKey('KeyQ')
    engine.input!.setContext('menu')
    flush()
    expect(fallback).not.toHaveBeenCalled()
    bar('15')
    expect(game().actions!.turnState).toMatchObject({
      actorId: 'explorer',
      phaseId: 'exploration',
      round: 1,
      revision: 0,
    })
    expect(game().actions!.progression.turn).toBe(1)
    expect(snapshot().round).toBe(2)
  })

  it.each([-1, 1.5, NaN, Infinity, '50', 51, undefined])(
    'rejects invalid live health %s without consuming resources',
    async (value) => {
      const { state, snapshot, game, active } = await setup()
      state().set('health', value)
      expect(snapshot().issue).toBeDefined()
      expect(game().combat!.canCommand(active(), 'combat', { type: 'end-turn' })).toBe(false)
      expect(game().actions!.progression.turn).toBe(0)
    },
  )

  it('rejects overflow atomically and lets the corrected plan retry without consuming RNG', async () => {
    const { bar, select, snapshot, state, game } = await setup({ guardOverflow: true })
    bar('3')
    bar('3')
    bar('15')
    expect(snapshot().round).toBe(1)
    expect(snapshot().plan).toHaveLength(2)
    expect(snapshot().log).toHaveLength(0)
    expect(state().get('health')).toBe(50)
    expect(game().actions!.progression.turn).toBe(0)
    bar('5')
    select()
    bar('1')
    // Enemy guard also overflows, so the complete simulation must still remain uncommitted.
    bar('15')
    expect(state().get('first')).toBe(30)
    expect(snapshot().log).toHaveLength(0)
  })

  it('keeps committed health, round, RNG, and progression after an observer fails', async () => {
    const { game, snapshot, bar, select } = await setup()
    select()
    bar('1')
    const observations: CombatSnapshot[] = []
    game().bindings!.subscribeChanges(() => {
      throw new Error('observer')
    })
    const unsubscribe = game().combat!.subscribeChanges(() => observations.push(snapshot()))
    expect(() => bar('15')).toThrow()
    unsubscribe()
    expect(snapshot().round).toBe(2)
    expect(snapshot().health.first).toBeLessThan(30)
    expect(game().actions!.progression.turn).toBe(1)
    expect(observations.some((snapshot) => snapshot.round === 2)).toBe(true)
  })

  it('disables mutations without state access while retaining enemy inspection', async () => {
    const { snapshot, game, active } = await setup({ adapter: false })
    expect(snapshot().enemyPlans.first!.moves).toHaveLength(3)
    expect(game().combat!.canCommand(active(), 'combat', { type: 'end-turn' })).toBe(false)
  })
})

describe('combat validation, localization, and editing', () => {
  const project = () => ({
    revision: 'one',
    documents: {
      'game.json': manifest,
      'scenes/fight.json': scene,
      'scenes/other.json': { ...scene, id: 'other', components: [] },
      'input/keys.json': input,
      'rules/values.json': rules,
      'combat/training.json': encounter,
    },
  })

  it('validates actor identity, bindings, moves, rotations, references, and asset changes', () => {
    expect(validateProject(project().documents)).toEqual([])
    expect(() =>
      combatDefinitionSchema.parse({
        ...encounter,
        player: { ...encounter.player, id: '__proto__' },
      }),
    ).toThrow('Reserved combat identifier')
    expect(() =>
      combatDefinitionSchema.parse({ ...encounter, enemies: [encounter.player] }),
    ).toThrow('unique')
    expect(() =>
      combatDefinitionSchema.parse({
        ...encounter,
        enemies: [{ ...encounter.enemies[0], rotation: ['unknown'] }],
      }),
    ).toThrow('rotations')
    expect(
      combatIssues(
        { ...encounter, player: { ...encounter.player, portrait: 'missing' } },
        rules,
        new Set(['other']),
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['portrait'] })]))
    expect(() =>
      applyCommand(project(), { type: 'game.removeCombat', encounterId: 'training' }),
    ).toThrow('invalid project')
    expect(() =>
      applyCommand(project(), {
        type: 'game.updateRules',
        ruleId: 'values',
        rules: { ...rules, state: rules.state.slice(1) },
      }),
    ).toThrow('invalid project')
    expect(() =>
      applyCommand(project(), {
        type: 'game.upsertCombat',
        encounter: { ...encounter, player: { ...encounter.player, moves: ['guard'] } },
      }),
    ).toThrow('invalid project')
  })
  it('localizes presentation without replacing combat mechanics and retains extension properties', () => {
    const localized = localizeCombat(
      {
        ...encounter,
        labelKey: 'name',
        player: { ...encounter.player, labelKey: 'player' },
        messageKeys: { attack: 'attack' },
      },
      {
        fallback: { name: 'Training', player: 'Player', attack: '{actor}: {damage}' },
        messages: { name: 'Training NL', player: 'Speler', attack: '<b>{actor}</b>: {damage}' },
      },
    )

    expect(localized.player.label).toBe('Speler')
    expect(localized.messages.attack).toContain('<b>')
    const initial = project()

    const updated = applyCommand(
      {
        ...initial,
        documents: {
          ...initial.documents,
          'combat/training.json': {
            ...encounter,
            extension: 'encounter',
            player: { ...encounter.player, extension: 'actor' },
            moves: { ...encounter.moves, attack: { ...encounter.moves.attack, extension: 'move' } },
          },
        },
      },
      { type: 'game.upsertCombat', encounter: { ...encounter, label: 'Changed' } },
    )

    expect(updated.project.documents['combat/training.json']).toMatchObject({
      extension: 'encounter',
      player: { extension: 'actor' },
      moves: { attack: { extension: 'move' } },
    })
    expect(inspectProject(updated.project).combat!.training!.label).toBe('Changed')
    expect(object(updated.project.documents['game.json']).combat).toEqual(['training'])
  })
})
