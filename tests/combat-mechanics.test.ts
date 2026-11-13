import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  localizeCombat,
  savedCombatSchema,
  type CombatDefinition,
  type CombatMechanicsState,
} from '@ancadeba/schemas'
import {
  Engine,
  GameLifecycle,
  MapStateTransactions,
  GameLoader,
  resolveCombatRound,
  initialCombatMechanics,
  combatResourceIssue,
  validateCombatMechanicsState,
  planEnemies,
  type EngineMessages,
  type EngineRuntimeServices,
  type GameSaveStore,
} from '@ancadeba/game-runtime'
import { JsonResourceLoader, MessageBus } from '@ancadeba/utilities'
import { applyCommand, inspectProject, object, validateProject } from '@ancadeba/editor-core'

const root = new URL('../sample-games/combat-mechanics/', import.meta.url)

const read = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, root), 'utf8'))

const encounter = async (id = 'boss') =>
  combatDefinitionSchema.parse(await read(`combat/${id}.json`))

function resolve(
  definition: CombatDefinition,
  moves: string[],
  mechanics?: CombatMechanicsState,
  options: Partial<Parameters<typeof resolveCombatRound>[1]> = {},
) {
  // These unit cases isolate mechanics with intentionally empty enemy turns.
  return resolveCombatRound(
    { ...definition, enemies: definition.enemies.map((enemy) => ({ ...enemy, ai: undefined })) },
    {
      health: { player: 80, eel: 90, guardian: 500 },
      maximumHealth: { player: 80, eel: 90, guardian: 500 },
      guard: {},
      seed: 1024,
      escape: false,
      plan: moves.map((move) => ({
        move,
        target:
          definition.moves[move]?.type === 'ability' && definition.moves[move].target === 'self'
            ? 'player'
            : definition.enemies[0]!.id,
      })),
      enemies: Object.fromEntries(
        definition.enemies.map((enemy) => [enemy.id, { moves: [], cursor: 0 }]),
      ),
      mechanics,
      ...options,
    },
  )
}

class MemorySaves implements GameSaveStore {
  readonly values = new Map<string, string>()
  read(id: string) {
    return this.values.get(id)
  }
  write(id: string, data: string) {
    this.values.set(id, data)
  }
}

async function launch(
  store: GameSaveStore = new MemorySaves(),
  overrides: Record<string, unknown> = {},
  rejectWrites?: () => boolean,
) {
  const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

  const transactions: Pick<
    EngineRuntimeServices,
    'createGameLifecycle' | 'createStateTransactions'
  > = rejectWrites
    ? {
        createGameLifecycle: (data) =>
          new GameLifecycle(data, {
            createGameState: () =>
              new Map(data.rules!.state.map((field) => [field.path[0]!, field.value])),
            createSceneState: () => undefined,
          }),
        createStateTransactions: (game) => {
          if (!(game.state instanceof Map)) throw new Error('Expected Map state')

          const adapter = new MapStateTransactions(
            game.state,
            game.data.rules!.state.map((field) => field.path),
          )

          return {
            prepare: (writes) =>
              rejectWrites() && writes.some((write) => write.value !== write.expected)
                ? undefined
                : adapter.prepare(writes),
          }
        },
      }
    : {}

  const engine = new Engine(
    new GameLoader(
      new JsonResourceLoader(
        {
          readText: (path) =>
            Object.hasOwn(overrides, path)
              ? Promise.resolve(JSON.stringify(overrides[path]))
              : readFile(new URL(path, root), 'utf8'),
          readBytes: async (path) => new Uint8Array(await readFile(new URL(path, root))),
        },
        logger,
      ),
    ),
    { mount: () => () => {} },
    logger,
    () => new MessageBus<EngineMessages>(),
    {
      clock: { now: () => 0 },
      scheduler: { schedule: () => () => {} },
      saveStore: store,
      ...transactions,
    },
  )

  await engine.start()
  onTestFinished(() => engine.stop())

  const flush = () => {
    for (let index = 0; index < 10; index++) engine.flushMessages()
  }

  const enter = (id: string) => {
    if (!engine.lifecycle!.currentGame) engine.lifecycle!.startGame()
    const scene = engine.lifecycle!.enterScene(id)
    flush()

    return scene
  }

  const combat = () => engine.lifecycle!.currentGame!.combat!
  const scene = () => engine.lifecycle!.activeScene!
  const snapshot = () => combat().snapshot(scene(), 'combat')!

  const command = (command: Parameters<ReturnType<typeof combat>['request']>[2]) => {
    combat().request(scene(), 'combat', command)
    flush()
  }

  return { engine, enter, combat, scene, snapshot, command }
}

