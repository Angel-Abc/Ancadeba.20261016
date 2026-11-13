import { readFile } from 'node:fs/promises'
import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatStatusSchema,
  combatLibrarySchema,
  savedCombatSchema,
  type CombatDefinition,
} from '@ancadeba/schemas'
import {
  applyCombatStatus,
  removeCombatStatusStacks,
  combatStatusAmount,
  statusContributions,
  combatActorEconomy,
  combatActionCost,
  combatEconomySnapshot,
  resolveCombatRound,
  planEnemies,
  Engine,
  GameLoader,
  type EngineMessages,
  type GameSaveStore,
  type CombatStatuses,
} from '@ancadeba/game-runtime'
import { JsonResourceLoader, MessageBus } from '@ancadeba/utilities'

function definition() {
  return combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'strength',
    label: 'Strength',
    seed: 1024,
    player: {
      id: 'player',
      label: 'Player',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 50,
      ap: 3,
      moves: ['hit', 'focus', 'cleanse', 'fatigue'],
    },
    enemies: [
      {
        id: 'enemy',
        label: 'Enemy',
        health: { source: 'game.state', path: ['enemy'] },
        maximumHealth: 50,
        ap: 3,
        moves: ['hit'],
        rotation: ['hit'],
      },
    ],
    moves: {
      hit: { type: 'attack', label: 'Hit', apCost: 1, cooldown: 0, damage: { min: 2, max: 2 } },
      focus: {
        type: 'ability',
        label: 'Focus',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'focus', type: 'apply-status', status: 'focus' }],
      },
      fatigue: {
        type: 'ability',
        label: 'Fatigue',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'fatigue', type: 'apply-status', status: 'fatigue' }],
      },
      cleanse: {
        type: 'ability',
        label: 'Cleanse',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'cleanse', type: 'remove-status', status: 'fatigue' }],
      },
    },
    statuses: {
      focus: {
        type: 'modifier',
        label: 'Focus',
        duration: 3,
        stacking: { maximum: 3, duration: 'preserve' },
        intensity: { initial: 1, maximum: 3, reapply: 'replace' },
        modifiers: { attack: 2 },
      },
      fatigue: {
        type: 'modifier',
        label: 'Fatigue',
        duration: 2,
        modifiers: { ap: -1, apCost: 1 },
      },
    },
  })
}

function simulate(
  encounter: CombatDefinition,
  moves: string[],
  statuses: CombatStatuses = {},
  options: Partial<Parameters<typeof resolveCombatRound>[1]> = {},
) {
  return resolveCombatRound(encounter, {
    health: { player: 40, enemy: 50 },
    maximumHealth: { player: 50, enemy: 50 },
    guard: {},
    seed: 1024,
    plan: moves.map((move) => ({
      move,
      target: encounter.moves[move]!.type === 'attack' ? 'enemy' : 'player',
    })),
    enemies: { enemy: { moves: [], cursor: 0 } },
    escape: false,
    statuses,
    ...options,
  })
}

