import { combatScenarioRichAssertionSchemas } from './combatScenarioAssertions.js'
import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import { combatSimulationLoadoutSchema } from './combatEquipment.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  'Reserved combat identifier',
)

const amount = z.number().int().nonnegative().safe()
const comparison = { operator: z.enum(['eq', 'gte', 'lte', 'gt', 'lt']), value: amount }

export const combatScenarioExpectationSchema = z.discriminatedUnion('type', [
  ...combatScenarioRichAssertionSchemas,
  z.object({
    type: z.literal('outcome'),
    value: z.enum(['planning', 'victory', 'defeat', 'escaped']),
  }),
  z.object({ type: z.literal('phase'), value: id }),
  z.object({ type: z.literal('health'), actor: id, ...comparison }),
  z.object({ type: z.literal('guard'), actor: id, ...comparison }),
  z.object({ type: z.literal('resource'), resource: id, ...comparison }),
  z.object({
    type: z.literal('status'),
    actor: id,
    status: id,
    measure: z.enum(['stacks', 'intensity', 'remaining']).default('stacks'),
    ...comparison,
  }),
  z.object({ type: z.literal('rounds'), ...comparison }),
  z.object({ type: z.literal('trigger'), trigger: id, fired: z.boolean() }),
])

export const combatScenarioSetupSchema = z.object({
  loadout: combatSimulationLoadoutSchema.optional(),
  seed: z.number().int().min(1).max(0xffffffff).default(1),
  round: z.number().int().positive().safe().default(1),
  health: z.record(id, amount).default({}),
  resources: z.record(id, amount).default({}),
  phase: id.optional(),
  statuses: z
    .record(
      id,
      z
        .array(
          z.object({
            id,
            source: id,
            remaining: amount.positive(),
            stacks: z.number().int().min(1).max(100).optional(),
            intensity: z.number().int().min(1).max(100).optional(),
          }),
        )
        .max(100),
    )
    .default({}),
  cooldowns: z.record(id, z.record(id, amount)).default({}),
})

export const combatScenarioStepSchema = z.object({
  id,
  plan: z
    .array(z.object({ move: id, target: id.optional(), item: id.optional() }))
    .max(100)
    .default([]),
  repeat: z.number().int().min(1).max(100).default(1),
  escape: z.boolean().default(false),
  unavailable: z.enum(['fail', 'skip']).default('fail'),
  expect: z.array(combatScenarioExpectationSchema).max(100).default([]),
})

export const combatSimulationScenarioSchema = z
  .object({
    label: z.string().default(''),
    description: z.string().default(''),
    setup: combatScenarioSetupSchema.prefault({}),
    steps: z.array(combatScenarioStepSchema).min(1).max(100),
    expect: z.array(combatScenarioExpectationSchema).max(100).default([]),
  })
  .superRefine((scenario, context) => {
    if (new Set(scenario.steps.map((step) => step.id)).size !== scenario.steps.length)
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'Scenario step IDs must be unique',
      })

    if (scenario.steps.reduce((sum, step) => sum + step.repeat, 0) > 1000)
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'Scenarios support at most 1000 rounds',
      })

    if (!scenario.expect.length && !scenario.steps.some((step) => step.expect.length))
      context.addIssue({
        code: 'custom',
        path: ['expect'],
        message: 'Add at least one expected result',
      })
  })

export type CombatSimulationScenario = z.infer<typeof combatSimulationScenarioSchema>

export type CombatScenarioExpectation = z.infer<typeof combatScenarioExpectationSchema>
