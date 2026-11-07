import { z } from 'zod'
import { gameIdSchema } from './game.js'
import { gameBindingSchema } from './bindings.js'
import { translationKeySchema } from './languages.js'

export const itemUseTextSchema = z.object({
  unavailable: z.string().default('Item use is unavailable.'),
  selection: z.string().default('Select a usable item.'),
  readOnly: z.string().default('This inventory is read only.'),
  reserved: z.string().default('This item is reserved by a combat plan.'),
  equipped: z.string().default('Unequip this item before using it.'),
  container: z.string().default('Empty this container before using it.'),
  disabled: z.string().default('This item cannot be used right now.'),
  owner: z.string().default('This item does not belong to the combat player.'),
  context: z.string().default('This item is unavailable in this context.'),
  paused: z.string().default('Return to the unfinished encounter to use this item.'),
  noEffect: z.string().default('This item would have no effect.'),
  target: z.string().default('Select a living target.'),
  ap: z.string().default('Not enough AP.'),
  used: z.string().default('Used {item}: restored {amount} health.'),
  details: z.string().default('{ability} · {consumption} · {contexts}'),
  cost: z.string().default('{ap} AP · cooldown {cooldown} rounds'),
  consume: z.string().default('Consumable'),
  keep: z.string().default('Reusable'),
  combat: z.string().default('Combat'),
  outside: z.string().default('Outside combat'),
})

export const itemUseSchema = z.object({
  ability: z.object({
    library: gameIdSchema,
    id: gameIdSchema.refine(
      (id) => !['__proto__', 'constructor', 'prototype'].includes(id),
      'Reserved ability identifier',
    ),
  }),
  consumption: z.enum(['consume', 'keep']).default('consume'),
  contexts: z
    .array(z.enum(['combat', 'outside-combat']))
    .min(1)
    .refine((values) => new Set(values).size === values.length),
  enabledWhen: gameBindingSchema.optional(),
  messages: itemUseTextSchema.prefault({}),
  messageKeys: z
    .partialRecord(z.enum(itemUseTextSchema.keyof().options), translationKeySchema)
    .default({}),
})

export const combatItemUseSchema = z.object({
  owner: gameIdSchema,
  itemTypes: z
    .array(gameIdSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length),
})

export type ItemUseDefinition = z.infer<typeof itemUseSchema>
