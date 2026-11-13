import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vite-plus/test'
import {
  combatDefinitionSchema,
  combatEnemyAISchema,
  combatLibrarySchema,
  combatSourceSchema,
  inventorySchema,
  resolveCombatSource,
  type CombatDefinition,
} from '@ancadeba/schemas'
import {
  planEnemies,
  resolveCombatRound,
  initialCombatMechanics,
  enemyConditionMatches,
  type CombatStatuses,
} from '@ancadeba/game-runtime'

function definition() {
  return combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'ai',
    label: 'Conditional AI',
    player: {
      id: 'hero',
      label: 'Hero',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 100,
      ap: 3,
      moves: ['prime'],
    },
    enemies: [
      {
        id: 'foe',
        label: 'Foe',
        health: { source: 'game.state', path: ['foe'] },
        maximumHealth: 100,
        ap: 3,
        moves: ['hit', 'surge', 'strip', 'charge', 'guard'],
        rotation: ['guard', 'hit'],
      },
    ],
    moves: {
      hit: { type: 'attack', label: 'Hit', apCost: 1, damage: { min: 2, max: 2 } },
      surge: {
        type: 'attack',
        label: 'Surge',
        apCost: 2,
        resourceCosts: { energy: 1 },
        damage: { min: 6, max: 6 },
      },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 2 },
      strip: {
        type: 'ability',
        label: 'Strip',
        apCost: 1,
        cooldown: 1,
        target: 'enemy',
        effects: [{ id: 'strip', type: 'remove-status', status: 'rhythm', stacks: 1 }],
      },
      charge: {
        type: 'ability',
        label: 'Charge',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'energy', type: 'change-resource', resource: 'energy', amount: 1 }],
      },
      prime: {
        type: 'ability',
        label: 'Prime',
        apCost: 1,
        target: 'self',
        effects: [
          { id: 'energy', type: 'change-resource', resource: 'energy', amount: 1 },
          { id: 'rhythm', type: 'apply-status', status: 'rhythm', stacks: 2, intensity: 2 },
        ],
      },
    },
    statuses: {
      rhythm: {
        type: 'modifier',
        label: 'Rhythm',
        duration: 3,
        stacking: { maximum: 3 },
        intensity: { initial: 1, maximum: 2 },
        modifiers: { defense: 0 },
      },
      stun: { type: 'stun', label: 'Stunned', duration: 1 },
      slow: { type: 'modifier', label: 'Slow', duration: 1, modifiers: { ap: -3 } },
    },
    mechanics: {
      initialPhase: 'calm',
      resources: { energy: { label: 'Energy', initial: 0, maximum: 5 } },
      phases: {
        calm: { label: 'Calm' },
        angry: { label: 'Angry', enemyRotations: { foe: ['hit'] } },
      },
      triggers: {
        enrage: {
          event: 'resource-changed',
          resource: 'energy',
          conditions: [{ type: 'resource', resource: 'energy', operator: 'gte', value: 1 }],
          effects: [{ type: 'set-phase', phase: 'angry' }],
        },
      },
    },
  })
}

function ai(encounter: CombatDefinition, rules: unknown[], fallback = 'rotation') {
  encounter.enemies[0]!.ai = combatEnemyAISchema.parse({ rules, fallback })

  return encounter
}

const health = { hero: 100, foe: 100 }

const moveIds = (
  encounter: CombatDefinition,
  resources = { energy: 0 },
  statuses: CombatStatuses = {},
) =>
  planEnemies(
    encounter,
    health,
    {},
    1,
    statuses,
    {},
    { ...initialCombatMechanics(encounter)!, resources },
  ).foe!.moves.map((move) => move.move)

function resolve(
  encounter: CombatDefinition,
  moves: string[] = [],
  options: Partial<Parameters<typeof resolveCombatRound>[1]> = {},
) {
  return resolveCombatRound(encounter, {
    health,
    maximumHealth: health,
    guard: {},
    seed: 1024,
    escape: false,
    plan: moves.map((move) => ({ move, target: 'hero' })),
    enemies: planEnemies(encounter, health, {}, 1),
    ...options,
  })
}

