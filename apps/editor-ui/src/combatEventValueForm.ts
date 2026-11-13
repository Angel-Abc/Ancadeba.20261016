import { combatEventValueFields, type CombatEventValue } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export function combatEventValueForm(
  controls: RuleFormControls,
  effect: { eventValue?: CombatEventValue | undefined },
  render: () => void,
  fields: readonly CombatEventValue['field'][] = combatEventValueFields,
): HTMLElement {
  const { group, input, select, t } = controls
  const text = (key: string) => t(`combat.events.${key}`)
  const help = controls.create('p')
  help.textContent = text('formulaHelp')

  return group(
    text('formula'),
    help,
    select(
      text('enableFormula'),
      String(Boolean(effect.eventValue)),
      [
        ['false', t('form.no')],
        ['true', t('form.yes')],
      ],
      (value) => {
        effect.eventValue = value === 'true' ? { field: 'amount', factor: 1 } : undefined
        render()
      },
    ),
    ...(effect.eventValue
      ? [
          select(
            text('field'),
            effect.eventValue.field,
            fields.map((field) => [field, text(`field.${field}`)] as const),
            (value) => {
              effect.eventValue!.field = value
            },
          ),
          input(
            text('factor'),
            String(effect.eventValue.factor),
            (value) => {
              effect.eventValue!.factor = Number(value)
            },
            'number',
          ),
          select(
            text('rounding'),
            effect.eventValue.rounding ?? 'floor',
            ['floor', 'ceil', 'nearest'],
            (value) => {
              effect.eventValue!.rounding = value === 'floor' ? undefined : value
            },
          ),
        ]
      : []),
  )
}