describe('stacking and intensity', () => {
  it('caps stacks, scales modifiers by stacks and intensity, and preserves input objects', () => {
    const status = definition().statuses!.focus!

    const first = applyCombatStatus(status, 'focus', 'player', undefined, {
      stacks: 2,
      intensity: 2,
    })

    expect(first.active).toEqual({
      id: 'focus',
      source: 'player',
      remaining: 3,
      stacks: 2,
      intensity: 2,
    })

    const next = applyCombatStatus(
      status,
      'focus',
      'other',
      { ...first.active, remaining: 1 },
      { stacks: 2, intensity: 3 },
    )

    expect(next.active).toEqual({
      id: 'focus',
      source: 'other',
      remaining: 1,
      stacks: 3,
      intensity: 3,
    })
    expect(next.durationReset).toBe(false)
    expect(statusContributions(definition(), [next.active])[0]?.modifiers.attack).toBe(18)
    expect(first.active.stacks).toBe(2)
    expect(applyCombatStatus(status, 'focus', 'other', next.active, { intensity: 3 }).changed).toBe(
      false,
    )
  })

  it.each(['replace', 'maximum', 'add'] as const)(
    'uses %s intensity on reapplication and respects its cap',
    (reapply) => {
      const status = combatStatusSchema.parse({
        type: 'damage',
        label: 'Poison',
        amount: 2,
        duration: 3,
        intensity: { initial: 2, maximum: 3, reapply },
      })

      const first = applyCombatStatus(status, 'poison', 'player', undefined)
      const next = applyCombatStatus(status, 'poison', 'player', first.active, { intensity: 1 })
      expect(next.active.intensity).toBe(reapply === 'replace' ? 1 : reapply === 'maximum' ? 2 : 3)
      expect(
        applyCombatStatus(status, 'poison', 'player', next.active, { intensity: 3 }).active
          .intensity,
      ).toBe(3)
    },
  )

  it('refreshes duration only under the configured policy and partial cleansing does not extend it', () => {
    const encounter = definition()
    const first = simulate(encounter, ['focus', 'focus'])
    expect(first.statuses.player).toMatchObject([{ stacks: 2, intensity: 1, remaining: 3 }])
    const second = simulate(encounter, ['focus'], first.statuses)
    expect(second.statuses.player).toMatchObject([{ stacks: 3, remaining: 2 }])
    encounter.moves.cleanse = {
      type: 'ability',
      label: 'Remove one',
      description: '',
      apCost: 1,
      target: 'self',
      effects: [{ id: 'remove', type: 'remove-status', status: 'focus', stacks: 1 }],
    }
    const third = simulate(encounter, ['cleanse'], second.statuses)
    expect(third.statuses.player).toMatchObject([{ stacks: 2, remaining: 1 }])
    expect(third.entries).toContainEqual({
      type: 'statusReduced',
      actor: 'player',
      target: 'player',
      status: 'focus',
      stacks: 2,
      intensity: 1,
    })
    expect(simulate(encounter, [], third.statuses).statuses.player).toEqual([])

    const refresh = combatStatusSchema.parse({
      ...encounter.statuses!.focus,
      stacking: { maximum: 3, duration: 'refresh' },
    })

    expect(
      applyCombatStatus(refresh, 'focus', 'player', third.statuses.player![0]).active.remaining,
    ).toBe(3)
    expect(removeCombatStatusStacks(first.statuses.player![0]!)).toBeUndefined()
  })

  it('runs composite damage, regeneration, modifiers and stun with scaled strength', () => {
    const encounter = definition()
    encounter.statuses!.mixed = combatStatusSchema.parse({
      type: 'composite',
      label: 'Mixed',
      duration: 2,
      damage: 2,
      regeneration: 1,
      stun: true,
      modifiers: { attack: 2, ap: -1 },
      stacking: { maximum: 3 },
      intensity: { maximum: 3 },
    })
    const active = { id: 'mixed', source: 'enemy', remaining: 2, stacks: 2, intensity: 2 }

    const result = simulate(
      encounter,
      ['hit'],
      { player: [active] },
      { health: { player: 20, enemy: 50 } },
    )

    expect(result.health).toEqual({ player: 16, enemy: 50 })
    expect(result.entries.map((entry) => entry.type)).toEqual([
      'periodicDamage',
      'regenerated',
      'stunned',
    ])
    expect(result.entries[0]?.amount).toBe(8)
    expect(result.entries[1]?.amount).toBe(4)
    expect(result.statuses.player?.[0]?.remaining).toBe(1)
  })

  it('retains capped preserve-duration consumables and lets the unchanged status expire normally', () => {
    const encounter = definition()
    encounter.moves.focus = { ...encounter.moves.focus!, cooldown: 2 }

    const result = simulate(
      encounter,
      [],
      { player: [{ id: 'focus', source: 'player', remaining: 2, stacks: 3, intensity: 1 }] },
      {
        plan: [
          { move: 'focus', target: 'player', item: 'focus-drink', consume: true },
          { move: 'hit', target: 'enemy' },
        ],
      },
    )

    expect(result.usedItems).toEqual([])
    expect(result.cooldowns.player?.focus).toBeUndefined()
    expect(result.statuses.player?.[0]?.remaining).toBe(1)
    expect(result.entries[0]?.type).toBe('itemSkipped')
    expect(result.health.enemy).toBe(42)
  })

  it('rejects unsupported strength, malformed composite statuses and overflow without changing candidate inputs', () => {
    const encounter = definition()
    expect(
      combatStatusSchema.safeParse({ type: 'composite', label: 'Empty', duration: 2 }).success,
    ).toBe(false)
    expect(
      combatStatusSchema.safeParse({
        type: 'stun',
        label: 'Stun',
        duration: 2,
        intensity: { initial: 3, maximum: 2 },
      }).success,
    ).toBe(false)
    const invalid = structuredClone(encounter)
    invalid.moves.focus = {
      ...invalid.moves.focus!,
      type: 'ability',
      target: 'self',
      effects: [{ id: 'bad', type: 'apply-status', status: 'focus', stacks: 4 }],
    }
    expect(combatDefinitionSchema.safeParse(invalid).success).toBe(false)
    invalid.moves.focus = {
      ...invalid.moves.focus,
      effects: [{ id: 'bad-intensity', type: 'apply-status', status: 'focus', intensity: 4 }],
    }
    expect(combatDefinitionSchema.safeParse(invalid).success).toBe(false)
    expect(
      combatDefinitionSchema.safeParse({
        ...encounter,
        mechanics: {
          triggers: {
            bad: {
              event: 'round-end',
              effects: [{ type: 'apply-status', actor: 'player', status: 'focus', intensity: 4 }],
            },
          },
        },
      }).success,
    ).toBe(false)
    expect(
      combatLibrarySchema.safeParse({
        'schema-version': '1.0.0',
        id: 'bad',
        moves: { bad: invalid.moves.focus },
        statuses: encounter.statuses,
      }).success,
    ).toBe(false)
    encounter.statuses!.focus = combatStatusSchema.parse({
      ...encounter.statuses!.focus,
      modifiers: { ap: Number.MAX_SAFE_INTEGER - 3 },
    })

    const statuses = {
      player: [{ id: 'focus', source: 'player', remaining: 3, stacks: 1, intensity: 1 }],
    }

    const before = structuredClone(statuses)
    expect(() => simulate(encounter, ['focus'], statuses)).toThrow('overflow')
    expect(statuses).toEqual(before)
    expect(() =>
      combatStatusAmount(Number.MAX_SAFE_INTEGER, { ...statuses.player[0]!, stacks: 2 }),
    ).toThrow('overflow')
  })
})

