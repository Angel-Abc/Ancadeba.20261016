import { combatPassiveSourceSchema } from './combatPassiveReferences.js'
import { combatConditionSchema } from './combatConditions.js'
import { combatDamageTypeSchema } from './combatDamage.js'
import { z } from 'zod'
import { combatMechanicsStateSchema } from './combatMechanics.js'
import { combatStatusStrengthSchema } from './combatAbilities.js'
import { gameIdSchema } from './game.js'
import { inventorySchema } from './inventory.js'
import { mapPositionSchema } from './map.js'

const id = gameIdSchema.refine(
  (value) => !['__proto__', 'prototype', 'constructor'].includes(value),
)

const counter = z.number().int().nonnegative().safe()
const scalar = z.union([z.string(), z.number().finite(), z.boolean()])
const record = <T extends z.ZodType>(value: T) => z.record(id, value)

const plannedMove = z.strictObject({
  move: id,
  target: id,
  item: id.optional(),
  itemType: id.optional(),
  consume: z.boolean().optional(),
})

const logEntry = z.strictObject({
  type: z.enum([
    'itemUsed',
    'itemSkipped',
    'attack',
    'guarded',
    'skipped',
    'healed',
    'statusApplied',
    'statusRefreshed',
    'statusRemoved',
    'statusExpired',
    'periodicDamage',
    'regenerated',
    'stunned',
    'victory',
    'defeat',
    'escaped',
    'resourceChanged',
    'resourceUnavailable',
    'phaseChanged',
    'statusReduced',
    'apUnavailable',
    'statusImmune',
    'resourceAdjusted',
    'moveRestricted',
    'requirementsUnavailable',
    'passiveTriggered',
    'effectIntercepted',
  ]),
  passive: combatPassiveSourceSchema.optional(),
  trigger: id.optional(),
  item: id.optional(),
  actor: id.optional(),
  target: id.optional(),
  status: id.optional(),
  damage: counter.optional(),
  damageType: combatDamageTypeSchema.optional(),
  category: id.optional(),
  requirements: z.array(combatConditionSchema).max(20).optional(),
  interception: z
    .enum(['adjust-effect', 'absorb-damage', 'redirect-damage', 'prevent-lethal'])
    .optional(),
  redirectTarget: id.optional(),
  redirected: z.boolean().optional(),
  originalTarget: id.optional(),
  incomingAmount: counter.optional(),
  absorbed: counter.optional(),
  prevented: counter.optional(),
  redirectedAmount: counter.optional(),
  requested: counter.optional(),
  equipment: z.array(id).max(100).optional(),
  resistance: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  vulnerability: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  immune: z.boolean().optional(),
  reactive: z.boolean().optional(),
  resisted: counter.optional(),
  amplified: counter.optional(),
  rawDamage: counter.optional(),
  typeDamage: counter.optional(),
  blocked: counter.optional(),
  defended: counter.optional(),
  guard: counter.optional(),
  amount: counter.optional(),
  duration: counter.optional(),
  resource: id.optional(),
  phase: id.optional(),
  move: id.optional(),
  cost: counter.optional(),
  remaining: counter.optional(),
  stacks: combatStatusStrengthSchema.optional(),
  intensity: combatStatusStrengthSchema.optional(),
})

export const savedCombatSchema = z.strictObject({
  mechanics: combatMechanicsStateSchema.optional(),
  round: counter.min(1),
  seed: counter.max(0xffffffff),
  started: z.boolean(),
  guard: record(counter),
  plan: z.array(plannedMove).max(1000),
  enemies: record(
    z.strictObject({
      moves: z.array(plannedMove).max(1000),
      cursor: counter,
      startCursor: counter,
    }),
  ),
  statuses: record(
    z
      .array(
        z.strictObject({
          id,
          source: id,
          remaining: counter.min(1),
          stacks: combatStatusStrengthSchema.optional(),
          intensity: combatStatusStrengthSchema.optional(),
        }),
      )
      .max(1000),
  ),
  cooldowns: record(record(counter)),
  escape: z.boolean(),
  outcome: z.enum(['victory', 'defeat', 'escaped']).optional(),
  target: id.optional(),
  log: z.array(logEntry).max(10000),
})

export const savedRewardsSchema = z.strictObject({
  numeric: z.array(z.strictObject({ id, path: z.array(id).min(1), amount: counter })),
  items: inventorySchema.shape.items,
  delivered: z.boolean(),
  taken: z.array(id),
})

export const savedDialogueSchema = z.strictObject({
  dialogue: id,
  node: id,
  page: counter,
  version: counter,
  finished: z.boolean(),
  transcript: z
    .array(
      z.strictObject({
        node: id,
        line: counter.optional(),
        choice: id.optional(),
        values: z.array(z.tuple([z.string(), scalar])),
      }),
    )
    .max(1000),
})

export const messageHistoryCapacity = 200

const messageHistoryEntrySchema = z.strictObject({
  kind: z.enum(['narration', 'dialogue', 'choice']),
  text: z.string(),
})

export type MessageHistoryEntry = Readonly<z.infer<typeof messageHistoryEntrySchema>>

export const gameSaveSchema = z.strictObject({
  'save-version': z.literal(1),
  slotName: z.string().trim().max(80).optional(),
  gameId: gameIdSchema,
  gameVersion: z.string().min(1),
  contentVersion: z.string().min(1),
  scene: id,
  language: z.string().optional(),
  inputContext: id.optional(),
  state: z.array(z.strictObject({ path: z.array(id).min(1), value: scalar })),
  log: z.array(z.string()),
  messageHistory: z.array(messageHistoryEntrySchema).max(messageHistoryCapacity),
  inventory: inventorySchema.shape.items,
  craftingSequence: counter.optional(),
  progression: z.strictObject({ turn: counter, worldTimeMs: z.number().finite().nonnegative() }),
  combat: record(savedCombatSchema),
  rewards: record(savedRewardsSchema),
  leveling: record(
    z.strictObject({
      from: counter.min(1),
      to: counter.min(1),
      gains: z.array(z.strictObject({ level: counter.min(1), id, amount: counter })),
    }),
  ),
  quests: z.strictObject({
    records: record(z.strictObject({ index: counter, completed: z.boolean() })),
    tracked: id.optional(),
  }),
  dialogue: z.record(z.string(), savedDialogueSchema),
  /** Per-playthrough positions keyed by scene ID, then map-view component ID. */
  mapPositions: record(record(mapPositionSchema)),
  mapObjectPositions: record(
    record(
      z.strictObject({
        position: mapPositionSchema,
        routeIndex: z.number().int().min(-1),
        departed: z.literal(true).optional(),
        encounterComplete: z.literal(true).optional(),
        sighted: z.literal(true).optional(),
        warning: z.enum(['armed', 'fired']).optional(),
        turnsElapsed: counter.positive().optional(),
        guardPosition: mapPositionSchema.optional(),
        direction: z.union([z.literal(1), z.literal(-1)]),
        remainingMs: z.number().finite().nonnegative().optional(),
      }),
    ),
  ).optional(),
  playerLocation: z.strictObject({ map: gameIdSchema, position: mapPositionSchema }).optional(),
  nearby: record(id),
  inventorySelection: record(id),
  activeDialogue: id.optional(),
})

export type GameSave = z.infer<typeof gameSaveSchema>

export type SavedMapPositions = GameSave['mapPositions']

export type SavedCombat = z.infer<typeof savedCombatSchema>

export type SavedRewards = z.infer<typeof savedRewardsSchema>

export type SavedDialogue = z.infer<typeof savedDialogueSchema>
