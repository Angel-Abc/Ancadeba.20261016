import { combatPassiveGrantsForm } from './combatPassiveForms.js'
import {
  equipmentCombatEffectsSchema,
  bindingAliasSchema,
  type InventoryDefinition,
} from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { combatDamageDefensesForm } from './combatDamageForm.js'
import { combatRestrictionsForm } from './combatRestrictionsForm.js'
import { onOffChoices, type RuleFormControls } from './ruleFormControls.js'

export function equipmentCombatForm(
  controls: RuleFormControls,
  view: ProjectView,
  item: InventoryDefinition['itemTypes'][string],
  render: () => void,
): HTMLElement {
  const { group, input, select, button, create, t } = controls
  const text = (key: string) => t(`equipment.combat.${key}`)

  const edit = (action: () => void) => () => {
    action()
    controls.markEdited()
    render()
  }

  const help = create('p')
  help.textContent = text('help')
  const effects = item.combatEffects
  let resource = 'exhaustion'

  const available = Object.entries(view.combatLibraries ?? {}).flatMap(([library, data]) =>
    Object.entries(data.moves)
      .filter(
        ([id]) =>
          !effects?.grantedMoves?.some(
            (reference) => reference.library === library && reference.id === id,
          ),
      )
      .map(([id, move]) => [`${library}/${id}`, `${move.label || id} (${library}/${id})`] as const),
  )

  let choice = available[0]?.[0] ?? ''

  return group(
    text('heading'),
    help,
    select(text('enable'), effects ? 'enabled' : 'disabled', onOffChoices(t), (value) => {
      item.combatEffects = value === 'enabled' ? equipmentCombatEffectsSchema.parse({}) : undefined
      render()
    }),
    ...(effects
      ? [
          combatDamageDefensesForm(controls, effects, render),
          combatRestrictionsForm(controls, effects),
          combatPassiveGrantsForm(controls, view, effects, render),
          group(
            text('resources'),
            ...Object.entries(effects.resourceGains ?? {}).map(([id, modifier]) =>
              group(
                t('equipment.combat.resourceTitle', { id }),
                input(
                  text('flat'),
                  String(modifier.flat ?? 0),
                  (value) => {
                    modifier.flat = value.trim() ? Number(value) : undefined
                  },
                  'number',
                ),
                input(
                  text('percent'),
                  String(modifier.percent ?? 0),
                  (value) => {
                    modifier.percent = value.trim() ? Number(value) : undefined
                  },
                  'number',
                ),
                button(
                  text('removeResource'),
                  edit(() => {
                    delete effects.resourceGains?.[id]
                  }),
                ),
              ),
            ),
            input(text('resourceId'), resource, (value) => {
              resource = value.trim()
            }),
            button(
              text('addResource'),
              edit(() => {
                if (
                  bindingAliasSchema.safeParse(resource).success &&
                  !['__proto__', 'constructor', 'prototype'].includes(resource) &&
                  !Object.hasOwn(effects.resourceGains ?? {}, resource)
                ) {
                  effects.resourceGains = {
                    ...effects.resourceGains,
                    [resource]: { flat: 0, percent: 0 },
                  }
                }
              }),
              Object.keys(effects.resourceGains ?? {}).length >= 100,
            ),
          ),
          group(
            text('moves'),
            ...(effects.grantedMoves ?? []).map((reference, index) =>
              group(
                `${reference.library}/${reference.id}`,
                button(
                  text('removeMove'),
                  edit(() => {
                    effects.grantedMoves!.splice(index, 1)
                  }),
                ),
              ),
            ),
            select(
              text('moveChoice'),
              choice,
              available,
              (value) => {
                choice = value
              },
              false,
            ),
            button(
              text('addMove'),
              edit(() => {
                const [library, id] = choice.split('/')

                if (library && id)
                  effects.grantedMoves = [...(effects.grantedMoves ?? []), { library, id }]
              }),
              !choice || (effects.grantedMoves?.length ?? 0) >= 100,
            ),
          ),
        ]
      : []),
  )
}
