import type { CombatTriggerEffect } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export function combatInterceptionForm(
  controls: RuleFormControls,
  effect: CombatTriggerEffect,
): HTMLElement[] {
  const { input, t } = controls
  const text = (key: string) => t(`combat.interception.${key}`)

  if (effect.type === 'adjust-effect')
    return [
      input(
        text('flat'),
        String(effect.amount),
        (value) => {
          effect.amount = Number(value)
        },
        'number',
      ),
      input(
        text('percent'),
        String(effect.percent ?? 0),
        (value) => {
          effect.percent = value.trim() ? Number(value) : undefined
        },
        'number',
      ),
    ]

  if (effect.type === 'absorb-damage' || effect.type === 'redirect-damage')
    return [
      ...(effect.type === 'redirect-damage'
        ? [
            input(
              text('redirectPercent'),
              String(effect.percent),
              (value) => {
                effect.percent = Number(value)
              },
              'number',
            ),
          ]
        : []),
      input(
        text('maximum'),
        String(effect.maximum ?? ''),
        (value) => {
          effect.maximum = value.trim() ? Number(value) : undefined
        },
        'number',
      ),
    ]

  if (effect.type === 'prevent-lethal')
    return [
      input(
        text('minimumHealth'),
        String(effect.minimumHealth),
        (value) => {
          effect.minimumHealth = Number(value)
        },
        'number',
      ),
    ]

  return []
}
