import { z } from 'zod'
import { gameIdSchema } from './game.js'
import { gameBindingSchema, textBindingsSchema, textPlaceholders } from './bindings.js'
import { translationKeySchema } from './languages.js'
import { ruleTextSchema, ruleValueSchema } from './rules.js'
import { numericRewardSchema } from './combatRewards.js'
import { colorSchema } from './assets.js'
import { worldConditionSchema, storyPathSchema } from './storyConditions.js'

const id = gameIdSchema.refine(
  (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
)

const presentation = {
  label: z.string().default(''),
  labelKey: translationKeySchema.optional(),
  description: z.string().default(''),
  descriptionKey: translationKeySchema.optional(),
}

const conditions = z.array(worldConditionSchema).max(100).default([])

export const storyEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set-state'), path: storyPathSchema, value: ruleValueSchema }),
  z.object({ type: z.literal('append-log'), text: ruleTextSchema }),
  z.object({ type: z.literal('start-quest'), quest: id }),
  z.object({ type: z.literal('complete-quest'), quest: id }),
])

export const dialogueChoiceSchema = z
  .object({
    id,
    ...presentation,
    visibleWhen: conditions,
    when: conditions,
    unavailableText: ruleTextSchema.optional(),
    effects: z.array(storyEffectSchema).max(100).default([]),
    next: id.optional(),
    end: z.boolean().default(false),
    scene: gameIdSchema.optional(),
  })
  .superRefine((choice, context) => {
    if (!choice.label && !choice.labelKey)
      context.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'A choice label or translation is required',
      })

    if (Boolean(choice.next) === choice.end)
      context.addIssue({
        code: 'custom',
        path: ['next'],
        message: 'Choose one destination node or an explicit ending',
      })
  })

export const dialogueLineSchema = z
  .object({
    speaker: ruleTextSchema.optional(),
    text: ruleTextSchema,
    bindings: textBindingsSchema.optional(),
  })
  .superRefine((line, context) => {
    if (line.bindings === undefined || typeof line.text !== 'string') return

    for (const { alias } of textPlaceholders(line.text))
      if (!Object.hasOwn(line.bindings, alias))
        context.addIssue({
          code: 'custom',
          path: ['text'],
          message: `Undeclared dialogue text binding: ${alias}`,
        })
  })

export const dialogueNodeSchema = z
  .object({
    lines: z.array(dialogueLineSchema).max(100).default([]),
    choices: z.array(dialogueChoiceSchema).max(100).default([]),
    terminal: z.boolean().default(false),
  })
  .superRefine((node, context) => {
    if (new Set(node.choices.map((choice) => choice.id)).size !== node.choices.length)
      context.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'Choice IDs must be unique within a node',
      })

    if (node.terminal && node.choices.length)
      context.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'Terminal nodes cannot contain choices',
      })
  })

export const dialogueTextSchema = z.object({
  player: z.string().default('You'),
  unavailable: z.string().default('This choice is unavailable.'),
  missingBinding: z.string().default('Some dialogue values are unavailable.'),
})

export const dialogueSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id,
    ...presentation,
    entry: id,
    nodes: z.record(id, dialogueNodeSchema),
    transcriptCapacity: z.number().int().positive().max(1000).default(100),
    messages: dialogueTextSchema.prefault({}),
    messageKeys: z
      .partialRecord(z.enum(dialogueTextSchema.keyof().options), translationKeySchema)
      .default({}),
  })
  .superRefine((dialogue, context) => {
    if (!dialogue.label && !dialogue.labelKey)
      context.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'A dialogue label or translation is required',
      })

    if (!Object.hasOwn(dialogue.nodes, dialogue.entry))
      context.addIssue({ code: 'custom', path: ['entry'], message: 'Unknown entry node' })

    for (const [node, value] of Object.entries(dialogue.nodes))
      value.choices.forEach((choice, index) => {
        if (choice.next && !Object.hasOwn(dialogue.nodes, choice.next))
          context.addIssue({
            code: 'custom',
            path: ['nodes', node, 'choices', index, 'next'],
            message: 'Unknown dialogue node',
          })
      })
  })