describe('conditional enemy AI validation', () => {
  it.each([
    ['move', { move: 'prime' }],
    ['actor', { conditions: [{ type: 'health', actor: 'missing', operator: 'lte', value: 1 }] }],
    [
      'resource',
      { conditions: [{ type: 'resource', resource: 'missing', operator: 'gte', value: 1 }] },
    ],
    [
      'status',
      {
        conditions: [
          { type: 'status', actor: 'hero', status: 'missing', operator: 'gte', value: 1 },
        ],
      },
    ],
    ['phase', { conditions: [{ type: 'phase', phase: 'missing' }] }],
  ])('rejects an invalid %s reference', (_kind, patch) => {
    const encounter = definition()

    const parsed = combatDefinitionSchema.safeParse({
      ...encounter,
      enemies: [{ ...encounter.enemies[0], ai: { rules: [{ id: 'bad', move: 'hit', ...patch }] } }],
    })

    expect(parsed.success).toBe(false)
  })

  it('validates unique rule IDs, bounded uses, enemy-only AI and optional wait fallback', () => {
    expect(
      combatEnemyAISchema.safeParse({
        rules: [
          { id: 'a', move: 'hit' },
          { id: 'a', move: 'guard' },
        ],
      }).success,
    ).toBe(false)
    expect(
      combatEnemyAISchema.safeParse({ rules: [{ id: 'a', move: 'hit', maxUses: 0 }] }).success,
    ).toBe(false)
    const encounter = definition()
    expect(
      combatDefinitionSchema.safeParse({
        ...encounter,
        player: { ...encounter.player, ai: { rules: [] } },
      }).success,
    ).toBe(false)
    encounter.enemies[0]!.rotation = []
    ai(encounter, [], 'wait')
    expect(combatDefinitionSchema.safeParse(encounter).success).toBe(true)
    expect(moveIds(encounter)).toEqual([])
    encounter.enemies[0]!.ai = undefined
    expect(combatDefinitionSchema.safeParse(encounter).success).toBe(false)
  })
})

describe('conditional enemy planning', () => {
  it('uses ordered AND conditions, per-turn limits and fallback without moving its cursor for rules', () => {
    const encounter = ai(definition(), [
      {
        id: 'first',
        move: 'strip',
        conditions: [
          { type: 'status', actor: 'hero', status: 'rhythm', operator: 'gte', value: 2 },
          { type: 'resource', resource: 'energy', operator: 'gte', value: 1 },
        ],
      },
      { id: 'second', move: 'hit' },
    ])

    const statuses = { hero: [{ id: 'rhythm', source: 'hero', remaining: 3, stacks: 2 }] }
    expect(moveIds(encounter, { energy: 0 }, statuses)).toEqual(['hit', 'guard', 'hit'])

    const plans = planEnemies(
      encounter,
      health,
      {},
      1,
      statuses,
      {},
      { ...initialCombatMechanics(encounter)!, resources: { energy: 1 } },
    )

    expect(plans.foe).toEqual({
      moves: [
        { move: 'strip', target: 'hero' },
        { move: 'hit', target: 'hero' },
        { move: 'guard', target: 'foe' },
      ],
      cursor: 1,
      startCursor: 0,
    })
    expect(moveIds(encounter, { energy: 1 }, statuses)).toEqual(['strip', 'hit', 'guard'])
  })

  it.each([
    ['eq', 2, true],
    ['gt', 1, true],
    ['gte', 2, true],
    ['lt', 3, true],
    ['lte', 2, true],
    ['lt', 2, false],
  ] as const)('compares status strength using %s', (operator, value, expected) => {
    const context = {
      health,
      statuses: { hero: [{ id: 'rhythm', source: 'hero', remaining: 3, stacks: 2, intensity: 1 }] },
      cooldowns: {},
      resources: {},
      phase: undefined,
      round: 1,
    }

    expect(
      enemyConditionMatches(
        { type: 'status', actor: 'hero', status: 'rhythm', measure: 'stacks', operator, value },
        context,
      ),
    ).toBe(expected)
    expect(
      enemyConditionMatches(
        {
          type: 'status',
          actor: 'hero',
          status: 'missing',
          measure: 'intensity',
          operator: 'eq',
          value: 0,
        },
        context,
      ),
    ).toBe(true)
    expect(
      enemyConditionMatches(
        {
          type: 'status',
          actor: 'hero',
          status: 'rhythm',
          measure: 'intensity',
          operator: 'eq',
          value: 1,
        },
        context,
      ),
    ).toBe(true)
    expect(
      enemyConditionMatches(
        {
          type: 'status',
          actor: 'foe',
          status: 'rhythm',
          measure: 'stacks',
          operator: 'eq',
          value: 0,
        },
        context,
      ),
    ).toBe(true)
  })

  it('skips unaffordable and cooling rules, reserves costs, and does not predict resource gains', () => {
    const encounter = ai(
      definition(),
      [
        { id: 'surge', move: 'surge', maxUses: 3 },
        { id: 'strip', move: 'strip', maxUses: 3 },
        { id: 'charge', move: 'charge', maxUses: 3 },
      ],
      'wait',
    )

    expect(moveIds(encounter, { energy: 1 })).toEqual(['surge', 'strip'])
    expect(moveIds(encounter)).toEqual(['strip', 'charge', 'charge'])
    expect(
      planEnemies(
        encounter,
        health,
        {},
        1,
        {},
        { foe: { strip: 3 } },
        initialCombatMechanics(encounter),
      ).foe!.moves.map((move) => move.move),
    ).toEqual(['charge', 'charge', 'charge'])
    const copy = structuredClone(encounter)
    moveIds(encounter)
    expect(encounter).toEqual(copy)
  })

  it('uses reserved resource balances for conditions and respects AP, stun, death, and legacy status strength', () => {
    const encounter = ai(
      definition(),
      [
        { id: 'surge', move: 'surge' },
        {
          id: 'empty',
          move: 'hit',
          conditions: [{ type: 'resource', resource: 'energy', operator: 'eq', value: 0 }],
        },
      ],
      'wait',
    )

    expect(moveIds(encounter, { energy: 1 })).toEqual(['surge', 'hit'])

    for (const id of ['slow', 'stun'])
      expect(
        moveIds(encounter, { energy: 1 }, { foe: [{ id, source: 'hero', remaining: 1 }] }),
      ).toEqual([])
    expect(planEnemies(encounter, { ...health, foe: 0 }, {}).foe!.moves).toEqual([])
    expect(planEnemies(encounter, { ...health, hero: 0 }, {}).foe!.moves).toEqual([])
    ai(
      encounter,
      [
        {
          id: 'legacy',
          move: 'strip',
          conditions: [
            {
              type: 'status',
              actor: 'hero',
              status: 'rhythm',
              measure: 'intensity',
              operator: 'eq',
              value: 1,
            },
          ],
        },
      ],
      'wait',
    )
    expect(
      moveIds(encounter, { energy: 0 }, { hero: [{ id: 'rhythm', source: 'hero', remaining: 1 }] }),
    ).toEqual(['strip'])
  })
})

