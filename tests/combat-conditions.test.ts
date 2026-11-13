import { describe, expect, it } from 'vite-plus/test'
import {
  combatConditionSchema,
  combatConditionIssues,
  combatDefinitionSchema,
  combatLibrarySchema,
  combatSourceSchema,
  bindCombatCondition,
  diffCombatMechanics,
  previewCombatMechanicsOverrides,
  resolveCombatSource,
  type CombatCondition,
  type CombatDefinition,
} from '@ancadeba/schemas'
import {
  combatConditionsMatch,
  evaluateCombatCondition,
  resolveCombatRound,
  CombatSimulation,
  type CombatConditionContext,
  type CombatDebugFrame,
} from '@ancadeba/game-runtime'
import { mergeCombatRuleConditions } from '../packages/editor-core/src/combatRuleEntryEditing.js'

const energy = (value: number, unit?: 'percent'): CombatCondition => ({
  type: 'resource',
  resource: 'energy',
  operator: 'gte',
  value,
  ...(unit ? { unit } : {}),
})

const active: CombatCondition = {
  type: 'status',
  actor: 'self',
  status: 'focus',
  measure: 'stacks',
  operator: 'gte',
  value: 1,
}

const context: CombatConditionContext = {
  health: { player: 20, enemy: 90 },
  maximumHealth: { player: 80, enemy: 90 },
  resources: { energy: 50 },
  resourceMaximums: { energy: 200 },
  statuses: { player: [{ id: 'focus', source: 'player', remaining: 2, stacks: 2, intensity: 3 }] },
  phase: 'opening',
  self: 'player',
  target: 'enemy',
}

function definition(triggers: Record<string, unknown> = {}): CombatDefinition {
  return combatDefinitionSchema.parse({
    'schema-version': '1.0.0',
    id: 'expressions',
    label: 'Expressions',
    player: {
      id: 'player',
      label: 'Player',
      health: { source: 'game.state', path: ['hp'] },
      maximumHealth: 80,
      ap: 4,
      moves: ['act', 'cleanse'],
    },
    enemies: [
      {
        id: 'enemy',
        label: 'Enemy',
        health: { source: 'game.state', path: ['enemy'] },
        maximumHealth: 90,
        ap: 1,
        moves: ['hit', 'guard'],
        rotation: ['guard'],
      },
    ],
    moves: {
      act: {
        type: 'ability',
        label: 'Act',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'focus', type: 'apply-status', status: 'focus' }],
      },
      cleanse: {
        type: 'ability',
        label: 'Cleanse',
        apCost: 1,
        target: 'self',
        effects: [{ id: 'cleanse', type: 'remove-status', status: 'focus', stacks: 1 }],
      },
      hit: { type: 'attack', label: 'Hit', apCost: 1, damage: { min: 2, max: 5 } },
      guard: { type: 'guard', label: 'Guard', apCost: 1, guard: 1 },
    },
    statuses: {
      focus: {
        type: 'modifier',
        label: 'Focus',
        duration: 2,
        modifiers: { defense: 1 },
        stacking: { maximum: 3, duration: 'refresh' },
      },
      stun: { type: 'stun', label: 'Stun', duration: 1 },
      costly: { type: 'modifier', label: 'Costly', duration: 1, modifiers: { apCost: 4 } },
    },
    mechanics: {
      resources: { energy: { initial: 0, maximum: 200 } },
      phases: { opening: { label: 'Opening' } },
      initialPhase: 'opening',
      triggers,
    },
  })
}

function resolve(
  d: CombatDefinition,
  moves = ['act'],
  options: Partial<Parameters<typeof resolveCombatRound>[1]> = {},
  trace?: CombatDebugFrame[],
) {
  return resolveCombatRound(
    d,
    {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 90 },
      guard: {},
      seed: 1024,
      escape: false,
      plan: moves.map((move) => ({ move, target: 'player' })),
      enemies: { enemy: { moves: [], cursor: 0 } },
      ...options,
    },
    trace
      ? (frame) => {
          trace.push(frame)
        }
      : undefined,
  )
}