export const questObjectiveSchema = z
  .object({
    id,
    ...presentation,
    when: conditions,
    progress: z
      .object({ binding: gameBindingSchema, target: z.number().int().nonnegative().safe() })
      .optional(),
  })
  .superRefine((objective, context) => {
    if (!objective.label && !objective.labelKey)
      context.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'An objective label or translation is required',
      })

    if (!objective.when.length && !objective.progress)
      context.addIssue({
        code: 'custom',
        path: ['when'],
        message: 'An objective requires conditions or numeric progress',
      })
  })

export const questTextSchema = z.object({
  active: z.string().default('Active'),
  ready: z.string().default('Ready to turn in'),
  completed: z.string().default('Completed'),
  'not-started': z.string().default('Not started'),
  unavailable: z.string().default('Quest operation is unavailable.'),
  requirements: z.string().default('Quest requirements are not satisfied.'),
  inventory: z.string().default('Required items are missing, equipped, nonempty, or reserved.'),
  rewards: z
    .string()
    .default('Rewards cannot be delivered: check state access, amounts, and inventory.'),
  accept: z.string().default('This quest cannot be accepted right now.'),
  handIn: z.string().default('Hand in'),
  reward: z.string().default('Rewards'),
})

export const questSchema = z
  .object({
    'schema-version': z.literal('1.0.0'),
    id,
    ...presentation,
    when: conditions,
    turnInWhen: conditions,
    stages: z
      .array(
        z.object({
          id,
          ...presentation,
          objectives: z.array(questObjectiveSchema).min(1).max(100),
        }),
      )
      .min(1)
      .max(100),
    handIns: z
      .array(
        z
          .object({
            item: id,
            owner: id,
            operation: z.enum(['consume', 'transfer']),
            recipient: id.optional(),
          })
          .superRefine((handIn, context) => {
            if ((handIn.operation === 'transfer') !== Boolean(handIn.recipient))
              context.addIssue({
                code: 'custom',
                path: ['recipient'],
                message: 'Transfers require a recipient; consumed hand-ins have none',
              })

            if (handIn.recipient === handIn.owner)
              context.addIssue({
                code: 'custom',
                path: ['recipient'],
                message: 'A hand-in must change ownership',
              })
          }),
      )
      .max(100)
      .default([]),
    rewards: z
      .object({
        recipient: id.optional(),
        numeric: z.array(numericRewardSchema).max(100).default([]),
        items: z
          .array(z.object({ id, itemType: id, colors: z.record(id, colorSchema).default({}) }))
          .max(100)
          .default([]),
      })
      .prefault({}),
    messages: questTextSchema.prefault({}),
    messageKeys: z
      .partialRecord(z.enum(questTextSchema.keyof().options), translationKeySchema)
      .default({}),
  })
  .superRefine((quest, context) => {
    if (!quest.label && !quest.labelKey)
      context.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'A quest label or translation is required',
      })

    for (const [key, values] of [
      ['stages', quest.stages.map((stage) => stage.id)],
      [
        'objectives',
        quest.stages.flatMap((stage) => stage.objectives.map((objective) => objective.id)),
      ],
      ['handIns', quest.handIns.map((entry) => entry.item)],
      ['rewards', quest.rewards.items.map((entry) => entry.id)],
      ['numeric', quest.rewards.numeric.map((entry) => entry.id)],
    ] as const)
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'IDs must be unique within a quest',
        })

    if (quest.rewards.items.length && !quest.rewards.recipient)
      context.addIssue({
        code: 'custom',
        path: ['rewards', 'recipient'],
        message: 'Item rewards require an inventory recipient',
      })
  })

export const dialogueCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choose'), position: z.number().int().min(1).max(15) }),
  ...(['start', 'end', 'previous-page', 'next-page'] as const).map((type) =>
    z.object({ type: z.literal(type) }),
  ),
])

export const questOperationSchema = z.enum(['start', 'turn-in', 'track', 'untrack'])

export type DialogueDefinition = z.infer<typeof dialogueSchema>

export type DialogueChoice = z.infer<typeof dialogueChoiceSchema>

export type DialogueCommand = z.infer<typeof dialogueCommandSchema>

export type QuestDefinition = z.infer<typeof questSchema>

export type QuestOperation = z.infer<typeof questOperationSchema>

export type StoryEffect = z.infer<typeof storyEffectSchema>

export function dialogueFile(id: string): string {
  return `dialogues/${id}.json`
}

export function questFile(id: string): string {
  return `quests/${id}.json`
}

export function questRewardItemId(quest: string, entry: string): string {
  return `quest-reward-${quest.length}-${quest}-${entry}`
}
