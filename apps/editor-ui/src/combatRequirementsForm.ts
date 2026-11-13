import type { CombatMoveDefinition } from '@ancadeba/schemas'
import { combatConditionsForm, type CombatConditionChoices } from './combatConditionsForm.js'
import type { RuleFormControls } from './ruleFormControls.js'

export function combatRequirementsForm(
  controls: RuleFormControls,
  move: CombatMoveDefinition,
  choices: CombatConditionChoices,
  render: () => void,
): HTMLElement {
  const text = (key: string) => controls.t(`combat.requirements.${key}`)
  const help = controls.create('p')
  help.textContent = text('help')

  return controls.group(
    text('heading'),
    help,
    ...combatConditionsForm(
      controls,
      move.requirements ?? [],
      choices,
      render,
      'combat.mechanics',
      false,
    ),
    controls.button(
      text('add'),
      () => {
        const requirements = (move.requirements ??= [])
        requirements.push({
          type: 'resource',
          resource: choices.resources[0] ?? 'resource',
          operator: 'gte',
          value: 1,
        })
        controls.markEdited()
        render()
      },
      (move.requirements?.length ?? 0) >= 20,
    ),
    controls.button(
      text('clear'),
      () => {
        move.requirements = undefined
        controls.markEdited()
        render()
      },
      !move.requirements?.length,
    ),
  )
}