describe('shared combat expressions', () => {
  it('evaluates nested branches, aliases and all three status measures with an observable tree', () => {
    const condition: CombatCondition = {
      type: 'and',
      conditions: [
        {
          type: 'or',
          conditions: [
            energy(50, 'percent'),
            { type: 'health', actor: 'self', operator: 'lte', value: 25, unit: 'percent' },
          ],
        },
        { type: 'not', condition: { type: 'phase', phase: 'final' } },
        active,
        { ...active, measure: 'intensity', value: 3 },
        { ...active, measure: 'remaining', value: 2 },
      ],
    }

    const result = evaluateCombatCondition(condition, context)
    expect(result.matched).toBe(true)
    expect(result.children?.[0]?.children).toMatchObject([
      { actual: 25, current: 50, maximum: 200, matched: false },
      { actual: 25, matched: true },
    ])
    expect(combatConditionsMatch([condition, energy(50)], context)).toBe(true)
    expect(combatConditionsMatch([condition, energy(51)], context)).toBe(false)
    expect(combatConditionsMatch(undefined, context)).toBe(true)
    expect(combatConditionsMatch([{ ...active, actor: 'target', value: 0 }], context)).toBe(true)
  })

  it('compares percentages exactly at fractional boundaries and safe integer maxima', () => {
    const c = { ...context, resources: { energy: 1 }, resourceMaximums: { energy: 3 } }
    expect(evaluateCombatCondition(energy(33.33, 'percent'), c).matched).toBe(true)
    expect(evaluateCombatCondition(energy(33.34, 'percent'), c).matched).toBe(false)
    const maximum = Number.MAX_SAFE_INTEGER

    const large = {
      ...c,
      resources: { energy: maximum - 1 },
      resourceMaximums: { energy: maximum },
    }

    expect(evaluateCombatCondition(energy(100, 'percent'), large).matched).toBe(false)
    expect(evaluateCombatCondition(energy(99.99, 'percent'), large).matched).toBe(true)
    expect(
      evaluateCombatCondition(energy(100, 'percent'), { ...large, resources: { energy: maximum } })
        .matched,
    ).toBe(true)
  })

  it('does not turn missing context or a zero maximum into a successful NOT', () => {
    const missing = { ...context, resources: {}, maximumHealth: {}, phase: undefined }
    const unknown: CombatCondition = { type: 'not', condition: energy(10) }
    expect(evaluateCombatCondition(unknown, missing)).toMatchObject({
      available: false,
      matched: false,
    })
    expect(
      evaluateCombatCondition(energy(0, 'percent'), {
        ...context,
        resourceMaximums: { energy: 0 },
      }),
    ).toMatchObject({ available: false, matched: false })
    expect(
      evaluateCombatCondition({ type: 'or', conditions: [unknown, active] }, missing).matched,
    ).toBe(true)
    expect(
      evaluateCombatCondition({ type: 'and', conditions: [unknown, energy(100)] }, context),
    ).toMatchObject({ available: true, matched: false })
    expect(
      evaluateCombatCondition({ type: 'not', condition: { ...active, actor: 'missing' } }, context)
        .matched,
    ).toBe(false)
  })

  it('validates threshold bounds, group bounds and cyclic input before recursive parsing', () => {
    for (const value of [-1, 100.01, 33.333])
      expect(combatConditionSchema.safeParse(energy(value, 'percent')).success).toBe(false)
    expect(combatConditionSchema.safeParse(energy(0.5)).success).toBe(false)
    expect(combatConditionSchema.safeParse(energy(33.33, 'percent')).success).toBe(true)
    expect(combatConditionSchema.safeParse({ type: 'and', conditions: [] }).success).toBe(false)
    expect(
      combatConditionSchema.safeParse({
        type: 'or',
        conditions: Array.from({ length: 21 }, () => energy(1)),
      }).success,
    ).toBe(false)
    let deep: CombatCondition = energy(1)

    for (let i = 0; i < 8; i++) deep = { type: 'not', condition: deep }
    expect(combatConditionSchema.safeParse(deep).success).toBe(false)
    const cyclic = { type: 'not' }
    Object.assign(cyclic, { condition: cyclic })
    expect(combatConditionSchema.safeParse(cyclic).success).toBe(false)

    const many = {
      type: 'and',
      conditions: Array.from({ length: 20 }, () => ({
        type: 'or',
        conditions: Array.from({ length: 5 }, () => energy(1)),
      })),
    }

    expect(combatConditionSchema.safeParse(many).success).toBe(false)
  })

  it('binds and validates references recursively with precise diagnostic paths', () => {
    const condition: CombatCondition = {
      type: 'not',
      condition: { type: 'or', conditions: [{ ...active, actor: 'swimmer' }, energy(1)] },
    }

    const bound = bindCombatCondition(condition, (id) => (id === 'swimmer' ? 'player' : id))
    expect(
      combatConditionIssues(bound, { actors: ['player'], resources: {}, statuses: {} }),
    ).toEqual([
      { path: ['condition', 'conditions', 0, 'status'], message: 'Unknown combat status: focus' },
      {
        path: ['condition', 'conditions', 1, 'resource'],
        message: 'Unknown combat resource: energy',
      },
    ])
    expect(condition).toMatchObject({ condition: { conditions: [{ actor: 'swimmer' }, {}] } })
  })

  it('preserves nested extension data and clears stale union fields when saving expressions', () => {
    const old = [
      {
        type: 'and',
        extension: 'root',
        conditions: [
          { type: 'resource', resource: 'energy', unit: 'percent', value: 10, extension: 'leaf' },
        ],
      },
    ]

    const merged = mergeCombatRuleConditions(old, [
      { type: 'and', conditions: [{ type: 'phase', phase: 'opening' }] },
    ])

    expect(JSON.parse(JSON.stringify(merged))).toEqual([
      {
        type: 'and',
        extension: 'root',
        conditions: [{ type: 'phase', phase: 'opening', extension: 'leaf' }],
      },
    ])
    expect(
      JSON.parse(
        JSON.stringify(mergeCombatRuleConditions(merged, [{ type: 'not', condition: active }])),
      ),
    ).toEqual([{ type: 'not', extension: 'root', condition: active }])
  })
})

