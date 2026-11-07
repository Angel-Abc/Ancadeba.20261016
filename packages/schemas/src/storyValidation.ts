import type { DialogueDefinition, QuestDefinition, StoryEffect } from './story.js'
import { dialogueSchema, questSchema, questRewardItemId } from './story.js'
import type { WorldCondition } from './storyConditions.js'
import type { SceneDefinition } from './scene.js'
import type { GameRulesDefinition } from './rules.js'
import { ruleValueType } from './rules.js'
import { inventoryIssues } from './inventory.js'
import type { AssetCatalog } from './assets.js'
import { levelingBindingFields, type LevelingProfile } from './leveling.js'
import { rewardItemId } from './combatRewards.js'
import type { InventoryDefinition } from './inventory.js'
import type { CombatDefinition } from './combat.js'
import type { GameTranslation } from './localization.js'

export interface StorySources {
  dialogues: ReadonlyMap<string, DialogueDefinition>
  quests: ReadonlyMap<string, QuestDefinition>
  scenes: ReadonlyMap<string, SceneDefinition>
  rules?: GameRulesDefinition | undefined
  inventory?: InventoryDefinition | undefined
  combat?: ReadonlyMap<string, CombatDefinition> | undefined
  translation?: GameTranslation | undefined
  assets?: AssetCatalog | undefined
  leveling?: ReadonlyMap<string, LevelingProfile> | undefined
}