describe('combat resources, triggers and phases', () => {
  it('fills and resets the boss gauge three times, changes phases and wins while the boss is alive', async () => {
    const boss = await encounter()
    let state = initialCombatMechanics(boss)
    const initial = structuredClone(state)

    for (let cycle = 1; cycle <= 3; cycle++) {
      const partial = resolve(boss, ['channel', 'channel', 'channel'], state)
      const result = resolve(boss, ['channel'], partial.mechanics)
      state = result.mechanics
      expect(state?.resources).toEqual({ seal: 0, breaks: cycle })
      expect(state?.phase).toBe(cycle === 1 ? 'second-seal' : 'third-seal')
      expect(result.outcome).toBe(cycle === 3 ? 'victory' : undefined)
      expect(result.health.guardian).toBe(500)
    }

    expect(initialCombatMechanics(boss)).toEqual(initial)
    expect(initial?.resources.breaks).toBe(0)
    expect(state?.fired).toEqual(['second-seal', 'third-seal', 'victory'])
  })

  it('applies fatigue before turn-start damage and removes it through recovery, with bounded resources', async () => {
    const water = await encounter('water')
    const initial = initialCombatMechanics(water)!
    initial.resources.exhaustion = 55
    initial.resources.stamina = 5
    const result = resolve(water, ['rest'], initial)
    expect(result.health.player).toBe(77)
    expect(result.mechanics?.resources).toEqual({ exhaustion: 35, stamina: 40 })
    expect(result.statuses.player).toEqual([])
    expect(initial.resources).toEqual({ exhaustion: 55, stamina: 5 })
    const capped = resolve(water, ['rest', 'rest', 'rest'], result.mechanics)
    expect(capped.mechanics?.resources).toEqual({ exhaustion: 0, stamina: 100 })
  })

  it('reserves resource costs during planning, skips unaffordable execution, and charges multiple costs before triggers', async () => {
    const water = await encounter('water')
    expect(combatResourceIssue(water.moves.heavy!, { stamina: 30 })).toBeUndefined()
    expect(
      combatResourceIssue(
        water.moves.jab!,
        { stamina: 30 },
        [{ move: 'heavy', target: 'eel' }],
        water.moves,
      ),
    ).toBe('stamina')

    const definition = combatDefinitionSchema.parse({
      ...water,
      mechanics: {
        ...water.mechanics,
        triggers: {
          drain: {
            event: 'turn-start',
            actor: 'player',
            effects: [{ type: 'set-resource', resource: 'stamina', amount: 0 }],
          },
        },
      },
    })

    const result = resolve(definition, ['heavy'])
    expect(result.entries).toContainEqual({
      type: 'resourceUnavailable',
      actor: 'player',
      resource: 'stamina',
    })
    expect(result.health.eel).toBe(90)
    expect(result.mechanics?.resources.stamina).toBe(0)
  })

  it('uses ordered live conditions, once-only triggers, phase entry effects and next-round rotations', async () => {
    const boss = await encounter()
    boss.mechanics!.phases['second-seal']!.onEnter = [
      { type: 'change-resource', resource: 'seal', amount: 10 },
    ]
    const partial = resolve(boss, ['channel', 'channel', 'channel'])
    const result = resolve(boss, ['channel'], partial.mechanics)
    expect(result.mechanics?.resources.seal).toBe(10)
    expect(
      planEnemies(
        boss,
        result.health,
        result.cursors,
        2,
        result.statuses,
        result.cooldowns,
        result.mechanics,
      ).guardian?.moves.map((move) => move.move),
    ).toEqual(['pulse', 'pulse'])
    const next = resolve(boss, [], result.mechanics)
    expect(next.mechanics).toEqual(result.mechanics)
  })

  it('fires start and end events once, filters actions, and isolates encounter state', async () => {
    const boss = await encounter()

    const custom = combatDefinitionSchema.parse({
      ...boss,
      mechanics: {
        ...boss.mechanics,
        triggers: {
          start: {
            event: 'encounter-start',
            once: true,
            effects: [{ type: 'change-resource', resource: 'seal', amount: 1 }],
          },
          action: {
            event: 'action-resolved',
            actor: 'player',
            move: 'guard',
            conditions: [
              { type: 'health', actor: 'player', operator: 'gt', value: 0 },
              { type: 'phase', phase: 'first-seal' },
            ],
            effects: [{ type: 'change-resource', resource: 'seal', amount: 2 }],
          },
          end: {
            event: 'turn-end',
            actor: 'player',
            effects: [{ type: 'change-resource', resource: 'seal', amount: 3 }],
          },
        },
      },
    })

    const first = resolve(custom, ['guard'])
    expect(first.mechanics?.resources.seal).toBe(6)
    const next = resolve(custom, ['channel'], first.mechanics)
    expect(next.mechanics?.resources.seal).toBe(34)
    expect(initialCombatMechanics(custom)?.resources.seal).toBe(0)
  })

  it('gives escape and player death priority and never mutates state on overflow or trigger loops', async () => {
    const boss = await encounter()
    const initial = initialCombatMechanics(boss)!
    expect(resolve(boss, ['channel'], initial, { escape: true }).mechanics).toEqual(initial)
    expect(
      resolve(boss, ['channel'], initial, { health: { player: 0, guardian: 500 } }).outcome,
    ).toBe('defeat')

    const loop = combatDefinitionSchema.parse({
      ...boss,
      mechanics: {
        ...boss.mechanics,
        triggers: {
          start: { event: 'round-start', effects: [{ type: 'set-phase', phase: 'second-seal' }] },
          a: {
            event: 'phase-enter',
            phase: 'second-seal',
            effects: [{ type: 'set-phase', phase: 'third-seal' }],
          },
          b: {
            event: 'phase-enter',
            phase: 'third-seal',
            effects: [{ type: 'set-phase', phase: 'second-seal' }],
          },
        },
      },
    })

    expect(() => resolve(loop, [], initial)).toThrow('operation limit')
    expect(initial).toEqual(initialCombatMechanics(boss))

    const overflow = combatDefinitionSchema.parse({
      ...boss,
      mechanics: {
        ...boss.mechanics,
        resources: {
          ...boss.mechanics!.resources,
          seal: {
            label: 'Seal',
            initial: Number.MAX_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    })

    expect(() => resolve(overflow, ['channel'])).toThrow('overflow')
  })

  it('validates references and bounds, localizes resource/phase labels, and rejects forged saved state', async () => {
    const boss = await encounter()
    expect(
      combatDefinitionSchema.safeParse({
        ...boss,
        mechanics: { ...boss.mechanics, initialPhase: 'missing' },
      }).success,
    ).toBe(false)
    expect(
      combatDefinitionSchema.safeParse({
        ...boss,
        moves: { ...boss.moves, channel: { ...boss.moves.channel, resourceCosts: { missing: 1 } } },
      }).success,
    ).toBe(false)
    expect(
      combatDefinitionSchema.safeParse({
        ...boss,
        mechanics: { ...boss.mechanics, resources: { seal: { initial: 101, maximum: 100 } } },
      }).success,
    ).toBe(false)
    expect(
      combatDefinitionSchema.safeParse({
        ...boss,
        mechanics: {
          ...boss.mechanics,
          phases: {
            ...boss.mechanics!.phases,
            'first-seal': { enemyRotations: { player: ['guard'] } },
          },
        },
      }).success,
    ).toBe(false)
    const state = initialCombatMechanics(boss)!
    expect(() =>
      validateCombatMechanicsState(boss, { ...state, resources: { seal: 101, breaks: 0 } }),
    ).toThrow()
    expect(() => validateCombatMechanicsState(boss, { ...state, phase: 'missing' })).toThrow()
    expect(() => validateCombatMechanicsState(boss, { ...state, fired: ['missing'] })).toThrow()
    boss.mechanics!.resources.seal!.labelKey = 'seal'
    boss.mechanics!.phases['first-seal']!.labelKey = 'phase'

    const localized = localizeCombat(boss, {
      fallback: { seal: 'Seal', phase: 'Phase' },
      messages: { seal: 'Zegel', phase: 'Fase' },
    })

    expect(localized.mechanics?.resources.seal?.label).toBe('Zegel')
    expect(localized.mechanics?.phases['first-seal']?.label).toBe('Fase')
    expect(boss.mechanics!.resources.seal!.label).toBe('Seal energy')
  })
})

describe('combat mechanics runtime and authoring integration', () => {
  it('restores control restrictions and rejection logs, then permits utility cleansing', async () => {
    const store = new MemorySaves()
    const water = object(await read('combat/water.json'))
    const mechanics = object(water.mechanics)

    const overrides = {
      'combat/water.json': {
        ...water,
        mechanics: {
          ...mechanics,
          triggers: {
            ...object(mechanics.triggers),
            hush: {
              event: 'before-action',
              move: 'arc-bolt',
              once: true,
              effects: [{ type: 'apply-status', actor: 'player', status: 'silenced' }],
            },
          },
        },
      },
    }

    const app = await launch(store, overrides)
    app.enter('water-controls')
    app.command({ type: 'queue-move', move: 'arc-bolt' })
    app.command({ type: 'end-turn' })
    expect(app.snapshot().log).toContainEqual({
      type: 'moveRestricted',
      actor: 'player',
      move: 'arc-bolt',
      category: 'spell',
      status: 'silenced',
    })
    expect(app.combat().text(app.scene(), 'combat')).toContain('Arc bolt is blocked (spell)')
    expect(app.engine.saves!.save()).toBe(true)
    app.engine.stop()
    const restored = await launch(store, overrides)
    expect(restored.engine.saves!.load()).toBe(true)
    expect(restored.combat().moveIssue(restored.scene(), 'combat', 'arc-bolt')).toContain(
      'blocked (spell)',
    )
    expect(restored.combat().moveIssue(restored.scene(), 'combat', 'shake-off')).toBeUndefined()
    expect(restored.combat().text(restored.scene(), 'combat')).not.toContain('{category}')
    restored.command({ type: 'queue-move', move: 'shake-off' })
    restored.command({ type: 'end-turn' })
    expect(restored.combat().moveIssue(restored.scene(), 'combat', 'arc-bolt')).toBeUndefined()
    restored.enter('water')
    expect(restored.snapshot().round).toBe(3)
  })

  it('logs typed defenses and restores the underwater guardian’s temporary phase ward', async () => {
    const store = new MemorySaves()
    const app = await launch(store)
    app.enter('underwater-boss')

    for (const move of ['tidal-bolt', 'arc-bolt', 'venom-dart'])
      app.command({ type: 'queue-move', move })
    app.command({ type: 'end-turn' })
    expect(app.snapshot().health.guardian).toBe(482)
    const text = app.combat().text(app.scene(), 'combat')
    expect(text).toContain('18 lightning damage')
    expect(text).toContain('Immune to water')
    expect(text).toContain('Immune to poison')
    expect(text).not.toContain('{damageType}')
    // Start a fresh encounter state to reach phase two with its inherited objective intact.
    app.engine.stop()
    const boss = object(await read('combat/underwater-boss.json'))
    const overrides = object(boss.mechanicsOverrides)

    const phaseApp = await launch(store, {
      'combat/underwater-boss.json': {
        ...boss,
        mechanicsOverrides: {
          ...overrides,
          resources: { ...object(overrides.resources), seal: { initial: 75 } },
        },
      },
    })

    phaseApp.enter('underwater-boss')
    phaseApp.command({ type: 'queue-move', move: 'channel' })
    phaseApp.command({ type: 'queue-move', move: 'arc-bolt' })
    phaseApp.command({ type: 'end-turn' })
    expect(phaseApp.snapshot()).toMatchObject({
      bossPhase: 'second-seal',
      health: { guardian: 488 },
      resources: { seal: 12 },
      statuses: { guardian: [{ id: 'tidal-shell', intensity: 2, remaining: 1 }] },
    })
    expect(phaseApp.snapshot().log).toContainEqual(
      expect.objectContaining({ reactive: true, actor: 'guardian', target: 'player', damage: 3 }),
    )
    expect(phaseApp.engine.saves!.save()).toBe(true)
    phaseApp.engine.stop()

    const restored = await launch(store, {
      'combat/underwater-boss.json': {
        ...boss,
        mechanicsOverrides: {
          ...overrides,
          resources: { ...object(overrides.resources), seal: { initial: 75 } },
        },
      },
    })

    expect(restored.engine.saves!.load()).toBe(true)
    expect(restored.snapshot()).toMatchObject({
      bossPhase: 'second-seal',
      statuses: { guardian: [{ id: 'tidal-shell', intensity: 2, remaining: 1 }] },
    })
    expect(restored.combat().text(restored.scene(), 'combat')).toContain('12 lightning damage')
    expect(restored.combat().text(restored.scene(), 'combat')).toContain('Reaction')
  })

  it('wins the live underwater fight by charging three seals with actual lightning damage', async () => {
    const app = await launch()
    app.enter('underwater-boss')

    for (let round = 0; round < 10; round++) {
      app.command({ type: 'queue-move', move: 'rest' })
      app.command({ type: 'queue-move', move: 'arc-bolt' })
      app.command({ type: 'queue-move', move: 'arc-bolt' })
      app.command({ type: 'end-turn' })
    }

    expect(app.snapshot()).toMatchObject({ outcome: 'victory', resources: { seal: 0, breaks: 3 } })
    expect(app.snapshot().health.guardian).toBeGreaterThan(0)
    expect(
      app
        .snapshot()
        .log.some((entry) => entry.type === 'attack' && entry.damageType === 'lightning'),
    ).toBe(true)
  })

  it('uses dynamic costs in live snapshots and restores percentage statuses and scaled healing through saves', async () => {
    const store = new MemorySaves()
    const rules = object(await read('rules/state.json'))
    const state = Array.isArray(rules.state) ? rules.state.map(object) : []
    state.find((field) => Array.isArray(field.path) && field.path[0] === 'player-health')!.value =
      40
    const app = await launch(store, { 'rules/state.json': { ...rules, state } })
    app.enter('water')
    app.command({ type: 'queue-move', move: 'focus-current' })
    app.command({ type: 'queue-move', move: 'flow-strike' })
    app.command({ type: 'end-turn' })
    expect(app.snapshot()).toMatchObject({
      resources: { exhaustion: 20, stamina: 100 },
      moveCosts: { player: { 'flow-strike': 1 } },
      statuses: { player: [{ id: 'flow', intensity: 2 }] },
    })
    expect(app.snapshot().health.eel).toBeGreaterThanOrEqual(68)
    expect(app.snapshot().health.eel).toBeLessThanOrEqual(71)
    app.command({ type: 'queue-move', move: 'reviving-breath' })
    expect(app.engine.saves!.save()).toBe(true)
    app.engine.stop()
    const restored = await launch(store, { 'rules/state.json': { ...rules, state } })
    expect(restored.engine.saves!.load()).toBe(true)
    expect(restored.snapshot()).toMatchObject({
      plan: [{ move: 'reviving-breath', target: 'player' }],
      moveCosts: { player: { 'flow-strike': 1 } },
    })
    restored.command({ type: 'end-turn' })
    expect(restored.snapshot().log).toContainEqual(
      expect.objectContaining({ type: 'healed', amount: 18 }),
    )
  })

  it('resolves, rolls back and restores an underwater boss with composed exhaustion and seal mechanics', async () => {
    const store = new MemorySaves()
    let reject = false
    const app = await launch(store, {}, () => reject)
    app.enter('underwater-boss')

    for (let index = 0; index < 3; index++) app.command({ type: 'queue-move', move: 'channel' })
    app.command({ type: 'end-turn' })
    expect(app.snapshot()).toMatchObject({
      resources: { exhaustion: 50, seal: 75, breaks: 0 },
      bossPhase: 'first-seal',
      round: 2,
    })

    for (const move of ['rest', 'channel', 'channel']) app.command({ type: 'queue-move', move })
    const before = app.snapshot()
    reject = true
    app.command({ type: 'end-turn' })
    expect(app.snapshot()).toMatchObject({
      resources: before.resources,
      health: before.health,
      statuses: before.statuses,
      plan: before.plan,
      round: before.round,
      bossPhase: before.bossPhase,
    })
    reject = false
    app.command({ type: 'end-turn' })
    expect(app.snapshot()).toMatchObject({
      resources: { exhaustion: 55, seal: 25, breaks: 1 },
      bossPhase: 'second-seal',
      round: 3,
    })
    // The rejecting custom host has no save adapter; exercise persistence through the standard host.
    app.engine.stop()
    const saving = await launch(store)
    saving.enter('underwater-boss')

    for (const plan of [
      ['channel', 'channel', 'channel'],
      ['rest', 'channel', 'channel'],
    ]) {
      for (const move of plan) saving.command({ type: 'queue-move', move })
      saving.command({ type: 'end-turn' })
    }

    saving.command({ type: 'queue-move', move: 'rest' })
    const saved = saving.snapshot()
    expect(saving.engine.saves!.save()).toBe(true)
    saving.engine.stop()
    const restored = await launch(store)
    expect(restored.engine.saves!.load()).toBe(true)
    expect(restored.snapshot()).toMatchObject({
      resources: saved.resources,
      health: saved.health,
      statuses: saved.statuses,
      plan: saved.plan,
      round: saved.round,
      bossPhase: saved.bossPhase,
    })
  })

  it('rolls back resources, phases and trigger history when the health transaction rejects a valid candidate', async () => {
    const boss = await encounter()
    boss.mechanics!.resources.seal!.initial = 75
    let reject = true
    const app = await launch(new MemorySaves(), { 'combat/boss.json': boss }, () => reject)
    app.enter('boss')
    app.command({ type: 'queue-move', move: 'channel' })
    const before = app.snapshot()
    const progression = app.engine.lifecycle!.currentGame!.actions!.progression

    app.command({ type: 'end-turn' })
    expect(app.snapshot()).toMatchObject({
      resources: before.resources,
      bossPhase: before.bossPhase,
      health: before.health,
      plan: before.plan,
      round: before.round,
      enemyPlans: before.enemyPlans,
      cooldowns: before.cooldowns,
      statuses: before.statuses,
      log: [],
    })
    expect(app.engine.lifecycle!.currentGame!.actions!.progression).toEqual(progression)
    reject = false
    app.command({ type: 'end-turn' })
    expect(app.snapshot()).toMatchObject({
      resources: { seal: 0, breaks: 1 },
      bossPhase: 'second-seal',
      plan: [],
      round: 2,
    })
  })

  it('restores resources, phases, plans and once-only triggers and delivers final rewards exactly once', async () => {
    const store = new MemorySaves()
    const first = await launch(store)
    first.enter('boss')
    const channel = { type: 'queue-move', move: 'channel' } as const
    const end = { type: 'end-turn' } as const

    for (let index = 0; index < 4; index++) {
      first.command(channel)
      first.command(end)
    }

    expect(first.snapshot().bossPhase).toBe('second-seal')
    first.command(channel)
    expect(first.engine.saves!.save()).toBe(true)
    first.engine.stop()
    const second = await launch(store)
    expect(second.engine.saves!.load()).toBe(true)
    expect(second.snapshot()).toMatchObject({
      bossPhase: 'second-seal',
      resources: { seal: 0, breaks: 1 },
      plan: [{ move: 'channel', target: 'player' }],
    })
    second.command(end)

    for (let index = 0; index < 7; index++) {
      second.command(channel)
      second.command(end)
    }

    expect(second.snapshot().outcome).toBe('victory')
    expect(second.snapshot().resources).toEqual({ seal: 0, breaks: 3 })
    expect(second.snapshot().health.guardian).toBe(500)
    expect(
      second.engine.lifecycle!.currentGame!.bindings!.read({
        source: 'game.state',
        path: ['seals-broken'],
      }),
    ).toMatchObject({ value: 3 })
    second.enter('harbour')
    second.enter('boss')
    second.command(end)
    expect(second.snapshot().resources.breaks).toBe(3)
    expect(
      second.engine.lifecycle!.currentGame!.bindings!.read({
        source: 'game.state',
        path: ['seals-broken'],
      }),
    ).toMatchObject({ value: 3 })
    second.engine.lifecycle!.startGame()
    second.enter('boss')
    expect(second.snapshot().resources).toEqual({ seal: 0, breaks: 0 })
  })

  it('restores conditional previews and repeats live enemy decisions deterministically after loading', async () => {
    const store = new MemorySaves()
    const first = await launch(store)
    first.enter('water')

    for (let count = 0; count < 3; count++)
      first.command({ type: 'queue-move', move: 'steady-breath' })
    const planning = first.snapshot()
    expect(planning.enemyPlans.eel?.startCursor).toBe(0)
    expect(first.engine.saves!.save()).toBe(true)
    first.command({ type: 'end-turn' })
    const result = first.snapshot()
    expect(result.log).toContainEqual({
      type: 'statusReduced',
      actor: 'eel',
      target: 'player',
      status: 'rhythm',
      stacks: 2,
    })
    const second = await launch(store)
    expect(second.engine.saves!.load()).toBe(true)
    expect(second.snapshot().enemyPlans).toEqual(planning.enemyPlans)
    second.command({ type: 'end-turn' })
    expect(second.snapshot().health).toEqual(result.health)
    expect(second.snapshot().log).toEqual(result.log)
    expect(second.snapshot().enemyPlans).toEqual(result.enemyPlans)
    expect(second.snapshot().cooldowns).toEqual(result.cooldowns)
    expect(second.snapshot().statuses).toEqual(result.statuses)
  })

  it('reserves costs, releases them on Undo, pauses encounters and rolls back a rejected trigger cascade', async () => {
    const water = await encounter('water')
    water.mechanics!.resources.stamina!.initial = 30
    const app = await launch(new MemorySaves(), { 'combat/water.json': water })
    app.enter('water')
    app.command({ type: 'queue-move', move: 'heavy' })
    expect(
      app.combat().canCommand(app.scene(), 'combat', { type: 'queue-move', move: 'jab' }),
    ).toBe(false)
    expect(app.combat().moveIssue(app.scene(), 'combat', 'jab')).toContain('Stamina')
    app.command({ type: 'undo' })
    expect(
      app.combat().canCommand(app.scene(), 'combat', { type: 'queue-move', move: 'jab' }),
    ).toBe(true)
    app.command({ type: 'queue-move', move: 'heavy' })
    app.enter('harbour')
    app.enter('water')
    expect(app.snapshot().plan).toHaveLength(1)
    app.command({ type: 'end-turn' })
    expect(app.snapshot().resources).toEqual({ exhaustion: 40, stamina: 10 })
    expect(Object.isFrozen(app.snapshot().resources)).toBe(true)

    const boss = await encounter()
    boss.mechanics!.triggers.loop = {
      event: 'resource-changed',
      resource: 'seal',
      conditions: [],
      once: false,
      effects: [
        { type: 'set-resource', resource: 'seal', amount: 1 },
        { type: 'set-resource', resource: 'seal', amount: 2 },
      ],
    }
    const broken = await launch(new MemorySaves(), { 'combat/boss.json': boss })
    broken.enter('boss')
    broken.command({ type: 'queue-move', move: 'channel' })
    const before = broken.snapshot()
    broken.command({ type: 'end-turn' })
    expect(broken.snapshot()).toMatchObject({
      resources: before.resources,
      health: before.health,
      round: before.round,
      plan: before.plan,
      bossPhase: before.bossPhase,
    })
    expect(broken.snapshot().issue).toBeTruthy()
  })

  it('validates the complete sample and preserves nested extensions through editor saves and removal', async () => {
    const documents: Record<string, unknown> = {}

    for (const directory of ['', 'scenes/', 'rules/', 'input/', 'combat/', 'combat-libraries/']) {
      for (const entry of await readdir(new URL(directory || '.', root), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json'))
          documents[directory + entry.name] = await read(directory + entry.name)
      }
    }

    const project = { revision: 'one', documents }
    expect(validateProject(documents)).toEqual([])
    const boss = object(documents['combat/boss.json'])
    const mechanics = object(boss.mechanics)
    const resources = object(mechanics.resources)
    object(resources.seal).extension = 'keep-resource'
    object(mechanics.phases)['first-seal'] = {
      ...object(object(mechanics.phases)['first-seal']),
      extension: 'keep-phase',
    }
    object(object(mechanics.triggers)['seal-filled']).extension = 'keep-trigger'
    mechanics.extension = 'keep-mechanics'
    const view = inspectProject(project)

    const saved = applyCommand(project, {
      type: 'game.upsertCombat',
      encounter: view.combatSources!.boss!,
    })

    const result = object(object(saved.project.documents['combat/boss.json']).mechanics)
    expect(result.extension).toBe('keep-mechanics')
    expect(object(object(result.resources).seal).extension).toBe('keep-resource')
    expect(object(object(result.phases)['first-seal']).extension).toBe('keep-phase')
    expect(object(object(result.triggers)['seal-filled']).extension).toBe('keep-trigger')
    expect(() =>
      applyCommand(project, {
        type: 'game.upsertCombat',
        encounter: { ...view.combatSources!.boss!, mechanics: undefined },
      }),
    ).toThrow()

    const legacy = savedCombatSchema.parse({
      round: 1,
      seed: 1,
      started: false,
      guard: {},
      plan: [],
      enemies: {},
      statuses: {},
      cooldowns: {},
      escape: false,
      log: [],
    })

    expect(legacy.mechanics).toBeUndefined()
  })
})
