import { describe, expect, it } from 'vite-plus/test'
import {
  combatScalingSchema,
  combatPercentModifiersSchema,
  combatDefinitionSchema,
  combatSourceSchema,
  combatLibrarySchema,
  combatScalingIssues,
  resolveCombatSource,
  inventorySchema,
  itemUseIssues,
  type CombatDefinition,
  type CombatScaling,
} from '@ancadeba/schemas'
import {
  evaluateCombatValue,
  applyCombatPercent,
  combatValueContext,
  combatResourceCosts,
  combatActorEconomy,
  combatActionCost,
  combatEconomySnapshot,
  combatResourceIssue,
  combatMoveValues,
  combatAbilityEffectValues,
  statusContributions,
  temporaryCombatStats,
  resolveCombatRound,
  CombatSimulation,
  type CombatValueContext,
  type CombatDebugFrame,
} from '@ancadeba/game-runtime'
import { abilityCanMatter } from '../packages/game-runtime/src/itemUseEligibility.js'
import { mergeCombatEntries } from '../packages/editor-core/src/combatEntryEditing.js'

const resource = (factor: number, measure?: 'percent'): CombatScaling => ({
  terms: [{ type: 'resource', resource: 'energy', factor, ...(measure ? { measure } : {}) }],
})

const context: CombatValueContext = {
  resources: { energy: 50 },
  resourceMaximums: { energy: 200 },
  statuses: { player: [{ id: 'flow', source: 'player', remaining: 3, stacks: 2, intensity: 3 }] },
  self: 'player',
  target: 'enemy',
}

function fixture(): CombatDefinition {
  return combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'scaling',
    label: 'Scaling',
    player: {
      id: 'player',
      label: 'Player',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 80,
      ap: 5,
      moves: ['strike', 'heal', 'guard'],
    },
    enemies: [
      {
        id: 'enemy',
        label: 'Enemy',
        health: { source: 'game.state', path: ['enemy'] },
        maximumHealth: 90,
        ap: 2,
        moves: ['strike', 'guard'],
        rotation: ['guard'],
      },
    ],
    moves: {
      strike: {
        type: 'ability',
        label: 'Strike',
        target: 'enemy',
        apCost: 2,
        apCostScaling: resource(0.02),
        resourceCosts: { stamina: 10 },
        resourceCostScaling: {
          stamina: {
            terms: [
              { type: 'status', actor: 'self', status: 'flow', measure: 'intensity', factor: 2 },
            ],
          },
        },
        effects: [
          {
            id: 'damage',
            type: 'damage',
            damage: { min: 8, max: 8 },
            scaling: {
              terms: [
                { type: 'resource', resource: 'energy', factor: 0.1 },
                { type: 'status', actor: 'self', status: 'flow', measure: 'intensity', factor: 3 },
              ],
            },
          },
        ],
      },
      heal: {
        type: 'ability',
        label: 'Heal',
        target: 'self',
        apCost: 1,
        resourceCosts: { stamina: 10 },
        effects: [
          {
            id: 'heal',
            type: 'heal',
            amount: 5,
            scaling: {
              terms: [
                { type: 'resource', resource: 'stamina', factor: 0.1 },
                { type: 'status', actor: 'self', status: 'flow', factor: 2 },
              ],
            },
          },
        ],
      },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 3 },
    },
    statuses: {
      flow: {
        type: 'modifier',
        label: 'Flow',
        duration: 3,
        modifiers: { attack: 1 },
        percentModifiers: { damage: 25, healing: 20, apCost: -25 },
        intensity: { initial: 1, maximum: 3 },
        stacking: { maximum: 3 },
      },
    },
    mechanics: {
      resources: { energy: { initial: 50, maximum: 200 }, stamina: { initial: 50, maximum: 100 } },
    },
  })
}

const active = { player: [{ id: 'flow', source: 'player', remaining: 3, intensity: 2 }] }