export function storyIssues(sources: StorySources) {
  const issues: { file: string; path: (string | number)[]; message: string }[] = []
  const fields = new Map(sources.rules?.state.map((field) => [JSON.stringify(field.path), field]))
  const items = new Set(Object.keys(sources.inventory?.items ?? {}))

  for (const quest of sources.quests.values())
    for (const reward of quest.rewards.items) items.add(questRewardItemId(quest.id, reward.id))

  for (const combat of sources.combat?.values() ?? [])
    for (const drop of combat.rewards?.drops ?? []) items.add(rewardItemId(combat.id, drop.id))

  const add = (file: string, message: string) => issues.push({ file, path: [], message })
  const owner = (id: string | undefined) => id && Object.hasOwn(sources.inventory?.owners ?? {}, id)

  const condition = (value: WorldCondition, file: string) => {
    if (value.type === 'state-is' || value.type === 'state-compare') {
      const field = fields.get(JSON.stringify(value.path))

      if (!field || ruleValueType(field.value) !== typeof value.value)
        add(file, 'Unknown or incompatible condition state field')
    }

    if (value.type === 'scene-is' && !sources.scenes.has(value.scene))
      add(file, `Unknown scene: ${value.scene}`)

    if (value.type === 'quest-state') {
      const quest = sources.quests.get(value.quest)

      if (!quest || (value.stage && !quest.stages.some((stage) => stage.id === value.stage)))
        add(file, 'Unknown quest or stage')
    }

    if (value.type === 'combat-outcome' && !sources.combat?.has(value.encounter))
      add(file, `Unknown encounter: ${value.encounter}`)

    if (
      (value.type === 'item-owned-by' || value.type === 'item-carried-by') &&
      (!items.has(value.item) || !owner(value.owner))
    )
      add(file, 'Unknown condition item or owner')
  }

  const effect = (value: StoryEffect, file: string) => {
    if (value.type === 'start-quest' || value.type === 'complete-quest') {
      if (!sources.quests.has(value.quest)) add(file, `Unknown quest: ${value.quest}`)
    } else if (value.type === 'append-log') {
      if (!sources.rules?.log) add(file, 'Appending dialogue text requires a declared log')
    } else {
      const field = fields.get(JSON.stringify(value.path))

      if (!field || ruleValueType(field.value) !== ruleValueType(value.value))
        add(file, 'Unknown or incompatible effect state field')

      if (
        [sources.rules?.clock?.path, sources.rules?.log?.path].some(
          (path) => path && JSON.stringify(path) === JSON.stringify(value.path),
        )
      )
        add(file, 'Clock and log fields cannot be assigned directly')
    }
  }

  for (const [id, dialogue] of sources.dialogues) {
    const file = `dialogues/${id}.json`

    if (id !== dialogue.id) add(file, 'Dialogue ID must match its manifest reference')

    for (const node of Object.values(dialogue.nodes))
      for (const choice of node.choices) {
        choice.when.forEach((value) => condition(value, file))
        choice.visibleWhen.forEach((value) => condition(value, file))
        choice.effects.forEach((value) => effect(value, file))

        if (choice.scene && sources.scenes.get(choice.scene)?.type !== 'game')
          add(file, `Unknown scene: ${choice.scene}`)
      }
  }

  const rewardIds = new Set(Object.keys(sources.inventory?.items ?? {}))

  for (const [id, quest] of sources.quests) {
    const file = `quests/${id}.json`

    if (id !== quest.id) add(file, 'Quest ID must match its manifest reference')
    quest.when.forEach((value) => condition(value, file))
    quest.turnInWhen.forEach((value) => condition(value, file))

    for (const stage of quest.stages)
      for (const objective of stage.objectives) {
        objective.when.forEach((value) => condition(value, file))

        if (
          objective.progress?.binding.source === 'game.state' &&
          ruleValueType(
            fields.get(JSON.stringify(objective.progress.binding.path))?.value ?? '',
          ) !== 'number'
        )
          add(file, 'Numeric quest progress requires a declared numeric field')
      }

    for (const handIn of quest.handIns)
      if (
        !items.has(handIn.item) ||
        !owner(handIn.owner) ||
        (handIn.recipient && !owner(handIn.recipient))
      )
        add(file, 'Unknown hand-in item or owner')

    if (quest.rewards.recipient && !owner(quest.rewards.recipient))
      add(file, 'Unknown quest reward recipient')

    for (const reward of quest.rewards.numeric) {
      if (
        [...(sources.leveling?.values() ?? [])].some(
          (profile) => JSON.stringify(profile.level.path) === JSON.stringify(reward.field.path),
        )
      )
        add(file, 'Rewards must grant XP instead of writing a managed level')
      const field = fields.get(JSON.stringify(reward.field.path))

      if (reward.field.source !== 'game.state' || !field || typeof field.value !== 'number')
        add(file, 'Quest rewards require declared numeric state fields')

      if (
        [...(sources.combat?.values() ?? [])].some((encounter) =>
          [encounter.player, ...encounter.enemies].some(
            (actor) => JSON.stringify(actor.health.path) === JSON.stringify(reward.field.path),
          ),
        )
      )
        add(file, 'Quest rewards cannot write combat health')
    }

    for (const reward of quest.rewards.items) {
      const itemId = questRewardItemId(id, reward.id)

      if (rewardIds.has(itemId)) add(file, 'Quest reward instance ID collision')
      rewardIds.add(itemId)
      const type = sources.inventory?.itemTypes[reward.itemType]

      if (!type) add(file, `Unknown reward item type: ${reward.itemType}`)

      if (sources.inventory && quest.rewards.recipient)
        for (const issue of inventoryIssues(
          {
            ...sources.inventory,
            items: {
              [itemId]: {
                itemType: reward.itemType,
                colors: reward.colors,
                placement: { type: 'carried', owner: quest.rewards.recipient },
              },
            },
          },
          sources.assets,
        ).filter((issue) => issue.path[0] === 'items'))
          add(file, issue.message)
    }
  }

  for (const branches of Object.values(sources.rules?.actions ?? {}))
    for (const branch of branches) {
      for (const value of branch.when)
        if (value.type !== 'payload-is-item' && value.type !== 'payload-is-target')
          condition(value, 'game.json')

      for (const value of branch.effects)
        if (value.type === 'start-quest' || value.type === 'complete-quest')
          effect(value, 'game.json')

      if (
        branch.effects.some(
          (value) => value.type === 'start-quest' || value.type === 'complete-quest',
        ) &&
        branch.effects.some((value) => value.type === 'move-item' || value.type === 'enter-scene')
      )
        add('game.json', 'Quest transactions cannot include legacy movement effects')
    }

  const inspect = (value: unknown, file: string) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => inspect(entry, file))

      return
    }

    if (!value || typeof value !== 'object') return

    if ('source' in value && value.source === 'game.quests') {
      const path = 'path' in value ? value.path : undefined

      if (
        !Array.isArray(path) ||
        path.length !== 2 ||
        !sources.quests.has(path[0]) ||
        !['status', 'stage', 'tracked'].includes(path[1])
      )
        add(file, 'Unknown quest binding')
    }

    if (
      'source' in value &&
      value.source === 'game.leveling' &&
      (file.startsWith('dialogues/') || file.startsWith('quests/'))
    ) {
      const path = 'path' in value ? value.path : undefined

      if (
        !Array.isArray(path) ||
        path.length !== 2 ||
        !sources.leveling?.has(path[0]) ||
        !Object.hasOwn(levelingBindingFields, path[1])
      )
        add(file, 'Unknown character progression binding')
    }

    if (
      'source' in value &&
      value.source === 'game.state' &&
      (file.startsWith('dialogues/') || file.startsWith('quests/'))
    ) {
      const path = 'path' in value ? value.path : undefined

      if (
        !Array.isArray(path) ||
        (!fields.has(JSON.stringify(path)) &&
          ![sources.rules?.clock?.path, sources.rules?.log?.path].some(
            (reserved) => reserved && JSON.stringify(reserved) === JSON.stringify(path),
          ))
      )
        add(file, 'Unknown story state binding')
    }

    for (const entry of Object.values(value)) inspect(entry, file)
  }

  for (const [id, value] of sources.dialogues) inspect(value, `dialogues/${id}.json`)

  for (const [id, value] of sources.quests) inspect(value, `quests/${id}.json`)

  for (const [id, value] of sources.scenes) inspect(value, `scenes/${id}.json`)
  inspect(sources.inventory, 'game.json')
  inspect(sources.rules, 'game.json')
  const identities = new Map<string, string>()

  for (const scene of sources.scenes.values()) {
    const file = `scenes/${scene.id}.json`

    for (const component of scene.components) {
      if (component.type === 'quest-log') {
        for (const id of component.quests ?? [])
          if (!sources.quests.has(id)) add(file, `Unknown journal quest: ${id}`)

        if (
          component.textTarget &&
          !scene.components.some(
            (target) => target.id === component.textTarget && target.type === 'text',
          )
        )
          add(file, 'Unknown quest journal main-text target')

        if (scene.type !== 'game') add(file, 'Quest journals require a game scene')
      }

      if (component.type === 'action-bar')
        for (const slot of Object.values(component.slots))
          if (
            slot.action.type === 'quest-action' &&
            slot.action.quest &&
            !sources.quests.has(slot.action.quest)
          )
            add(file, `Unknown quest: ${slot.action.quest}`)

      if (component.type !== 'nearby') continue

      for (const entry of Object.values(component.entries)) {
        if (entry.conversationId && !entry.dialogue)
          add(file, 'A shared conversation identity requires a dialogue')

        if (!entry.dialogue) continue
        const dialogue = sources.dialogues.get(entry.dialogue)

        if (!dialogue) {
          add(file, `Unknown nearby dialogue: ${entry.dialogue}`)
          continue
        }

        if (entry.conversationId) {
          const existing = identities.get(entry.conversationId)

          if (existing && existing !== entry.dialogue)
            add(file, 'Shared conversation identities must reference one dialogue')
          identities.set(entry.conversationId, entry.dialogue)
        }

        const commands = scene.components.flatMap((bar) =>
          bar.type === 'action-bar'
            ? Object.values(bar.slots).flatMap((slot) =>
                slot.action.type === 'dialogue-action' && slot.action.nearby === component.id
                  ? [slot.action.command]
                  : [],
              )
            : [],
        )

        if (!commands.length) continue

        const positions = commands
          .flatMap((command) => (command.type === 'choose' ? [command.position] : []))
          .sort((a, b) => a - b)

        if (!positions.length || positions.some((position, index) => position !== index + 1))
          add(file, 'Dialogue reply positions must be unique and contiguous from 1')

        if (!commands.some((command) => command.type === 'end'))
          add(file, 'Dialogue action bars require End conversation')

        if (
          Object.values(dialogue.nodes).some((node) => node.choices.length > positions.length) &&
          (!commands.some((command) => command.type === 'next-page') ||
            !commands.some((command) => command.type === 'previous-page'))
        )
          add(file, 'Dialogue choices require previous and next page commands')
      }
    }
  }

  return issues
}