describe('status AP and action-cost modifiers', () => {
  it('uses the same effective budget and costs for planning and enemy rotations, with safe floors and caps', () => {
    const encounter = definition()
    const statuses = { enemy: [{ id: 'fatigue', source: 'player', remaining: 2 }] }
    const snapshot = combatEconomySnapshot(encounter, statuses)
    expect(snapshot.ap.enemy).toBe(2)
    expect(snapshot.moveCosts.enemy!.hit).toBe(2)
    expect(
      planEnemies(encounter, { player: 40, enemy: 50 }, {}, 1, statuses).enemy!.moves,
    ).toHaveLength(1)
    encounter.statuses!.focus = combatStatusSchema.parse({
      ...encounter.statuses!.focus,
      modifiers: { ap: 200, apCost: -100 },
    })

    const economy = combatActorEconomy(encounter, encounter.player, [
      { id: 'focus', source: 'player', remaining: 2 },
    ])

    expect(economy.ap).toBe(100)
    expect(combatActionCost(encounter.moves.hit!, economy)).toBe(1)
    expect(Object.isFrozen(snapshot.moveCosts.enemy)).toBe(true)
  })

  it('skips newly unaffordable queued moves without RNG draws, resource costs, cooldowns or item use', () => {
    const encounter = combatDefinitionSchema.parse({
      ...definition(),
      mechanics: { resources: { energy: { initial: 10, maximum: 10 } } },
    })

    encounter.moves.hit = { ...encounter.moves.hit!, resourceCosts: { energy: 2 }, cooldown: 2 }

    const result = simulate(
      encounter,
      ['fatigue', 'hit'],
      {},
      {
        plan: [
          { move: 'fatigue', target: 'player' },
          { move: 'hit', target: 'enemy', item: 'potion', itemType: 'potion', consume: true },
        ],
      },
    )

    expect(result.health.enemy).toBe(50)
    expect(result.seed).toBe(1024)
    expect(result.usedItems).toEqual([])
    expect(result.mechanics?.resources.energy).toBe(10)
    expect(result.cooldowns.player?.hit).toBeUndefined()
    expect(result.entries.at(-1)).toEqual({
      type: 'apUnavailable',
      actor: 'player',
      move: 'hit',
      cost: 2,
      remaining: 1,
    })
  })

  it('allows a turn-start penalty to be cleansed before later queued actions and keeps zero-AP turns usable', () => {
    const encounter = combatDefinitionSchema.parse({
      ...definition(),
      mechanics: {
        triggers: {
          fatigue: {
            event: 'round-start',
            effects: [{ type: 'apply-status', actor: 'player', status: 'fatigue' }],
          },
        },
      },
    })

    const result = simulate(encounter, ['cleanse', 'hit'])
    expect(result.health.enemy).toBe(48)
    expect(result.statuses.player).toEqual([])
    encounter.statuses!.fatigue = combatStatusSchema.parse({
      ...encounter.statuses!.fatigue,
      modifiers: { ap: -100 },
    })
    const blocked = simulate(encounter, ['hit'])
    expect(blocked.entries).toContainEqual({
      type: 'apUnavailable',
      actor: 'player',
      move: 'hit',
      cost: 1,
      remaining: 0,
    })
    expect(blocked.statuses.player?.[0]?.remaining).toBe(1)
  })
})

