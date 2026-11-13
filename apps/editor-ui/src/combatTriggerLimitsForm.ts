import type { CombatTriggerDefinition } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export function combatTriggerLimitsForm(
  controls: RuleFormControls,
  trigger: CombatTriggerDefinition,
): HTMLElement[] {
  const { input, t } = controls

  return [
    ...(['priority', 'charges', 'perTurn', 'cooldown'] as const).map((key) =>
      input(
        t(`combat.triggerLimits.${key}`),
        String(trigger[key] ?? ''),
        (value) => {
          trigger[key] = value.trim() ? Number(value) : undefined
        },
        'number',
      ),
    ),
  ]
}