describe('live enemy choices', () => {
  it('responds to player-applied stacks and phase changes in the same round', () => {
    const encounter = ai(definition(), [
      {
        id: 'strip',
        move: 'strip',
        conditions: [
          {
            type: 'status',
            actor: 'hero',
            status: 'rhythm',
            measure: 'stacks',
            operator: 'gte',
            value: 2,
          },
        ],
      },
      { id: 'angry', move: 'surge', conditions: [{ type: 'phase', phase: 'angry' }] },
    ])

    expect(moveIds(encounter)).toEqual(['guard', 'hit', 'guard'])
    const result = resolve(encounter, ['prime'])
    expect(result.entries).toContainEqual({
      type: 'statusReduced',
      actor: 'foe',
      target: 'hero',
      status: 'rhythm',
      stacks: 1,
      intensity: 2,
    })
    expect(result.health.hero).toBe(94)
    expect(result.mechanics?.phase).toBe('angry')
    expect(result.cursors.foe).toBe(0)
    expect(result.cooldowns.foe?.strip).toBe(3)
    expect(result.entries.some((entry) => entry.type === 'guarded')).toBe(false)
  })

  it('reevaluates resources after its own actions without assuming future gains in previews', () => {
    const encounter = ai(
      definition(),
      [
        {
          id: 'spend',
          move: 'surge',
          conditions: [{ type: 'resource', resource: 'energy', operator: 'gte', value: 1 }],
        },
        {
          id: 'gain',
          move: 'charge',
          conditions: [{ type: 'resource', resource: 'energy', operator: 'eq', value: 0 }],
        },
      ],
      'wait',
    )

    expect(moveIds(encounter)).toEqual(['charge'])
    const result = resolve(encounter)
    expect(result.health.hero).toBe(94)
    expect(result.mechanics?.resources.energy).toBe(0)
    expect(result.entries.filter((entry) => entry.type === 'attack')).toHaveLength(1)
    expect(result).toEqual(resolve(encounter))
    expect(health).toEqual({ hero: 100, foe: 100 })
  })

  it('evaluates after enemy turn-start triggers and limits uses to each enemy turn', () => {
    const encounter = ai(
      definition(),
      [{ id: 'hit', move: 'hit', conditions: [{ type: 'phase', phase: 'angry' }] }],
      'wait',
    )

    encounter.mechanics!.triggers.start = {
      event: 'turn-start',
      actor: 'foe',
      once: false,
      conditions: [],
      effects: [{ type: 'set-phase', phase: 'angry' }],
    }
    const first = resolve(encounter)
    expect(first.health.hero).toBe(98)

    const second = resolve(encounter, [], {
      health: first.health,
      mechanics: first.mechanics,
      round: 2,
      enemies: planEnemies(
        encounter,
        first.health,
        first.cursors,
        2,
        first.statuses,
        first.cooldowns,
        first.mechanics,
      ),
    })

    expect(second.health.hero).toBe(96)
  })

  it('keeps rotation-only enemy turns fixed and uses live phase fallback for conditional enemies', () => {
    const encounter = definition()
    const old = resolve(encounter, ['prime'])
    expect(old.entries.filter((entry) => entry.type === 'guarded')).toHaveLength(2)
    ai(encounter, [])
    const live = resolve(encounter, ['prime'])
    expect(live.entries.filter((entry) => entry.type === 'guarded')).toHaveLength(0)
    expect(live.entries.filter((entry) => entry.type === 'attack')).toHaveLength(3)

    const idle = resolve(ai(encounter, [{ id: 'blocked', move: 'surge' }], 'wait'), [], {
      statuses: { foe: [{ id: 'slow', source: 'hero', remaining: 1 }] },
    })

    expect(idle.seed).toBe(1024)
    expect(idle.health).toEqual(health)
  })
})