function resolve(
  definition: CombatDefinition,
  moves: string[],
  statuses = active,
  debug?: CombatDebugFrame[],
) {
  return resolveCombatRound(
    definition,
    {
      health: { player: 30, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      guard: {},
      seed: 1024,
      escape: false,
      statuses,
      plan: moves.map((move) => ({
        move,
        target:
          definition.moves[move]?.type === 'ability' && definition.moves[move].target === 'self'
            ? 'player'
            : 'enemy',
      })),
      enemies: { enemy: { moves: [], cursor: 0 } },
    },
    debug
      ? (frame) => {
          debug.push(frame)
        }
      : undefined,
  )
}

describe('bounded dynamic combat values', () => {
  it('evaluates additive and percentage formulas with resource amounts, resource percentages and status measures', () => {
    expect(evaluateCombatValue(10, resource(0.1), context)).toBe(15)
    expect(evaluateCombatValue(10, resource(0.1, 'percent'), context)).toBe(12)
    expect(evaluateCombatValue(10, { ...resource(2, 'percent'), mode: 'percent' }, context)).toBe(
      15,
    )

    const terms: CombatScaling = {
      terms: [
        { type: 'status', actor: 'self', status: 'flow', measure: 'intensity', factor: 2 },
        { type: 'status', actor: 'player', status: 'flow', measure: 'stacks', factor: -1 },
        { type: 'status', actor: 'self', status: 'flow', measure: 'remaining', factor: 1 },
      ],
    }

    expect(evaluateCombatValue(10, terms, context)).toBe(17)
    expect(
      evaluateCombatValue(
        10,
        { terms: [{ type: 'status', actor: 'target', status: 'flow', factor: 100 }] },
        context,
      ),
    ).toBe(10)
    expect(evaluateCombatValue(10, undefined)).toBe(10)
  })

  it('uses exact fractional arithmetic, supports explicit rounding and never consumes RNG', () => {
    const thirds = { ...context, resources: { energy: 1 }, resourceMaximums: { energy: 3 } }
    expect(evaluateCombatValue(0, resource(0.1, 'percent'), thirds)).toBe(3)
    expect(evaluateCombatValue(0, { ...resource(0.1, 'percent'), rounding: 'ceil' }, thirds)).toBe(
      4,
    )
    expect(
      evaluateCombatValue(0, { ...resource(0.1, 'percent'), rounding: 'nearest' }, thirds),
    ).toBe(3)
    expect(evaluateCombatValue(0, { ...resource(0.15), rounding: 'nearest' }, context)).toBe(8)
    expect(evaluateCombatValue(0, resource(0.15), context, 'ceil')).toBe(8)
    expect(evaluateCombatValue(0, { ...resource(0.15), rounding: 'floor' }, context, 'ceil')).toBe(
      7,
    )
    expect(applyCombatPercent(3, 12.5)).toBe(3)
    expect(applyCombatPercent(3, 12.5, 'ceil')).toBe(4)
    expect(Number.isSafeInteger(applyCombatPercent(10, (999999 * 99 * 99) / 100))).toBe(true)
    expect(applyCombatPercent(Number.MAX_SAFE_INTEGER, 100, 'floor', 100)).toBe(100)
  })

  it('clamps negative results and explicit bounds while rejecting unsafe unbounded calculations', () => {
    expect(evaluateCombatValue(10, resource(-100), context)).toBe(0)
    expect(evaluateCombatValue(10, { ...resource(-100), minimum: 2 }, context)).toBe(2)
    expect(applyCombatPercent(10, -200)).toBe(0)
    const maximum = Number.MAX_SAFE_INTEGER

    const large = {
      ...context,
      resources: { energy: maximum },
      resourceMaximums: { energy: maximum },
    }

    expect(evaluateCombatValue(0, resource(1), large)).toBe(maximum)
    expect(() => evaluateCombatValue(1, resource(1), large)).toThrow('overflow')
    expect(evaluateCombatValue(1, { ...resource(10000), maximum: 100 }, large)).toBe(100)
    expect(evaluateCombatValue(1, { ...resource(1), maximum }, large)).toBe(maximum)
    expect(() => evaluateCombatValue(1, resource(1))).toThrow('requires context')
    expect(() => evaluateCombatValue(1, resource(1), { ...context, resources: {} })).toThrow(
      'resource unavailable',
    )
    expect(() =>
      evaluateCombatValue(1, resource(1, 'percent'), {
        ...context,
        resourceMaximums: { energy: 0 },
      }),
    ).toThrow('maximum unavailable')
  })

  it('validates bounds, coefficient precision, term budgets and referenced combat data', () => {
    expect(combatScalingSchema.safeParse({ terms: [] }).success).toBe(false)
    expect(
      combatScalingSchema.safeParse({
        terms: Array.from({ length: 21 }, () => resource(1).terms[0]),
      }).success,
    ).toBe(false)

    for (const factor of [NaN, Infinity, 0.001, 10000.01])
      expect(combatScalingSchema.safeParse(resource(factor)).success).toBe(false)
    expect(combatScalingSchema.safeParse({ ...resource(1), minimum: 5, maximum: 4 }).success).toBe(
      false,
    )
    expect(combatPercentModifiersSchema.safeParse({ damage: 12.5, apCost: -25 }).success).toBe(true)
    expect(combatPercentModifiersSchema.safeParse({ damage: 0.001 }).success).toBe(false)
    expect(
      combatScalingIssues(
        {
          terms: [
            { type: 'resource', resource: 'unknown', factor: 1 },
            { type: 'status', actor: 'missing', status: 'missing', factor: 1 },
          ],
        },
        { actors: ['player'], resources: {}, statuses: {} },
      ).map((issue) => issue.path),
    ).toEqual([
      ['terms', 0, 'resource'],
      ['terms', 1, 'actor'],
      ['terms', 1, 'status'],
    ])
    const definition = fixture()
    expect(
      combatDefinitionSchema.safeParse({
        ...definition,
        moves: {
          ...definition.moves,
          guard: { ...definition.moves.guard, resourceCostScaling: { energy: resource(1) } },
        },
      }).success,
    ).toBe(false)
  })
})

describe('percentage modifiers and live scaling', () => {
  it('adds percentages across statuses, scales them with stacks/intensity and applies them after flat modifiers', () => {
    const definition = fixture()
    definition.statuses!.flow = {
      type: 'modifier',
      label: 'Flow',
      description: '',
      duration: 3,
      stacking: { maximum: 3, duration: 'refresh' },
      intensity: { initial: 1, maximum: 3, reapply: 'replace' },
      modifiers: { attack: 2, defense: -1, ap: 1, apCost: 1 },
      percentModifiers: { attack: 50, defense: -25, guard: 50, ap: 25, apCost: -25 },
    }
    const statuses = [{ id: 'flow', source: 'player', remaining: 3, stacks: 2, intensity: 2 }]
    const effects = statusContributions(definition, statuses)
    expect(effects[0]?.percentModifiers).toMatchObject({
      attack: 200,
      defense: -100,
      guard: 200,
      ap: 100,
      apCost: -100,
    })
    expect(
      temporaryCombatStats({ attack: 10, defense: 10, guard: 2, maximumHealth: 80 }, effects),
    ).toEqual({ attack: 54, defense: 0, guard: 6, maximumHealth: 80 })
    const economy = combatActorEconomy(definition, definition.player, statuses)
    expect(economy.ap).toBe(18)
    expect(
      combatActionCost(
        definition.moves.strike!,
        economy,
        combatValueContext(definition, undefined, { player: statuses }, 'player', 'enemy'),
      ),
    ).toBe(1)
    definition.statuses!.other = {
      type: 'modifier',
      label: 'Other',
      description: '',
      duration: 1,
      modifiers: {},
      percentModifiers: { attack: -50 },
    }
    expect(
      temporaryCombatStats(
        { attack: 10, defense: 0, guard: 0, maximumHealth: 80 },
        statusContributions(definition, [
          ...statuses,
          { id: 'other', source: 'player', remaining: 1 },
        ]),
      ).attack,
    ).toBe(45)
  })

  it('matches live damage/healing and cost previews, charging resource costs before evaluating effects', () => {
    const definition = fixture()
    const values = combatValueContext(definition, undefined, active, 'player', 'enemy')
    const effects = statusContributions(definition, active.player)
    const stats = temporaryCombatStats(undefined, effects)
    const strike = definition.moves.strike!

    if (strike.type !== 'ability') throw new Error('Expected strike')
    expect(
      combatActionCost(
        strike,
        combatActorEconomy(definition, definition.player, active.player),
        values,
      ),
    ).toBe(2)
    expect(combatResourceCosts(strike, values)).toEqual({ stamina: 14 })
    expect(combatAbilityEffectValues(strike.effects[0]!, stats, 0, values, effects)).toEqual({
      min: 31,
      max: 31,
    })
    const plain = resolve(definition, ['strike'])
    const trace: CombatDebugFrame[] = []
    expect(resolve(definition, ['strike'], active, trace)).toEqual(plain)
    expect(plain.health.enemy).toBe(59)
    expect(plain.mechanics?.resources.stamina).toBe(36)
    expect(
      trace.find((frame) => frame.kind === 'action' && frame.actor === 'player')?.spentAp,
    ).toBe(2)
    const healed = resolve(definition, ['heal'])
    expect(healed.entries).toContainEqual({
      type: 'healed',
      actor: 'player',
      target: 'player',
      amount: 18,
    })
    expect(healed.health.player).toBe(48)
  })

  it('reevaluates later effects after resource changes rather than using the plan snapshot', () => {
    const definition = fixture()
    const move = definition.moves.strike!

    if (move.type !== 'ability') throw new Error('Expected ability')
    move.effects.unshift({ id: 'drain', type: 'change-resource', resource: 'energy', amount: -20 })
    const result = resolve(definition, ['strike'])
    expect(result.health.enemy).toBe(62)
    expect(result.mechanics?.resources.energy).toBe(30)
  })

  it('rechecks dynamic AP and resource costs after before-action hooks and skips without consuming RNG', () => {
    const definition = fixture()
    definition.player.ap = 3
    definition.mechanics!.triggers.pressure = {
      event: 'before-action',
      actor: 'player',
      move: 'strike',
      once: false,
      conditions: [],
      effects: [{ type: 'set-resource', resource: 'energy', amount: 200 }],
    }
    const result = resolve(definition, ['strike'], { player: [] })
    expect(result.entries).toContainEqual({
      type: 'apUnavailable',
      actor: 'player',
      move: 'strike',
      cost: 6,
      remaining: 3,
    })
    expect(result.mechanics?.resources.stamina).toBe(50)
    expect(result.seed).toBe(1024)
    definition.mechanics!.triggers.pressure!.effects = [
      { type: 'set-resource', resource: 'stamina', amount: 1 },
    ]
    expect(resolve(definition, ['strike'], { player: [] }).entries).toContainEqual({
      type: 'resourceUnavailable',
      actor: 'player',
      resource: 'stamina',
    })
  })

  it('reserves evaluated player costs in planning and reports evaluated AI blockers', () => {
    const definition = fixture()

    const sim = new CombatSimulation(definition, {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      statuses: active,
      resources: { stamina: 27 },
    })

    sim.queue('strike', 'enemy')
    expect(sim.queueIssue('strike', 'enemy')).toBe('Insufficient resource: stamina')
    sim.undo()
    expect(sim.queueIssue('strike', 'enemy')).toBeUndefined()
    definition.enemies[0]!.ai = {
      fallback: 'rotation',
      rules: [{ id: 'scaled', move: 'strike', maxUses: 1, conditions: [] }],
    }

    const ai = new CombatSimulation(definition, {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      resources: { stamina: 9 },
    })

    expect(ai.preview()[0]?.candidates[0]).toMatchObject({
      cost: 3,
      required: 10,
      available: 9,
      resource: 'stamina',
      blockers: ['ap', 'resource'],
    })
    expect(ai.preview()[0]?.choice?.move).toBe('guard')
  })

  it('evaluates target aliases separately for queued plans and preserves snapshots on overflow', () => {
    const definition = fixture()
    definition.moves.guard!.apCostScaling = {
      terms: [{ type: 'status', actor: 'target', status: 'flow', factor: 1 }],
    }
    const ctx = combatValueContext(definition, undefined, active, 'enemy', 'player')
    expect(combatActionCost(definition.moves.guard!, { ap: 5, apCost: 0 }, ctx)).toBe(3)
    const heal = definition.moves.heal!

    if (heal.type !== 'ability' || heal.effects[0]?.type !== 'heal')
      throw new Error('Expected heal')
    heal.effects[0].scaling = resource(10000)
    definition.mechanics!.resources.energy!.initial = Number.MAX_SAFE_INTEGER
    definition.mechanics!.resources.energy!.maximum = Number.MAX_SAFE_INTEGER

    const sim = new CombatSimulation(definition, {
      health: { player: 30, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
    })

    sim.queue('heal')
    const before = sim.report()
    expect(() => sim.resolve()).toThrow('overflow')
    expect(sim.report()).toEqual(before)
  })

  it('uses dynamic healing for item meaningfulness and rejects combat scaling in outside-combat items', () => {
    const definition = fixture()
    const heal = definition.moves.heal!

    if (heal.type !== 'ability' || heal.effects[0]?.type !== 'heal')
      throw new Error('Expected heal')
    heal.effects[0].amount = 0

    const snapshot = {
      health: { player: 30, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      statuses: {},
      guard: {},
      stats: {},
      resources: { energy: 50, stamina: 50 },
    }

    expect(abilityCanMatter(heal, definition, snapshot, 'player')).toBe(true)
    definition.statuses!.noHeal = {
      type: 'modifier',
      label: 'No heal',
      description: '',
      duration: 2,
      modifiers: {},
      percentModifiers: { healing: -100 },
    }
    expect(
      abilityCanMatter(
        heal,
        definition,
        { ...snapshot, statuses: { player: [{ id: 'noHeal', source: 'player', remaining: 2 }] } },
        'player',
      ),
    ).toBe(false)
    heal.resourceCosts = undefined

    const library = combatLibrarySchema.parse({
      'schema-version': '1.0.0',
      id: 'shared',
      moves: { heal },
      statuses: definition.statuses,
    })

    const inventory = inventorySchema.parse({
      'schema-version': '1.0.0',
      id: 'items',
      owners: {},
      items: {},
      itemTypes: {
        potion: {
          label: 'Potion',
          use: { ability: { library: 'shared', id: 'heal' }, contexts: ['outside-combat'] },
        },
      },
    })

    expect(itemUseIssues(inventory, new Map([['shared', library]]))[0]?.message).toContain(
      'fixed, unconditional',
    )
  })

  it('imports scaling-only status dependencies and validates deferred library resources against the encounter', () => {
    const definition = fixture()

    const library = combatLibrarySchema.parse({
      'schema-version': '1.0.0',
      id: 'shared',
      moves: { heal: definition.moves.heal },
      statuses: definition.statuses,
    })

    const source = combatSourceSchema.parse({
      ...definition,
      statuses: undefined,
      moves: { guard: definition.moves.guard, strike: definition.moves.strike },
      sharedMoves: [{ library: 'shared', id: 'heal' }],
    })

    const result = resolveCombatSource(source, new Map([['shared', library]]))
    expect(result.issues).toEqual([])
    expect(result.origins.statuses.flow).toMatchObject({ library: 'shared' })
    source.mechanics!.resources = {}
    expect(
      resolveCombatSource(source, new Map([['shared', library]])).issues.some((issue) =>
        issue.message.includes('Unknown scaling resource'),
      ),
    ).toBe(true)
  })

  it('preserves source extensions while clearing removed formulas, term union fields and percentage modifiers', () => {
    const definition = fixture()

    const before = {
      moves: {
        heal: {
          ...definition.moves.heal,
          effects: [
            {
              id: 'heal',
              type: 'heal',
              amount: 5,
              scaling: {
                extension: 'formula',
                terms: [{ type: 'resource', resource: 'stamina', factor: 1, extension: 'term' }],
              },
            },
          ],
        },
      },
      statuses: {
        flow: {
          ...definition.statuses!.flow,
          percentModifiers: { damage: 25, extension: 'percent' },
        },
      },
    }

    const edited = combatSourceSchema.parse({
      ...definition,
      moves: {
        ...definition.moves,
        heal: {
          ...definition.moves.heal,
          effects: [
            {
              id: 'heal',
              type: 'heal',
              amount: 5,
              scaling: { terms: [{ type: 'status', actor: 'self', status: 'flow', factor: 2 }] },
            },
          ],
        },
      },
    })

    const result = mergeCombatEntries(before, edited)
    expect(result.moves.heal).toMatchObject({
      effects: [
        {
          scaling: {
            extension: 'formula',
            terms: [{ type: 'status', status: 'flow', resource: undefined, extension: 'term' }],
          },
        },
      ],
    })
    const heal = edited.moves.heal!

    if (heal.type !== 'ability' || heal.effects[0]?.type !== 'heal')
      throw new Error('Expected heal')
    heal.effects[0].scaling = undefined
    const flow = edited.statuses!.flow!

    if (flow.type !== 'modifier') throw new Error('Expected modifier')
    flow.percentModifiers = { healing: 10 }
    const cleared = mergeCombatEntries(before, edited)
    expect(cleared.moves.heal?.effects?.[0]?.scaling).toBeUndefined()
    expect(cleared.statuses?.flow?.percentModifiers).toMatchObject({
      damage: undefined,
      healing: 10,
      extension: 'percent',
    })
  })

  it('applies scaling to attack/guard previews and snapshots without changing authored base values', () => {
    const definition = fixture()

    const move = {
      type: 'attack' as const,
      label: 'Attack',
      description: '',
      apCost: 1,
      damage: { min: 2, max: 4 },
      scaling: resource(0.1),
    }

    const ctx = combatValueContext(definition, undefined, {}, 'player', 'enemy')
    expect(combatMoveValues(move, undefined, 1, ctx)).toEqual({ min: 6, max: 8 })
    expect(move.damage).toEqual({ min: 2, max: 4 })
    expect(combatEconomySnapshot(definition, active).moveCosts.player?.strike).toBe(2)
    expect(
      combatResourceIssue(
        definition.moves.strike!,
        { energy: 50, stamina: 13 },
        [],
        {},
        combatValueContext(definition, undefined, active, 'player', 'enemy'),
      ),
    ).toBe('stamina')
  })
})
