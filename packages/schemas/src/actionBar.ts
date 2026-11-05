import type { ActionBarComponentDefinition, SceneDefinition } from './scene.js'
import type { InputDefinition } from './input.js'

/** Shared checks for project diagnostics, startup, and export. */
export function actionBarIssues(
  bar: ActionBarComponentDefinition,
  input: InputDefinition | undefined,
  scenes: ReadonlyMap<string, SceneDefinition>,
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

    if (action.type === 'request-action') continue
    const target = scenes.get(action.scene)

    if (!target || (action.type === 'new-game' && target.type !== 'game'))
      issues.push({
        path: ['slots', id, 'action'],
        message: `Invalid ${action.type} target: ${action.scene}`,
      })
  }

  return issues
}