class MemorySaves implements GameSaveStore {
  readonly values = new Map<string, string>()
  read(id: string) {
    return this.values.get(id)
  }
  write(id: string, data: string) {
    this.values.set(id, data)
  }
}

async function launch(store = new MemorySaves(), overrides: Record<string, unknown> = {}) {
  const root = new URL('../sample-games/combat-mechanics/', import.meta.url)
  const logger = { debug: () => '', info: () => '', warn: () => '', error: () => '' }

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
    { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} }, saveStore: store },
  )

  await engine.start()
  onTestFinished(() => engine.stop())

  const enter = (id: string) => {
    if (!engine.lifecycle!.currentGame) engine.lifecycle!.startGame()

    return engine.lifecycle!.enterScene(id)
  }

  const game = () => engine.lifecycle!.currentGame!
  const scene = () => engine.lifecycle!.activeScene!
  const snapshot = () => game().combat!.snapshot(scene(), 'combat')!

  const command = (type: 'end-turn' | 'queue-move', move?: string) => {
    game().combat!.request(
      scene(),
      'combat',
      type === 'end-turn' ? { type } : { type, move: move! },
    )

    for (let count = 0; count < 8; count++) engine.flushMessages()
  }

  return { engine, store, game, scene, enter, snapshot, command }
}

