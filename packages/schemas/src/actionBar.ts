import type { ActionBarComponentDefinition, SceneDefinition } from './scene.js'
import type { InputDefinition } from './input.js'
import type { MapDefinition } from './map.js'
import { sceneTransitionIssues } from './sceneTransition.js'

/** Shared checks for project diagnostics, startup, and export. */
export function actionBarIssues(
  bar: ActionBarComponentDefinition,
  input: InputDefinition | undefined,
  scenes: ReadonlyMap<string, SceneDefinition>,
  scene?: SceneDefinition,
  maps: ReadonlyMap<string, MapDefinition> = new Map(),
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = []

  for (const [id, slot] of Object.entries(bar.slots)) {
    const binding = slot.inputBinding

    if (binding && !Object.values(input?.contexts[binding.context] ?? {}).includes(binding.input))
      issues.push({
        path: ['slots', id, 'inputBinding'],
        message: `Unknown input binding: ${binding.context}/${binding.input}`,
      })

    const action = slot.action

    if (action.type === 'dialogue-action' || action.type === 'quest-action') {
      const target = action.type === 'dialogue-action' ? action.nearby : action.journal
      const type = action.type === 'dialogue-action' ? 'nearby' : 'quest-log'

      if (
        target &&
        !scene?.components.some((component) => component.id === target && component.type === type)
      )
        issues.push({ path: ['slots', id, 'action'], message: `Unknown ${type}: ${target}` })
      continue
    }

    if (action.type === 'item-use') {
      if (
        !scene?.components.some(
          (component) => component.type === 'inventory' && component.id === action.inventory,
        )
      )
        issues.push({
          path: ['slots', id, 'action', 'inventory'],
          message: 'Unknown item-use inventory panel',
        })

      if (
        action.combat &&
        !scene?.components.some(
          (component) => component.type === 'combat' && component.id === action.combat,
        )
      )
        issues.push({
          path: ['slots', id, 'action', 'combat'],
          message: 'Unknown item-use combat component',
        })
      continue
    }

    if (action.type === 'combat-action') {
      if (
        !scene?.components.some(
          (component) => component.type === 'combat' && component.id === action.combat,
        )
      )
        issues.push({
          path: ['slots', id, 'action', 'combat'],
          message: `Unknown combat component: ${action.combat}`,
        })
      continue
    }

    if (action.type === 'shop-action') {
      if (
        !scene?.components.some(
          (component) => component.type === 'shop' && component.id === action.shop,
        )
      )
        issues.push({
          path: ['slots', id, 'action', 'shop'],
          message: `Unknown shop: ${action.shop}`,
        })
      continue
    }

    if (action.type === 'equipment-action') {
      if (
        !scene?.components.some(
          (component) => component.id === action.equipment && component.type === 'equipment',
        )
      )
        issues.push({
          path: ['slots', id, 'action', 'equipment'],
          message: `Unknown equipment view: ${action.equipment}`,
        })

      continue
    }

    if (action.type === 'nearby-action') {
      if (
        !scene?.components.some(
          (component) => component.id === action.nearby && component.type === 'nearby',
        )
      )
        issues.push({
          path: ['slots', id, 'action', 'nearby'],
          message: `Unknown nearby panel: ${action.nearby}`,
        })

      continue
    }

    if (action.type === 'inventory-action') {
      if (
        !scene?.components.some(
          (component) => component.id === action.inventory && component.type === 'inventory',
        )
      )
        issues.push({
          path: ['slots', id, 'action', 'inventory'],
          message: `Unknown inventory panel: ${action.inventory}`,
        })

      continue
    }

    if (
      action.type === 'request-action' ||
      action.type === 'move-map' ||
      action.type === 'interact-map'
    )
      continue
    const target = scenes.get(action.scene)

    if (!target || (action.type === 'new-game' && target.type !== 'game'))
      issues.push({
        path: ['slots', id, 'action'],
        message: `Invalid ${action.type} target: ${action.scene}`,
      })

    if (action.type === 'enter-scene')
      for (const issue of sceneTransitionIssues(action, scenes, maps))
        issues.push({ path: ['slots', id, 'action', ...issue.path], message: issue.message })
  }

  return issues
}
