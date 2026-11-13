import { z } from 'zod'
import { bindingAliasSchema } from './bindings.js'
import { combatPassiveSourceSchema } from './combatPassiveReferences.js'

export const combatTriggerControlFields = {
  priority: z.number().int().min(-10000).max(10000).optional(),
  charges: z.number().int().min(1).max(10000).optional(),
  perTurn: z.number().int().min(1).max(10000).optional(),
  cooldown: z.number().int().min(0).max(1000).optional(),
}

const counter = z.number().int().nonnegative().safe()

export const combatTriggerActivationSchema = z.strictObject({
  trigger: bindingAliasSchema.refine(
    (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
  ),
  passive: combatPassiveSourceSchema.optional(),
  uses: counter.positive(),
  turn: counter,
  turnUses: counter.positive(),
  readyRound: counter,
})

export type CombatTriggerActivation = z.infer<typeof combatTriggerActivationSchema>
