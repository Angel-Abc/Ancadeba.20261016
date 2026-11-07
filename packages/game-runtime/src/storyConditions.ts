import { inventoryOwner, type WorldCondition } from '@ancadeba/schemas'
import type { GameInstance, SceneInstance } from './gameLifecycle.js'
import type { BindingValue } from './gameBindings.js'

export interface WorldFacts {
  readonly game: GameInstance
  readonly scene?: SceneInstance | undefined
  readonly values?: ReadonlyMap<string, BindingValue>
  readonly quest?: (id: string) => { status: string; stage?: string | undefined } | undefined
}

export function matchesConditions(
  conditions: readonly WorldCondition[],
  facts: WorldFacts,
): boolean {
  return conditions.every((condition) => {
    switch (condition.type) {
      case 'scene-is':
        return facts.scene?.data.id === condition.scene
      case 'state-is':
      case 'state-compare': {
        const result = facts.game.bindings?.read({ source: 'game.state', path: condition.path })

        const value =
          facts.values?.get(JSON.stringify(condition.path)) ??
          (result?.status === 'resolved' ? result.value : undefined)

        if (condition.type === 'state-is') return value === condition.value

        if (typeof value !== 'number' || !Number.isFinite(value)) return false

        switch (condition.operator) {
          case 'eq':
            return value === condition.value
          case 'gte':
            return value >= condition.value
          case 'lte':
            return value <= condition.value
          case 'gt':
            return value > condition.value
          case 'lt':
            return value < condition.value
        }

        break
      }

      case 'item-carried-by': {
        const item = facts.game.inventory?.snapshot.find((item) => item.id === condition.item)

        return item?.placement.type === 'carried' && item.placement.owner === condition.owner
      }

      case 'item-owned-by':
        return (
          inventoryOwner(
            new Map(facts.game.inventory?.snapshot.map((item) => [item.id, item])),
            condition.item,
          ) === condition.owner
        )
      case 'combat-outcome':
        return facts.game.combat?.outcome?.(condition.encounter) === condition.outcome
      case 'quest-state': {
        const quest = facts.quest?.(condition.quest) ?? facts.game.quests?.snapshot(condition.quest)

        return (
          quest?.status === condition.status &&
          (!condition.stage || quest.stage === condition.stage)
        )
      }
    }

    return false
  })
}

export function notifyStory(listeners: Iterable<() => void>): void {
  const errors: unknown[] = []

  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      errors.push(error)
    }
  }

  if (errors.length)
    throw new AggregateError(errors, 'Story transaction committed but observers failed')
}