describe('rich status runtime integration', () => {
  it('allows end-turn and escape at zero AP', async () => {
    const source = JSON.parse(
      await readFile(
        new URL('../sample-games/combat-mechanics/combat/water.json', import.meta.url),
        'utf8',
      ),
    )

    source.mechanics.resources.exhaustion.initial = 60
    source.statuses.exhausted.modifiers.ap = -100
    const app = await launch(new MemorySaves(), { 'combat/water.json': source })
    app.enter('water')
    app.command('end-turn')
    expect(app.snapshot().remainingAp).toBe(0)
    expect(
      app.game().combat!.canCommand(app.scene(), 'combat', { type: 'queue-move', move: 'rest' }),
    ).toBe(false)
    expect(app.game().combat!.canCommand(app.scene(), 'combat', { type: 'end-turn' })).toBe(true)
    expect(app.game().combat!.canCommand(app.scene(), 'combat', { type: 'escape' })).toBe(true)
    app.game().combat!.request(app.scene(), 'combat', { type: 'escape' })

    for (let count = 0; count < 8; count++) app.engine.flushMessages()
    app.command('end-turn')
    expect(app.snapshot().outcome).toBe('escaped')
  })

  it('saves stacks and intensity, resumes durations, and rejects forged strengths without replacing the playthrough', async () => {
    const app = await launch()
    app.enter('shared-water')
    // The eel strips one stack when the diver builds two or more.
    app.command('queue-move', 'steady-breath')
    app.command('queue-move', 'steady-breath')
    app.command('queue-move', 'steady-breath')
    app.command('end-turn')
    expect(app.snapshot().statuses.diver).toMatchObject([{ id: 'rhythm', stacks: 2, remaining: 3 }])
    expect(app.snapshot().stats.diver?.defense).toBe(2)
    expect(app.engine.saves!.save()).toBe(true)
    app.engine.stop()
    const restored = await launch(app.store)
    expect(restored.engine.saves!.load()).toBe(true)
    expect(restored.snapshot().statuses.diver).toMatchObject([{ stacks: 2, remaining: 3 }])
    restored.command('end-turn')
    expect(restored.snapshot().statuses.diver?.[0]?.remaining).toBe(2)
    const saved = JSON.parse(app.store.read('combat-mechanics')!)
    saved.combat['shared-water'].statuses.diver[0].stacks = 4
    app.store.write('combat-mechanics', JSON.stringify(saved))
    const before = restored.game()
    expect(restored.engine.saves!.load()).toBe(false)
    expect(restored.game()).toBe(before)

    const legacy = savedCombatSchema.parse({
      round: 1,
      seed: 1,
      started: false,
      guard: {},
      plan: [],
      enemies: {},
      statuses: { player: [{ id: 'focus', source: 'player', remaining: 1 }] },
      cooldowns: {},
      escape: false,
      log: [],
    })

    expect(legacy.statuses.player?.[0]).toEqual({ id: 'focus', source: 'player', remaining: 1 })
  })

  it.each(['water', 'rough-water'])(
    'scales %s exhaustion penalties and keeps recovery affordable',
    async (id) => {
      const path = `combat/${id}.json`

      const source = JSON.parse(
        await readFile(
          new URL(`../sample-games/combat-mechanics/${path}`, import.meta.url),
          'utf8',
        ),
      )

      if (id === 'water') source.mechanics.resources.exhaustion.initial = 50
      else source.mechanicsOverrides.resources.exhaustion = { initial: 50 }
      const app = await launch(new MemorySaves(), { [path]: source })
      app.enter(id)
      const actor = id === 'water' ? 'player' : 'swimmer'
      app.command('end-turn')
      expect(
        app.snapshot().statuses[actor]?.find((status) => status.id === 'exhausted')?.intensity,
      ).toBe(1)
      expect(app.snapshot().ap[actor]).toBe(id === 'water' ? 2 : 3)
      expect(app.snapshot().moveCosts[actor]?.rest).toBe(id === 'water' ? 1 : 2)

      for (let count = 0; count < 5 && app.snapshot().resources.exhaustion! < 90; count++)
        app.command('end-turn')
      expect(
        app.snapshot().statuses[actor]?.find((status) => status.id === 'exhausted')?.intensity,
      ).toBe(2)
      expect(app.snapshot().ap[actor]).toBe(id === 'water' ? 1 : 3)
      expect(app.snapshot().moveCosts[actor]?.rest).toBe(id === 'water' ? 1 : 3)
      expect(
        app.game().combat!.canCommand(app.scene(), 'combat', { type: 'queue-move', move: 'heavy' }),
      ).toBe(false)
      expect(app.game().combat!.moveIssue(app.scene(), 'combat', 'heavy')).toContain('AP')

      for (
        let count = 0;
        count < 4 && app.snapshot().statuses[actor]?.some((status) => status.id === 'exhausted');
        count++
      ) {
        expect(
          app
            .game()
            .combat!.canCommand(app.scene(), 'combat', { type: 'queue-move', move: 'rest' }),
        ).toBe(true)
        app.command('queue-move', 'rest')
        app.command('end-turn')
      }

      expect(
        app.snapshot().statuses[actor]?.some((status) => status.id === 'exhausted'),
      ).toBeFalsy()
      expect(app.snapshot().ap[actor]).toBe(3)
      expect(app.snapshot().moveCosts[actor]?.rest).toBe(1)
    },
  )
})
