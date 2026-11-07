import { describe, it, expect, onTestFinished, vi } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  gameRulesSchema,
  gameSchema,
  sceneSchema,
  inputSchema,
  inventorySchema,
  localizeCombat,
} from '@ancadeba/schemas'
import {
  Engine,
  GameLifecycle,
  MapStateTransactions,
  assembleGameData,
  resolveCombatRound,
  planEnemies,
  combatMoveTarget,
  type CombatStatuses,
  type EngineMessages,
} from '@ancadeba/game-runtime'
import { MessageBus } from '@ancadeba/utilities'
import { applyCommand, validateProject, object } from '@ancadeba/editor-core'

const field = (key: string) => ({ source: 'game.state' as const, path: [key] })

const definition = combatDefinitionSchema.parse({
  'schema-version': '1.0.0',
  id: 'fight',
  label: 'Fight',
  seed: 1024,
  allowEscape: true,
  player: {
    id: 'player',
    label: 'Player',
    health: field('hp'),
    maximumHealth: field('max'),
    moves: [
      'attack',
      'guard',
      'poison',
      'recover',
      'focus',
      'weaken',
      'stun',
      'regen',
      'cleanse',
      'combo',
      'refresh',
    ],
  },
  enemies: [
    {
      id: 'enemy',
      label: 'Enemy',
      health: field('enemy'),
      maximumHealth: 100,
      ap: 2,
      moves: ['attack', 'stun'],
      rotation: ['attack'],
    },
  ],
  moves: {
    attack: { type: 'attack', label: 'Attack', apCost: 1, damage: { min: 2, max: 2 } },
    guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 2 },
    poison: {
      type: 'ability',
      label: 'Poison strike',
      apCost: 1,
      cooldown: 1,
      target: 'enemy',
      effects: [
        { id: 'hit', type: 'damage', damage: { min: 2, max: 2 } },
        { id: 'poison', type: 'apply-status', status: 'poison' },
      ],
    },
    recover: {
      type: 'ability',
      label: 'Recover',
      apCost: 1,
      cooldown: 2,
      target: 'self',
      effects: [{ id: 'heal', type: 'heal', amount: 10 }],
    },
    focus: {
      type: 'ability',
      label: 'Focus',
      apCost: 1,
      target: 'self',
      effects: [{ id: 'focus', type: 'apply-status', status: 'focus' }],
    },
    weaken: {
      type: 'ability',
      label: 'Weaken',
      apCost: 1,
      target: 'enemy',
      effects: [{ id: 'weak', type: 'apply-status', status: 'weak' }],
    },
    stun: {
      type: 'ability',
      label: 'Stun',
      apCost: 1,
      cooldown: 2,
      target: 'enemy',
      effects: [{ id: 'stun', type: 'apply-status', status: 'stun' }],
    },
    regen: {
      type: 'ability',
      label: 'Regenerate',
      apCost: 1,
      target: 'self',
      effects: [{ id: 'regen', type: 'apply-status', status: 'regen' }],
    },
    cleanse: {
      type: 'ability',
      label: 'Cleanse',
      apCost: 1,
      target: 'self',
      effects: [{ id: 'remove', type: 'remove-status', status: 'poison' }],
    },
    combo: {
      type: 'ability',
      label: 'Focus strike',
      apCost: 1,
      target: 'enemy',
      effects: [
        { id: 'focus', type: 'apply-status', status: 'focus', target: 'self' },
        { id: 'hit', type: 'damage', damage: { min: 2, max: 2 } },
      ],
    },
    refresh: {
      type: 'ability',
      label: 'Refresh poison',
      apCost: 1,
      target: 'enemy',
      effects: [{ id: 'poison', type: 'apply-status', status: 'poison' }],
    },
  },
  statuses: {
    poison: { type: 'damage', label: '<Poison>', duration: 3, amount: 4 },
    regen: { type: 'regeneration', label: 'Regeneration', duration: 3, amount: 5 },
    focus: {
      type: 'modifier',
      label: 'Focus',
      duration: 2,
      modifiers: { attack: 3, defense: 2, guard: 1 },
    },
    weak: {
      type: 'modifier',
      label: 'Weakness',
      duration: 2,
      modifiers: { attack: -4, defense: -3, guard: -2 },
    },
    stun: { type: 'stun', label: 'Stunned', duration: 1 },
  },
})