describe('combat lifecycle hooks and conditional effects', () => {
  it('checks each ability effect against changes made by earlier effects', () => {
    const d = definition()
    const act = d.moves.act!

    if (act.type !== 'ability') throw new Error('Expected ability')
    act.effects.push({
      id: 'gain',
      type: 'change-resource',
      resource: 'energy',
      amount: 50,
      conditions: [
        { type: 'and', conditions: [active, { type: 'not', condition: energy(25, 'percent') }] },
      ],
    })
    const trace: CombatDebugFrame[] = []
    const result = resolve(d, ['act', 'act'], {}, trace)
    expect(result.mechanics?.resources.energy).toBe(50)
    expect(result.statuses.player?.[0]?.stacks).toBe(2)
    expect(resolve(d, ['act', 'act'])).toEqual(result)
  })

  it('runs before-action, ability/status hooks, legacy action-resolved, then after-action in order', () => {
    const d = definition({
      before: {
        event: 'before-action',
        actor: 'player',
        move: 'act',
        effects: [{ type: 'change-resource', resource: 'energy', amount: 10 }],
      },
      applied: {
        event: 'status-applied',
        status: 'focus',
        conditions: [active],
        effects: [{ type: 'change-resource', resource: 'energy', amount: 20 }],
      },
      after: {
        event: 'after-action',
        move: 'act',
        conditions: [energy(30)],
        effects: [{ type: 'change-resource', resource: 'energy', amount: 40 }],
      },
    })

    const trace: CombatDebugFrame[] = []
    const result = resolve(d, ['act'], {}, trace)
    expect(result.mechanics?.resources.energy).toBe(70)

    const events = trace.flatMap((frame) =>
      frame.mechanicsEvent && !frame.mechanicsEvent.trigger ? [frame.mechanicsEvent.event] : [],
    )

    expect(events.indexOf('before-action')).toBeLessThan(events.indexOf('status-applied'))
    expect(events.indexOf('status-applied')).toBeLessThan(events.indexOf('status-changed'))
    expect(events.indexOf('status-changed')).toBeLessThan(events.indexOf('action-resolved'))
    expect(events.indexOf('action-resolved')).toBeLessThan(events.indexOf('after-action'))
    expect(
      trace.find((frame) => frame.mechanicsEvent?.trigger === 'after')?.mechanicsEvent,
    ).toMatchObject({ matched: true, conditions: [{ actual: 30, matched: true }] })
  })

  it.each(['costly', 'stun'])(
    'rechecks %s after before-action without spending costs, cooldown or RNG',
    (status) => {
      const d = definition({
        block: {
          event: 'before-action',
          actor: 'player',
          move: 'act',
          effects: [{ type: 'apply-status', actor: 'player', status }],
        },
      })

      d.moves.act!.resourceCosts = { energy: 10 }
      d.moves.act!.cooldown = 2

      const result = resolve(d, ['act'], {
        mechanics: { resources: { energy: 50 }, phase: 'opening', fired: [], initialized: true },
      })

      expect(result.mechanics?.resources.energy).toBe(50)
      expect(result.seed).toBe(1024)
      expect(result.cooldowns.player?.act).toBeUndefined()
      expect(result.statuses.player?.some((s) => s.id === 'focus')).toBe(false)
      expect(
        result.entries.some(
          (entry) => entry.type === (status === 'stun' ? 'stunned' : 'apUnavailable'),
        ),
      ).toBe(true)
    },
  )

  it('rechecks resource affordability after before-action and skips successful-action hooks when blocked', () => {
    const d = definition({
      spend: {
        event: 'before-action',
        move: 'act',
        effects: [{ type: 'set-resource', resource: 'energy', amount: 0 }],
      },
      after: {
        event: 'after-action',
        move: 'act',
        once: true,
        effects: [{ type: 'set-resource', resource: 'energy', amount: 200 }],
      },
    })

    d.moves.act!.resourceCosts = { energy: 10 }

    const result = resolve(d, ['act'], {
      mechanics: { resources: { energy: 50 }, phase: 'opening', fired: [], initialized: true },
    })

    expect(result.entries).toContainEqual({
      type: 'resourceUnavailable',
      actor: 'player',
      resource: 'energy',
    })
    expect(result.mechanics?.fired).toEqual([])
  })

  it('distinguishes status application, refresh, partial removal, full removal and no-op removal', () => {
    const d = definition()
    d.player.ap = 6
    const trace: CombatDebugFrame[] = []
    resolve(d, ['act', 'act', 'cleanse', 'cleanse', 'cleanse'], {}, trace)

    const events = trace.flatMap((frame) =>
      frame.mechanicsEvent?.status === 'focus' ? [frame.mechanicsEvent.event] : [],
    )

    expect(events).toEqual([
      'status-applied',
      'status-changed',
      'status-refreshed',
      'status-changed',
      'status-changed',
      'status-removed',
      'status-changed',
    ])
  })

  it('emits duration changes and expiry after removal, with no removal-hook double count', () => {
    const d = definition({
      expired: {
        event: 'status-expired',
        status: 'focus',
        effects: [
          {
            type: 'change-resource',
            resource: 'energy',
            amount: 10,
            conditions: [{ type: 'not', condition: active }],
          },
        ],
      },
      removed: {
        event: 'status-removed',
        status: 'focus',
        once: true,
        effects: [{ type: 'change-resource', resource: 'energy', amount: 100 }],
      },
    })

    const trace: CombatDebugFrame[] = []

    const result = resolve(
      d,
      [],
      { statuses: { player: [{ id: 'focus', source: 'player', remaining: 1 }] } },
      trace,
    )

    expect(result.mechanics?.resources.energy).toBe(10)
    expect(result.mechanics?.fired).toEqual([])
    expect(result.statuses.player).toEqual([])
    const longer: CombatDebugFrame[] = []
    resolve(
      d,
      [],
      { statuses: { player: [{ id: 'focus', source: 'player', remaining: 2 }] } },
      longer,
    )
    expect(
      longer.find((frame) => frame.mechanicsEvent?.event === 'status-changed')?.statuses.player?.[0]
        ?.remaining,
    ).toBe(1)
  })

  it('rejects cyclic hooks without mutating the caller state', () => {
    const d = definition({
      apply: {
        event: 'status-removed',
        status: 'focus',
        effects: [{ type: 'apply-status', actor: 'player', status: 'focus' }],
      },
      remove: {
        event: 'status-applied',
        status: 'focus',
        effects: [{ type: 'remove-status', actor: 'player', status: 'focus' }],
      },
    })

    const statuses = { player: [{ id: 'focus', source: 'player', remaining: 1 }] }
    expect(() => resolve(d, ['cleanse'], { statuses })).toThrow(
      'Combat trigger operation limit exceeded',
    )
    expect(statuses.player).toEqual([{ id: 'focus', source: 'player', remaining: 1 }])
  })

  it('uses effective health maxima for nested AI preview and live decisions', () => {
    const d = definition()
    d.enemies[0]!.ai = {
      fallback: 'wait',
      rules: [
        {
          id: 'hurt',
          move: 'hit',
          maxUses: 1,
          conditions: [
            {
              type: 'or',
              conditions: [
                { type: 'health', actor: 'self', operator: 'lte', value: 50, unit: 'percent' },
                energy(100),
              ],
            },
          ],
        },
      ],
    }

    const sim = new CombatSimulation(d, {
      health: { player: 80, enemy: 90 },
      maximumHealth: { player: 80, enemy: 200 },
    })

    const decision = sim.preview()[0]!
    expect(decision.choice?.move).toBe('hit')
    expect(decision.candidates[0]?.conditions[0]?.children?.[0]).toMatchObject({
      actual: 45,
      maximum: 200,
      matched: true,
    })
    sim.resolve()
    expect(sim.snapshot().health.player).toBeLessThan(80)
  })

  it('resolves the target alias to the selected AI move recipient', () => {
    const d = definition()
    d.enemies[0]!.moves.push('act')
    d.enemies[0]!.ai = {
      fallback: 'wait',
      rules: [
        {
          id: 'self-heal',
          move: 'act',
          maxUses: 1,
          conditions: [
            { type: 'health', actor: 'target', operator: 'lte', value: 50, unit: 'percent' },
          ],
        },
      ],
    }

    const sim = new CombatSimulation(d, {
      health: { player: 80, enemy: 40 },
      maximumHealth: { player: 80, enemy: 90 },
    })

    expect(sim.preview()[0]!.choice).toEqual({ move: 'act', target: 'enemy' })
  })

  it('imports nested status dependencies and binds ruleset/profile actors without flattening expressions', () => {
    const d = definition()

    const library = combatLibrarySchema.parse({
      'schema-version': '1.0.0',
      id: 'shared',
      moves: d.moves,
      statuses: d.statuses,
      rulesets: {
        water: {
          actors: ['swimmer'],
          mechanics: {
            ...d.mechanics,
            triggers: {
              hook: {
                event: 'before-action',
                actor: 'swimmer',
                conditions: [{ type: 'not', condition: { ...active, actor: 'swimmer' } }],
                effects: [{ type: 'change-resource', resource: 'energy', amount: 10 }],
              },
            },
          },
        },
      },
      aiProfiles: {
        hunter: {
          actors: ['swimmer'],
          ai: {
            rules: [
              {
                id: 'check',
                move: 'guard',
                conditions: [{ type: 'and', conditions: [{ ...active, actor: 'swimmer' }] }],
              },
            ],
          },
        },
      },
    })

    const source = combatSourceSchema.parse({
      ...d,
      mechanics: undefined,
      statuses: undefined,
      ruleset: { library: 'shared', id: 'water', actors: { swimmer: 'player' } },
      enemies: [
        {
          ...d.enemies[0],
          aiProfile: { library: 'shared', id: 'hunter', actors: { swimmer: 'player' } },
        },
      ],
    })

    const result = resolveCombatSource(source, new Map([['shared', library]]))
    expect(result.issues).toEqual([])
    expect(result.definition?.statuses?.focus).toBeDefined()
    expect(result.definition?.mechanics?.triggers.hook?.conditions[0]).toMatchObject({
      type: 'not',
      condition: { actor: 'player' },
    })
    expect(result.definition?.enemies[0]?.ai?.rules[0]?.conditions[0]).toMatchObject({
      type: 'and',
      conditions: [{ actor: 'player' }],
    })
  })

  it('round trips sparse lifecycle status-filter and nested-condition overrides', () => {
    const d = definition({
      check: {
        event: 'status-applied',
        status: 'focus',
        effects: [{ type: 'set-resource', resource: 'energy', amount: 10 }],
      },
    })

    const changed = previewCombatMechanicsOverrides(d.mechanics!, {
      triggers: {
        check: { status: null, conditions: [{ type: 'not', condition: energy(50, 'percent') }] },
      },
    })

    const patch = diffCombatMechanics(d.mechanics!, changed)
    expect(patch.triggers?.check).toMatchObject({
      status: null,
      conditions: [{ type: 'not', condition: energy(50, 'percent') }],
    })
    expect(previewCombatMechanicsOverrides(d.mechanics!, patch)).toEqual(changed)
  })
})