describe('conditional enemy examples', () => {
  const root = new URL('../sample-games/combat-mechanics/', import.meta.url)

  const read = async (path: string): Promise<unknown> =>
    JSON.parse(await readFile(new URL(path, root), 'utf8'))

  it.each(['water', 'shared-water', 'rough-water'])(
    'responds to exhaustion and rhythm in %s, including shared mechanics',
    async (id) => {
      const source = combatSourceSchema.parse(await read(`combat/${id}.json`))
      const library = combatLibrarySchema.parse(await read('combat-libraries/environments.json'))
      const inventory = inventorySchema.parse(await read('inventory/diving-gear.json'))

      const resolved = resolveCombatSource(
        source,
        new Map([['environments', library]]),
        undefined,
        inventory,
      )

      expect(resolved.issues).toEqual([])
      const encounter = resolved.definition!
      const player = encounter.player.id
      const enemy = encounter.enemies[0]!.id
      const hp = { [player]: 80, [enemy]: 90 }
      const mechanics = initialCombatMechanics(encounter)!
      mechanics.resources.exhaustion = 60
      const plans = planEnemies(encounter, hp, {}, 1, {}, {}, mechanics)
      expect(plans[enemy]!.moves.map((move) => move.move)).toEqual(['ambush'])
      const statuses = { [player]: [{ id: 'rhythm', source: player, stacks: 2, remaining: 3 }] }
      expect(
        planEnemies(encounter, hp, {}, 1, statuses, {}, mechanics)[enemy]!.moves.map(
          (move) => move.move,
        ),
      ).toEqual(['disrupt', 'guard'])
      expect(
        planEnemies(encounter, hp, {}, 2, statuses, { [enemy]: { disrupt: 3 } }, mechanics)[
          enemy
        ]!.moves.map((move) => move.move),
      ).toEqual(['ambush'])
    },
  )

  it('uses the boss gauge and current phase to choose a response', async () => {
    const encounter = combatDefinitionSchema.parse(await read('combat/boss.json'))
    const hp = { player: 80, guardian: 500 }
    const mechanics = initialCombatMechanics(encounter)!
    mechanics.resources.seal = 50
    expect(
      planEnemies(encounter, hp, {}, 1, {}, {}, mechanics).guardian!.moves.map((move) => move.move),
    ).toEqual(['guard', 'guard'])
    mechanics.phase = 'second-seal'
    expect(
      planEnemies(encounter, hp, {}, 1, {}, {}, mechanics).guardian!.moves.map((move) => move.move),
    ).toEqual(['pulse', 'pulse'])
    mechanics.phase = 'third-seal'
    expect(
      planEnemies(encounter, hp, {}, 1, {}, {}, mechanics).guardian!.moves.map((move) => move.move),
    ).toEqual(['surge'])
  })
})
