import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vite-plus/test'
import {
  combatSourceSchema,
  combatLibrarySchema,
  combatDefinitionSchema,
  inventorySchema,
  cloneCombatRules,
  resolveCombatSource,
  type CombatDefinition,
} from '@ancadeba/schemas'
import {
  CombatSimulation,
  combatSimulationSetup,
  resolveCombatRound,
  planEnemies,
  chooseEnemyAction,
  enemyDecisionState,
  type CombatSimulationSetup,
  type CombatDebugFrame,
  type EnemyDecisionTrace,
} from '@ancadeba/game-runtime'

async function sample(id: string) {
  const root = new URL('../sample-games/combat-mechanics/', import.meta.url)

  const source = combatSourceSchema.parse(
    JSON.parse(await readFile(new URL(`combat/${id}.json`, root), 'utf8')),
  )

  const library = combatLibrarySchema.parse(
    JSON.parse(await readFile(new URL('combat-libraries/environments.json', root), 'utf8')),
  )

  const inventory = inventorySchema.parse(
    JSON.parse(await readFile(new URL('inventory/diving-gear.json', root), 'utf8')),
  )

  const resolved = resolveCombatSource(
    source,
    new Map([['environments', library]]),
    undefined,
    inventory,
  )

  expect(resolved.issues).toEqual([])
  const definition = resolved.definition!

  const health = Object.fromEntries(
    [definition.player, ...definition.enemies].map((actor) => [
      actor.id,
      typeof actor.maximumHealth === 'number' ? actor.maximumHealth : 80,
    ]),
  )

  return {
    definition,
    setup: {
      health,
      maximumHealth: { ...health },
      itemContext: { inventory },
    } satisfies CombatSimulationSetup,
  }
}

function tiny(): CombatDefinition {
  return combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'tiny',
    label: 'Tiny',
    allowEscape: true,
    player: {
      id: 'player',
      label: 'Player',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 50,
      moves: ['hit', 'guard'],
    },
    enemies: [
      {
        id: 'enemy',
        label: 'Enemy',
        health: { source: 'game.state', path: ['foe'] },
        maximumHealth: 50,
        ap: 2,
        moves: ['hit', 'guard', 'expensive'],
        rotation: ['hit'],
        ai: {
          rules: [
            { id: 'costly', move: 'expensive' },
            { id: 'limited', move: 'guard', maxUses: 1 },
          ],
        },
      },
    ],
    moves: {
      hit: { type: 'attack', label: 'Hit', apCost: 1, cooldown: 1, damage: { min: 1, max: 3 } },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 3 },
      expensive: {
        type: 'attack',
        label: 'Expensive',
        apCost: 2,
        resourceCosts: { energy: 3 },
        damage: { min: 4, max: 4 },
      },
    },
    statuses: { stun: { type: 'stun', label: 'Stun', duration: 2 } },
    mechanics: { resources: { energy: { initial: 0, maximum: 10 } } },
  })
}