/** Resolve authored labels before interpolation; snapshots retain references to these definitions. */
export function localizeStory<T extends DialogueDefinition | QuestDefinition>(
  definition: T,
  translation?: GameTranslation,
): T {
  if (!translation) {
    const keyed = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false

      if (Array.isArray(value)) return value.some(keyed)

      return Object.entries(value).some(
        ([key, entry]) =>
          (['labelKey', 'descriptionKey', 'textKey'].includes(key) && typeof entry === 'string') ||
          (key === 'messageKeys' &&
            entry &&
            typeof entry === 'object' &&
            Object.keys(entry).length > 0) ||
          keyed(entry),
      )
    }

    if (keyed(definition)) throw new Error('Story translation keys require languages in game.json')

    return definition
  }

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)

    if (!value || typeof value !== 'object') return value
    const entries = Object.entries(value)

    const result: Record<string, unknown> = Object.fromEntries(
      entries.map(([key, child]) => [key, visit(child)]),
    )

    const text = (key: string) => {
      if (!Object.hasOwn(translation.fallback, key))
        throw new Error(`Missing default translation: ${key}`)

      return translation.messages[key] ?? translation.fallback[key]!
    }

    if (typeof result.textKey === 'string') return text(result.textKey)

    for (const key of ['label', 'description'])
      if (typeof result[`${key}Key`] === 'string') result[key] = text(String(result[`${key}Key`]))

    if (
      result.messages &&
      typeof result.messages === 'object' &&
      result.messageKeys &&
      typeof result.messageKeys === 'object'
    )
      result.messages = {
        ...result.messages,
        ...Object.fromEntries(
          Object.entries(result.messageKeys).map(([key, value]) => [key, text(String(value))]),
        ),
      }

    return result
  }

  // SAFETY: localization only substitutes schema-defined text fields with strings.
  return (
    'nodes' in definition
      ? dialogueSchema.parse(visit(definition))
      : questSchema.parse(visit(definition))
  ) as T
}