const active = (id: string, remaining: number) => ({ id, source: 'player', remaining })

const plan = (moves: string[], actor = 'player') =>
  moves.map((move) => ({
    move,
    target:
      combatMoveTarget(definition.moves[move]!) === 'self'
        ? actor
        : actor === 'player'
          ? 'enemy'
          : 'player',
  }))

const simulate = (
  moves: string[] = [],
  options: Partial<Parameters<typeof resolveCombatRound>[1]> = {},
  encounter = definition,
) =>
  resolveCombatRound(encounter, {
    health: { player: 40, enemy: 100 },
    maximumHealth: { player: 50, enemy: 100 },
    guard: {},
    seed: 1024,
    plan: plan(moves),
    enemies: { enemy: { cursor: 0, moves: [] } },
    escape: false,
    ...options,
  })

const rules = gameRulesSchema.parse({
  state: Object.entries({ hp: 40, max: 50, enemy: 100, power: 2 }).map(([id, value]) => ({
    path: [id],
    value,
  })),
  actions: {},
})

const inventory = inventorySchema.parse({
  'schema-version': '1.0.0',
  owners: {
    player: {
      label: 'Player',
      equipmentSlots: { charm: 'Charm' },
      combatStats: {
        health: field('hp'),
        maximumHealth: field('max'),
        attack: field('power'),
        defense: 1,
      },
    },
  },
  itemTypes: { charm: { label: 'Charm', equipmentSlots: ['charm'], combatBonuses: { attack: 1 } } },
  items: { charm: { itemType: 'charm', placement: { type: 'carried', owner: 'player' } } },
})

const commands = {
  '1': { type: 'queue-move', move: 'poison' },
  '2': { type: 'queue-move', move: 'recover' },
  '3': { type: 'queue-move', move: 'focus' },
  '4': { type: 'queue-move', move: 'stun' },
  '5': { type: 'undo' },
  '6': { type: 'clear' },
  '15': { type: 'end-turn' },
}

const scene = sceneSchema.parse({
  'schema-version': '1.0.0',
  id: 'fight',
  type: 'game',
  title: 'Fight',
  screen: { type: 'grid', grid: { rows: 12, columns: 12 } },
  components: [
    { id: 'combat', type: 'combat', encounter: 'fight', placement: { row: 1, column: 1 } },
    {
      id: 'bar',
      type: 'action-bar',
      placement: { row: 10, column: 1 },
      slots: Object.fromEntries(
        Object.entries(commands).map(([id, command]) => [
          id,
          {
            label: id,
            action: { type: 'combat-action', combat: 'combat', command },
            inputBinding: { context: 'play', input: `slot-${id}` },
          },
        ]),
      ),
    },
  ],
})

const home = sceneSchema.parse({ ...scene, id: 'home', components: [] })

const keys = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': Object.keys(commands).map((id) => `slot-${id}`),
  keyboard: { KeyQ: 'slot-1', KeyW: 'slot-2', KeyE: 'slot-3', KeyR: 'slot-4', KeyB: 'slot-15' },
  contexts: {
    play: Object.fromEntries(Object.keys(commands).map((id) => [`slot-${id}`, `slot-${id}`])),
  },
  'initial-context': 'play',
})

const manifest = gameSchema.parse({
  'schema-version': '1.0.0',
  id: 'abilities',
  title: 'Abilities',
  version: '1',
  scenes: ['home', 'fight'],
  'initial-scene': 'home',
  combat: ['fight'],
  inventory: ['items'],
  rules: ['values'],
  input: 'keys',
})