describe('combat decision explanations', () => {
  it('explains conditions, limits, AP, cooldowns and resources using the actual choice logic', () => {
    const definition = tiny()
    const state = enemyDecisionState()
    state.uses.set('limited', 1)
    state.reserved.add('hit')
    const decisions: EnemyDecisionTrace[] = []

    const context = {
      health: { player: 50, enemy: 50 },
      statuses: {},
      cooldowns: { enemy: { hit: 3 } },
      resources: { energy: 1 },
      phase: undefined,
      round: 1,
    }

    expect(
      chooseEnemyAction(definition, definition.enemies[0]!, context, state, 1, (trace) =>
        decisions.push(trace),
      ),
    ).toBeUndefined()
    expect(decisions[0]).toMatchObject({ remainingAp: 1, stop: 'unavailable' })
    expect(decisions[0]!.candidates[0]).toMatchObject({
      move: 'expensive',
      blockers: ['ap', 'resource'],
      required: 3,
      available: 1,
    })
    expect(decisions[0]!.candidates[1]?.blockers).toContain('use-limit')
    expect(decisions[0]!.candidates[2]?.blockers).toEqual(['cooldown', 'reserved'])
    expect(state.cursor).toBe(0)
  })

  it('keeps traced choices, cursors and RNG identical, even when observers mutate their copies', () => {
    const definition = tiny()

    const context = {
      health: { player: 50, enemy: 50 },
      statuses: {},
      cooldowns: {},
      resources: { energy: 3 },
      phase: undefined,
      round: 1,
    }

    const plain = enemyDecisionState()
    const traced = enemyDecisionState()
    const expected = chooseEnemyAction(definition, definition.enemies[0]!, context, plain)

    const actual = chooseEnemyAction(
      definition,
      definition.enemies[0]!,
      context,
      traced,
      0,
      (decision) => {
        if (decision.choice) Object.defineProperty(decision.choice, 'move', { value: 'tampered' })
      },
    )

    expect(actual).toEqual(expected)
    expect(traced).toEqual(plain)

    const current = {
      health: context.health,
      guard: {},
      seed: 1024,
      escape: false,
      plan: [],
      enemies: planEnemies(definition, context.health, {}),
    }

    const frames: CombatDebugFrame[] = []

    const result = resolveCombatRound(definition, current, (frame) => {
      frames.push(cloneCombatRules(frame))
      Object.defineProperty(frame.health, 'player', { value: 0 })
    })

    expect(result).toEqual(resolveCombatRound(definition, current))
    expect(frames.some((frame) => frame.kind === 'enemy-decision')).toBe(true)
    expect(current.seed).toBe(1024)
    expect(context.health.player).toBe(50)
  })
})

