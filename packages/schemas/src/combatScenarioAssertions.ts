import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import { combatEffectDeliveries, combatInterceptionEffectTypes } from './combatEvents.js'

const id = bindingAliasSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
)

const comparison = {
  operator: z.enum(['eq', 'gte', 'lte', 'gt', 'lt']),
  value: z.number().int().nonnegative().safe(),
}

const scope = { scope: z.enum(['scenario', 'step']).optional() }
const participants = { source: id.optional(), target: id.optional(), move: id.optional() }

const passive = {
  actor: id.optional(),
  library: id.optional(),
  passive: id.optional(),
  trigger: id.optional(),
  sourceKind: z.enum(['equipment', 'status']).optional(),
  sourceId: id.optional(),
}

export const combatScenarioRichAssertionSchemas = [
  z.object({ type: z.literal('passive-activations'), ...comparison, ...scope, ...passive }),
  z.object({
    type: z.literal('interception'),
    ...comparison,
    ...scope,
    source: id.optional(),
    target: id.optional(),
    operation: z.enum(combatInterceptionEffectTypes).optional(),
    resource: id.optional(),
    trigger: id.optional(),
    measure: z.enum(['count', 'amount', 'spent']).optional(),
  }),
  z.object({
    type: z.literal('damage-total'),
    ...comparison,
    ...scope,
    ...participants,
    damageType: id.optional(),
    delivery: z.enum(combatEffectDeliveries).optional(),
    measure: z.enum(['amount', 'count', 'absorbed', 'prevented', 'redirectedAmount']).optional(),
  }),
  z.object({
    type: z.literal('healing-total'),
    ...comparison,
    ...scope,
    ...participants,
    delivery: z.enum(combatEffectDeliveries).optional(),
    measure: z.enum(['amount', 'count', 'overheal']).optional(),
  }),
  z.object({
    type: z.literal('action-choices'),
    ...comparison,
    ...scope,
    actor: id.optional(),
    move: id.optional(),
    target: id.optional(),
    rule: id.optional(),
    result: z.enum(['chosen', 'executed']).optional(),
  }),
  z.object({
    type: z.literal('cooldown'),
    ...comparison,
    actor: id,
    move: id,
    measure: z.enum(['remaining', 'readyRound']).optional(),
  }),
  z.object({
    type: z.literal('trigger-cooldown'),
    ...comparison,
    ...passive,
    trigger: id,
    measure: z.enum(['remaining', 'readyRound']).optional(),
  }),
  z.object({
    type: z.literal('item-consumption'),
    ...comparison,
    ...scope,
    item: id.optional(),
    itemType: id.optional(),
  }),
] as const

export type CombatScenarioRichAssertion = z.infer<
  (typeof combatScenarioRichAssertionSchemas)[number]
>

export const combatScenarioRichAssertionTypes = [
  'passive-activations',
  'interception',
  'damage-total',
  'healing-total',
  'action-choices',
  'cooldown',
  'trigger-cooldown',
  'item-consumption',
] as const