async function setup(encounter = definition) {
  const linked = combatDefinitionSchema.parse({
    ...encounter,
    player: { ...encounter.player, equipmentOwner: 'player' },
  })

  const data = assembleGameData(
    manifest,
    new Map([
      ['home', home],
      ['fight', scene],
    ]),
    keys,
    undefined,
    new Map(),
    new Map([['items', inventory]]),
    undefined,
    new Map([['values', rules]]),
    new Map([['fight', linked]]),
  )

  let reject = false
  const fallback = vi.fn(() => ({ status: 'applied' as const }))

  const engine = new Engine(
    { load: async () => data },
    { mount: () => () => {} },
    { debug: () => '', info: () => '', warn: () => '', error: () => '' },
    () => new MessageBus<EngineMessages>(),
    {
      clock: { now: () => 0 },
      scheduler: { schedule: () => () => {} },
      createGameLifecycle: (data) =>
        new GameLifecycle(data, {
          createGameState: () => new Map(rules.state.map((entry) => [entry.path[0]!, entry.value])),
          createSceneState: () => undefined,
        }),
      createStateTransactions: (game) => {
        if (!(game.state instanceof Map)) throw new Error('Expected fixture Map')

        const adapter = new MapStateTransactions(
          game.state,
          rules.state.map((entry) => entry.path),
        )

        return { prepare: (writes) => (reject ? undefined : adapter.prepare(writes)) }
      },
      createGameRules: () => ({
        handlers: new Map([['fallback', fallback]]),
        inputBindings: (['pressed', 'released', 'cancelled'] as const).map((phase) => ({
          context: 'play',
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
  const current = () => engine.lifecycle!.activeScene!

  const flush = () => {
    for (let i = 0; i < 8; i++) engine.flushMessages()
  }

  const state = () => {
    const state = game().state

    if (!(state instanceof Map)) throw new Error('Expected fixture Map')

    return state
  }

  const enter = () => engine.lifecycle!.enterScene('fight')
  const snapshot = () => game().combat!.snapshot(current(), 'combat')!

  const command = (
    command: Parameters<NonNullable<ReturnType<typeof game>['combat']>['request']>[2],
  ) => {
    game().combat!.request(current(), 'combat', command)
    flush()
  }

  return {
    engine,
    game,
    current,
    flush,
    state,
    enter,
    snapshot,
    command,
    fallback,
    reject: (value: boolean) => {
      reject = value
    },
  }
}

describe('ability round simulation', () => {
  it('ticks newly applied poison before the enemy moves, bypasses mitigation, and refreshes without stacking', () => {
    const hit = simulate(['poison'], { guard: { enemy: 100 } })
    expect(hit.health.enemy).toBe(96)
    expect(hit.entries.map((e) => e.type)).toEqual(['attack', 'statusApplied', 'periodicDamage'])
    expect(hit.statuses.enemy).toEqual([active('poison', 2)])
    const refresh = simulate(['refresh'], { statuses: hit.statuses })
    expect(refresh.statuses.enemy).toEqual([active('poison', 2)])
    expect(refresh.health.enemy).toBe(96)
    expect(refresh.entries[0]!.type).toBe('statusRefreshed')
  })
  it('preserves full duration on self application and refresh during the affected turn, and expires after future turns', () => {
    const first = simulate(['focus'])
    expect(first.statuses.player).toEqual([active('focus', 2)])
    const next = simulate([], { statuses: first.statuses })
    expect(next.statuses.player).toEqual([active('focus', 1)])
    const refresh = simulate(['focus'], { statuses: next.statuses })
    expect(refresh.statuses.player).toEqual([active('focus', 2)])
    const final = simulate([], { statuses: next.statuses })
    expect(final.statuses.player).toEqual([])
    expect(final.entries).toContainEqual({
      type: 'statusExpired',
      target: 'player',
      status: 'focus',
    })
  })
  it('applies modifiers to later effects and moves, permits negative debuffs, and modifies Guard', () => {
    expect(simulate(['combo', 'attack']).health.enemy).toBe(90)
    expect(simulate(['focus', 'guard']).guard.player).toBe(3)

    const weak = simulate(['weaken'], {
      enemies: { enemy: { cursor: 0, moves: plan(['attack', 'attack'], 'enemy') } },
    })

    expect(weak.health.player).toBe(36)

    const overflow = combatDefinitionSchema.parse({
      ...definition,
      statuses: {
        ...definition.statuses,
        focus: { ...definition.statuses!.focus, modifiers: { attack: Number.MAX_SAFE_INTEGER } },
      },
    })

    expect(() => simulate(['combo'], {}, overflow)).toThrow()
  })
  it('heals only living targets, clamps healing, and applies damage before regeneration', () => {
    expect(simulate(['recover'], { health: { player: 49, enemy: 100 } }).health.player).toBe(50)
    const statuses: CombatStatuses = { player: [active('poison', 1), active('regen', 1)] }
    const dead = simulate(['recover'], { health: { player: 4, enemy: 100 }, statuses })
    expect(dead.outcome).toBe('defeat')
    expect(dead.entries.some((e) => e.type === 'healed' || e.type === 'regenerated')).toBe(false)
    expect(dead.statuses).toEqual({})
    const alive = simulate([], { health: { player: 49, enemy: 100 }, statuses })
    expect(alive.health.player).toBe(50)
    expect(alive.entries.slice(0, 2).map((e) => e.type)).toEqual(['periodicDamage', 'regenerated'])
  })
  it('stuns the upcoming enemy turn, still ticks periodic effects, and does not start skipped cooldowns', () => {
    const result = simulate(['stun'], {
      statuses: { enemy: [active('poison', 2)] },
      enemies: { enemy: { cursor: 0, moves: plan(['stun'], 'enemy') } },
    })

    expect(result.health.player).toBe(40)
    expect(result.entries.some((e) => e.type === 'stunned')).toBe(true)
    expect(result.cooldowns.enemy).toBeUndefined()
    expect(result.cooldowns.player!.stun).toBe(4)
    expect(result.statuses.enemy).toEqual([active('poison', 1)])
  })
  it('cleanses by ID, preserves seeded draw count, and keeps escape ahead of turn-start effects', () => {
    const result = simulate(['cleanse'], { statuses: { player: [active('poison', 3)] } })
    expect(result.statuses.player).toEqual([])
    expect(result.health.player).toBe(36)
    expect(result.entries.some((e) => e.type === 'statusRemoved')).toBe(true)
    expect(simulate(['poison']).seed).toBe(simulate(['attack']).seed)

    const escaped = simulate([], {
      health: { player: 1, enemy: 100 },
      statuses: { player: [active('poison', 3), active('stun', 1)] },
      escape: true,
    })

    expect(escaped).toMatchObject({
      outcome: 'escaped',
      health: { player: 1 },
      seed: 1024,
      statuses: {},
      cooldowns: {},
    })
  })
  it('respects enemy cooldown reservations, stun, and self targets in deterministic rotations', () => {
    const encounter = combatDefinitionSchema.parse({
      ...definition,
      enemies: [
        {
          ...definition.enemies[0],
          moves: ['recover', 'attack'],
          rotation: ['recover', 'attack'],
          ap: 3,
        },
      ],
    })

    const ready = planEnemies(encounter, { player: 40, enemy: 100 }, {})
    expect(ready.enemy!.moves.map((m) => m.move)).toEqual(['recover', 'attack', 'attack'])
    expect(ready.enemy!.moves[0]!.target).toBe('enemy')
    expect(
      planEnemies(
        encounter,
        { player: 40, enemy: 100 },
        {},
        2,
        {},
        { enemy: { recover: 4 } },
      ).enemy!.moves.every((m) => m.move === 'attack'),
    ).toBe(true)
    expect(
      planEnemies(encounter, { player: 40, enemy: 100 }, {}, 1, { enemy: [active('stun', 1)] })
        .enemy!.moves,
    ).toEqual([])
  })
})

describe('ability runtime integration', () => {
  it('finishes poison victories atomically and grants existing rewards exactly once', async () => {
    const encounter = combatDefinitionSchema.parse({
      ...definition,
      rewards: { numeric: [{ id: 'power', label: 'Power', field: field('power'), amount: 3 }] },
    })

    const t = await setup(encounter)
    t.state().set('enemy', 3)
    t.enter()
    t.command({ type: 'queue-move', move: 'refresh' })
    t.command({ type: 'end-turn' })
    expect(t.snapshot()).toMatchObject({ outcome: 'victory', statuses: {}, cooldowns: {} })
    expect(t.snapshot().log.some((entry) => entry.type === 'periodicDamage')).toBe(true)
    expect(t.game().combatRewards!.snapshot(t.current(), 'combat')!.delivered).toBe(true)
    expect(t.state().get('power')).toBe(5)
    t.command({ type: 'end-turn' })
    expect(t.state().get('power')).toBe(5)
    expect(t.game().actions!.progression.turn).toBe(1)
  })
  it('reserves only matching cooldown moves, supports Undo, and accepts rapid distinct input plus End Turn', async () => {
    const t = await setup()
    t.enter()
    t.command({ type: 'queue-move', move: 'poison' })
    expect(t.game().combat!.moveIssue(t.current(), 'combat', 'poison')).toBe('Already queued')
    t.command({ type: 'undo' })
    expect(t.game().combat!.moveIssue(t.current(), 'combat', 'poison')).toBeUndefined()

    for (const key of ['KeyQ', 'KeyW', 'KeyB']) {
      t.engine.input!.pressKey(key)
      t.engine.input!.releaseKey(key)
    }

    t.flush()
    expect(t.snapshot().round).toBe(2)
    expect(t.snapshot().cooldowns.player).toMatchObject({ poison: 3, recover: 4 })
    expect(t.game().combat!.moveIssue(t.current(), 'combat', 'poison')).toContain('1 rounds')
    t.command({ type: 'end-turn' })
    expect(t.game().combat!.moveIssue(t.current(), 'combat', 'poison')).toBeUndefined()
    expect(t.fallback).not.toHaveBeenCalled()
  })
  it('pauses effects and cooldowns, projects temporary stats without changing base fields, and resets on New Game', async () => {
    const t = await setup()
    t.game().inventory!.equip('charm', 'player', 'charm')
    t.enter()
    t.command({ type: 'queue-move', move: 'focus' })
    t.command({ type: 'queue-move', move: 'recover' })
    t.command({ type: 'end-turn' })
    expect(t.game().combatStats!.snapshot('player')!.total.attack).toBe(6)
    expect(t.state().get('power')).toBe(2)
    expect(Object.isFrozen(t.snapshot().statuses.player)).toBe(true)
    const before = t.snapshot()
    t.engine.lifecycle!.enterScene('home')
    t.flush()
    expect(t.game().combatStats!.snapshot('player')!.total.attack).toBe(6)
    t.enter()
    expect(t.snapshot()).toEqual(before)
    t.command({ type: 'escape' })
    t.command({ type: 'end-turn' })
    expect(t.snapshot().statuses).toEqual({})
    expect(t.game().combatStats!.snapshot('player')!.total.attack).toBe(3)
    const old = t.game().combat!
    t.engine.lifecycle!.startGame()
    t.enter()
    expect(t.snapshot().cooldowns).toEqual({})
    expect(old.snapshot(t.current(), 'combat')).toBeUndefined()
  })
  it('rolls back rejected rounds and retains committed effects, cooldowns, and health after observer failures', async () => {
    const t = await setup()
    t.enter()
    t.command({ type: 'queue-move', move: 'poison' })
    const before = t.snapshot()
    t.reject(true)
    t.command({ type: 'end-turn' })
    t.reject(false)
    expect(t.snapshot().health).toEqual(before.health)
    expect(t.snapshot().plan).toEqual(before.plan)
    expect(t.snapshot().statuses).toEqual({})

    const unsubscribe = t.game().bindings!.subscribeChanges(() => {
      throw new Error('observer')
    })

    t.game().combat!.request(t.current(), 'combat', { type: 'end-turn' })

    try {
      t.flush()
    } catch {
      /* Committed observers cannot undo the round. */
    }

    unsubscribe()
    expect(t.snapshot().round).toBe(2)
    expect(t.snapshot().statuses.enemy).toHaveLength(1)
    expect(t.snapshot().cooldowns.player!.poison).toBe(3)
  })
  it('discards old scene requests and consumes held keys across scene transitions', async () => {
    const t = await setup()
    t.enter()
    t.engine.input!.pressKey('KeyQ')
    t.engine.lifecycle!.enterScene('home')
    t.enter()
    t.flush()
    expect(t.snapshot().plan).toEqual([])
    t.engine.input!.releaseKey('KeyQ')
    t.flush()
    expect(t.fallback).not.toHaveBeenCalled()
    t.engine.input!.pressKey('KeyQ')
    t.engine.input!.releaseKey('KeyQ')
    t.flush()
    expect(t.snapshot().plan).toHaveLength(1)
  })
  it('disables player moves while stunned but permits a committed skipped turn and escape', async () => {
    const encounter = combatDefinitionSchema.parse({
      ...definition,
      enemies: [{ ...definition.enemies[0], rotation: ['stun'] }],
    })

    const t = await setup(encounter)
    t.enter()
    t.command({ type: 'end-turn' })
    expect(t.snapshot().statuses.player).toContainEqual(
      expect.objectContaining({ id: 'stun', remaining: 1 }),
    )
    expect(
      t.game().combat!.canCommand(t.current(), 'combat', { type: 'queue-move', move: 'recover' }),
    ).toBe(false)
    expect(t.game().combat!.canCommand(t.current(), 'combat', { type: 'end-turn' })).toBe(true)
    t.engine.input!.pressKey('KeyQ')
    t.command({ type: 'end-turn' })
    t.engine.input!.releaseKey('KeyQ')
    t.flush()
    expect(t.snapshot().statuses.player).toEqual([])
    expect(t.snapshot().log.some((entry) => entry.type === 'stunned')).toBe(true)
    expect(t.fallback).not.toHaveBeenCalled()
    expect(t.snapshot().cooldowns.player).toBeUndefined()
  })
})

describe('ability project contracts', () => {
  it('validates references and bounds, localizes status labels, and preserves extension properties on saves', () => {
    expect(combatDefinitionSchema.safeParse({ ...definition, statuses: {} }).success).toBe(false)
    expect(
      combatDefinitionSchema.safeParse({
        ...definition,
        statuses: {
          ...definition.statuses,
          poison: { ...definition.statuses!.poison, duration: 0 },
        },
      }).success,
    ).toBe(false)

    const translated = localizeCombat(
      combatDefinitionSchema.parse({
        ...definition,
        statuses: {
          ...definition.statuses,
          poison: { ...definition.statuses!.poison, labelKey: 'poison' },
        },
      }),
      { fallback: { poison: 'Poison' }, messages: { poison: 'Vergif' } },
    )

    expect(translated.statuses!.poison!.label).toBe('Vergif')

    const documents = {
      'game.json': manifest,
      'rules/values.json': rules,
      'input/keys.json': keys,
      'inventory/items.json': inventory,
      'scenes/home.json': home,
      'scenes/fight.json': scene,
      'combat/fight.json': {
        ...definition,
        statuses: {
          ...definition.statuses,
          poison: { ...definition.statuses!.poison, extension: 'keep' },
        },
        moves: {
          ...definition.moves,
          poison: {
            ...definition.moves.poison,
            effects: [
              { id: 'hit', type: 'damage', damage: { min: 2, max: 2, extension: 7 } },
              { id: 'poison', type: 'apply-status', status: 'poison', extension: 8 },
            ],
          },
        },
      },
    }

    expect(validateProject(documents)).toEqual([])

    const result = applyCommand(
      { revision: 'r1', documents },
      { type: 'game.upsertCombat', encounter: definition },
    )

    const saved = object(result.project.documents['combat/fight.json'])
    expect(object(object(saved.statuses).poison).extension).toBe('keep')
    expect(object(object(saved.moves).poison).effects).toMatchObject([
      { damage: { extension: 7 } },
      { extension: 8 },
    ])
  })
})