describe('combat simulation samples', () => {
  it('fills the boss gauge three times, records live phase decisions, and reproduces round inputs', async () => {
    const { definition, setup } = await sample('boss')
    const before = cloneCombatRules(definition)
    const simulation = new CombatSimulation(definition, setup)

    for (let count = 0; count < 3; count++) simulation.queue('channel')
    simulation.run(4)
    const report = simulation.report()
    expect(simulation.preview()).toEqual([])
    expect(report.state).toMatchObject({
      outcome: 'victory',
      health: { guardian: 500 },
      mechanics: { resources: { seal: 0, breaks: 3 }, phase: 'third-seal' },
    })
    expect(report.frames.some((frame) => frame.mechanicsEvent?.trigger === 'second-seal')).toBe(
      true,
    )

    const phaseDecision = report.frames.find(
      (frame) => frame.decision?.phase === 'second-seal' && frame.decision.choice?.move === 'pulse',
    )!.decision!

    expect(
      phaseDecision.candidates.some((candidate) =>
        candidate.conditions.some(
          (check) =>
            check.condition.type === 'phase' && check.actual === 'second-seal' && check.matched,
        ),
      ),
    ).toBe(true)
    const replay = new CombatSimulation(report.definition, report.setup)

    for (const input of report.inputs) {
      for (const move of input.plan) replay.queue(move.move, move.target)
      replay.resolve(input.escape)
    }

    expect(replay.report()).toEqual(report)
    expect(definition).toEqual(before)
    const copy = simulation.snapshot()
    copy.health.player = 0
    expect(simulation.snapshot().health.player).not.toBe(0)
    simulation.reset()
    expect(simulation.snapshot()).toMatchObject({
      round: 1,
      seed: definition.seed,
      health: setup.health,
      plan: [],
      mechanics: { resources: { seal: 0, breaks: 0 }, initialized: false },
    })
    expect(simulation.trace()).toEqual([])
  })

  it('explains water exhaustion, stack disruption, AP rejection and cooldown fallback', async () => {
    const { definition, setup } = await sample('shared-water')

    const simulation = new CombatSimulation(definition, {
      ...setup,
      resources: { exhaustion: 55 },
      statuses: { diver: [{ id: 'rhythm', source: 'diver', remaining: 3, stacks: 2 }] },
    })

    const previewBefore = simulation.snapshot()
    simulation.preview()
    expect(simulation.snapshot()).toEqual(previewBefore)
    simulation.resolve()
    const frames = simulation.trace()
    const choice = frames.find((frame) => frame.decision?.choice?.move === 'disrupt')!.decision!
    expect(choice.candidates[0]).toMatchObject({
      rule: 'break-rhythm',
      selected: true,
      conditions: [{ actual: 2, matched: true }],
    })
    const fallback = frames.find((frame) => frame.decision?.choice?.move === 'guard')!.decision!
    expect(
      fallback.candidates.find((candidate) => candidate.rule === 'exploit-fatigue'),
    ).toMatchObject({
      cost: 2,
      blockers: ['ap'],
      conditions: [
        { matched: true, children: [{ actual: 65, matched: true }, { matched: false }] },
      ],
    })
    expect(fallback.candidates[0]?.blockers).toContain('cooldown')
    expect(simulation.snapshot()).toMatchObject({
      health: { diver: 77 },
      statuses: {
        diver: expect.arrayContaining([expect.objectContaining({ id: 'rhythm', stacks: 1 })]),
      },
    })
    simulation.resolve()
    expect(
      simulation
        .trace()
        .some((frame) => frame.round === 2 && frame.decision?.choice?.move === 'ambush'),
    ).toBe(true)
  })

  it.each(['shared-water', 'rough-water'])(
    'simulates inherited AI and the %s local mechanics',
    async (id) => {
      const { definition, setup } = await sample(id)

      const simulation = new CombatSimulation(definition, {
        ...setup,
        resources: { exhaustion: 40 },
      })

      simulation.resolve()

      const decisions = simulation
        .trace()
        .flatMap((frame) => (frame.decision ? [frame.decision] : []))

      const exploit = decisions
        .flatMap((decision) => decision.candidates)
        .find((candidate) => candidate.rule === 'exploit-fatigue')!

      expect(exploit.conditions[0]?.children?.[0]?.actual ?? exploit.conditions[0]?.actual).toBe(
        id === 'rough-water' ? 60 : 50,
      )
      expect(decisions.some((decision) => decision.choice?.move === 'ambush')).toBe(
        id === 'rough-water',
      )
    },
  )

  it('captures same-round boss phase changes rather than treating the preview as a commitment', async () => {
    const { definition, setup } = await sample('boss')
    const simulation = new CombatSimulation(definition, { ...setup, resources: { seal: 75 } })
    expect(simulation.preview()[0]?.phase).toBe('first-seal')
    simulation.queue('channel')
    simulation.resolve()
    const decisions = simulation.trace().filter((frame) => frame.decision?.choice)
    expect(decisions[0]?.decision).toMatchObject({
      phase: 'second-seal',
      choice: { move: 'pulse' },
    })
    expect(simulation.snapshot().mechanics?.resources.breaks).toBe(1)
  })
})

