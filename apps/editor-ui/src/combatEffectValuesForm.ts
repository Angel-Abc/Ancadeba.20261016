import {
  combatNumericPaths,
  combatNumericValue,
  type CombatEffectValueScaling,
} from '@ancadeba/schemas'
import { combatScalingForm } from './combatScalingForm.js'
import type { RuleFormControls } from './ruleFormControls.js'

export function combatEffectValuesForm(
  controls: RuleFormControls,
  owner: { valueScaling?: CombatEffectValueScaling | undefined; type?: string },
  render: () => void,
  resources: readonly string[],
  statuses: readonly string[],
): HTMLElement {
  const { group, select, button, t } = controls

  const paths = [
    ...new Set([
      ...combatNumericPaths(owner),
      ...Object.keys(owner.valueScaling ?? {}),
      ...(owner.type === 'apply-status'
        ? ['stacks', 'intensity', 'duration']
        : owner.type === 'remove-status'
          ? ['stacks']
          : []),
    ]),
  ]

  let field = paths[0] ?? ''

  return group(
    t('combat.scaling.fields'),
    ...Object.entries(owner.valueScaling ?? {}).map(([path, scaling]) =>
      combatScalingForm(
        controls,
        t('combat.scaling.field', { field: path }),
        scaling,
        (value) => {
          if (value) (owner.valueScaling ??= {})[path] = value
          else {
            delete owner.valueScaling?.[path]

            if (!Object.keys(owner.valueScaling ?? {}).length) owner.valueScaling = undefined
          }
        },
        render,
        resources,
        statuses,
      ),
    ),
    select(
      t('combat.scaling.numericField'),
      field,
      paths,
      (value) => {
        field = value
      },
      false,
    ),
    button(
      t('combat.scaling.addField'),
      () => {
        if (!field) return

        if (combatNumericValue(owner, field) === undefined)
          Object.defineProperty(owner, field, {
            value: 1,
            writable: true,
            enumerable: true,
            configurable: true,
          })
        ;(owner.valueScaling ??= {})[field] ??= { terms: [{ type: 'round', factor: 1 }] }
        controls.markEdited()
        render()
      },
      !paths.length,
    ),
  )
}