describe('simulation boundaries', () => {
  it('enforces planning constraints, setup bounds, trace limits, and preserves failed candidates', async () => {
    const { definition, setup } = await sample('water')
    const simulation = new CombatSimulation(definition, { ...setup, resources: { stamina: 10 } }, 2)
    simulation.queue('jab', 'eel')
    expect(simulation.queueIssue('jab', 'eel')).toContain('resource')
    expect(simulation.queueIssue('jab', 'missing')).toContain('target')
    simulation.undo()
    simulation.queue('guard')
    simulation.clear()
    simulation.resolve()
    expect(simulation.trace()).toHaveLength(2)
    expect(simulation.report().truncated).toBe(true)
    expect(simulation.report().inputs).toHaveLength(1)
    expect(() => simulation.run(101)).toThrow('1–100')
    expect(() => new CombatSimulation(definition, { ...setup, seed: 0 })).toThrow('seed')
    expect(
      () => new CombatSimulation(definition, { ...setup, health: { player: 1000, eel: 90 } }),
    ).toThrow('health')
    expect(() => new CombatSimulation(definition, { ...setup, resources: { missing: 1 } })).toThrow(
      'resource',
    )
    expect(
      () =>
        new CombatSimulation(definition, {
          ...setup,
          statuses: { player: [{ id: 'rhythm', source: 'player', stacks: 4, remaining: 1 }] },
        }),
    ).toThrow()
    const broken = cloneCombatRules(definition)
    broken.mechanics!.triggers.cycle = {
      event: 'resource-changed',
      resource: 'exhaustion',
      once: false,
      conditions: [],
      effects: [
        { type: 'set-resource', resource: 'exhaustion', amount: 0 },
        { type: 'set-resource', resource: 'exhaustion', amount: 1 },
      ],
    }
    const candidate = new CombatSimulation(broken, setup)
    candidate.queue('jab', 'eel')
    const before = candidate.report()
    expect(() => candidate.resolve()).toThrow('operation limit')
    expect(candidate.report()).toEqual(before)
  })

  it('keeps ordinary rotation behavior and explains turn-start stun', () => {
    const definition = tiny()
    const setup = { health: { player: 50, enemy: 50 }, maximumHealth: { player: 50, enemy: 50 } }

    const simulation = new CombatSimulation(definition, {
      ...setup,
      statuses: { enemy: [{ id: 'stun', source: 'player', remaining: 1 }] },
    })

    simulation.resolve()
    expect(simulation.trace().find((frame) => frame.decision)?.decision?.stop).toBe('stunned')
    expect(simulation.snapshot().health.player).toBe(50)
    simulation.queue('hit', 'enemy')
    simulation.resolve()
    expect(simulation.queueIssue('hit', 'enemy')).toContain('cooldown')
    const plain = cloneCombatRules(definition)
    plain.enemies[0]!.ai = undefined
    const regular = new CombatSimulation(plain, setup)
    regular.queue('guard')
    const current = regular.snapshot()
    expect(regular.resolve()).toEqual(
      resolveCombatRound(plain, { ...current, maximumHealth: setup.maximumHealth, escape: false }),
    )
    expect(
      regular
        .preview()
        .some((decision) => decision.candidates.some((candidate) => candidate.kind === 'rotation')),
    ).toBe(true)
  })

  it('resolves starting equipment and bound stats, and respects level unlocks', () => {
    const definition = tiny()
    definition.player.equipmentOwner = 'hero'
    definition.player.leveling = 'hero-level'
    definition.player.moveLevels = { guard: 2 }

    const inventory = inventorySchema.parse({
      'schema-version': '1.0.0',
      owners: {
        hero: {
          label: 'Hero',
          combatStats: {
            health: definition.player.health,
            maximumHealth: 50,
            attack: { source: 'game.state', path: ['attack'] },
          },
        },
      },
      itemTypes: { sword: { label: 'Sword', combatBonuses: { attack: 3, maximumHealth: 5 } } },
      items: {
        sword: { itemType: 'sword', placement: { type: 'equipped', owner: 'hero', slot: 'hand' } },
      },
    })

    const read = (binding: { path: (string | number)[] }) => (binding.path[0] === 'attack' ? 2 : 50)
    const setup = combatSimulationSetup(definition, read, inventory, 1)
    expect(setup).toMatchObject({
      maximumHealth: { player: 55 },
      stats: { player: { attack: 5 } },
      availableMoves: ['hit'],
    })
    expect(new CombatSimulation(definition, setup).queueIssue('guard')).toContain('level')
    expect(() => combatSimulationSetup(definition, read, inventory)).toThrow('level')
    expect(() => combatSimulationSetup(definition, () => undefined, inventory, 1)).toThrow(
      'bindings',
    )
  })

  it('simulates escape without world effects and refuses commands after an outcome', () => {
    const definition = tiny()

    const simulation = new CombatSimulation(definition, {
      health: { player: 50, enemy: 50 },
      maximumHealth: { player: 50, enemy: 50 },
    })

    expect(simulation.resolve(true).outcome).toBe('escaped')
    expect(() => simulation.resolve()).toThrow('finished')
    expect(simulation.queueIssue('hit', 'enemy')).toContain('finished')
    expect(simulation.report().inputs).toEqual([{ round: 1, plan: [], escape: true }])
  })
})
