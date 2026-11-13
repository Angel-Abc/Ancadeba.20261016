import { combatEffectValuesForm } from './combatEffectValuesForm.js'
import { combatPassiveGrantsForm } from './combatPassiveForms.js'
import { combatDamageDefensesForm } from './combatDamageForm.js'
import { combatRestrictionsForm } from './combatRestrictionsForm.js'
import { combatScalingForm } from './combatScalingForm.js'
import {
  abilityEffectSchema,
  combatStatusSchema,
  type CombatDefinition,
  type AbilityEffect,
  temporaryModifierNames,
  combatPercentModifierNames,
} from '@ancadeba/schemas'
import { combatEffectConditionsForm } from './combatConditionsForm.js'
import { combatStatusStrengthForm } from './combatStatusStrengthForm.js'
import type { ProjectView } from '@ancadeba/editor-core'
import { translationChoices, type RuleFormControls } from './ruleFormControls.js'

export function abilityEffectsForm(
  controls: RuleFormControls,
  draft: Pick<CombatDefinition, 'statuses' | 'mechanics'>,
  effects: AbilityEffect[],
  render: () => void,
): HTMLElement[] {
  const { input, select, button, group, t } = controls

  const fields = effects.map((effect, index) =>
    group(
      t('form.effectNumber', { number: index + 1 }),
      input(t('combat.effectId'), effect.id, (value) => {
        effect.id = value.trim()
      }),
      select(
        t('form.effectType'),
        effect.type,
        ['damage', 'heal', 'guard', 'apply-status', 'remove-status', 'change-resource'],
        (type) => {
          effects[index] = abilityEffectSchema.parse({
            id: effect.id,
            type,
            target: effect.target,
            amount: 3,
            damage: { min: 2, max: 4 },
            status: Object.keys(draft.statuses ?? {})[0] ?? 'status',
            resource: Object.keys(draft.mechanics?.resources ?? {})[0] ?? 'resource',
          })
          render()
        },
      ),
      ...(effect.type === 'change-resource'
        ? []
        : [
            select(
              t('combat.effectRecipient'),
              effect.target ?? 'target',
              [
                ['target', t('combat.abilityTarget')],
                ['self', t('combat.user')],
              ],
              (value) => {
                effect.target = value
              },
            ),
          ]),
      ...(effect.type === 'change-resource'
        ? [
            input(t('combat.mechanics.resourceId'), effect.resource, (value) => {
              effect.resource = value.trim()
            }),
          ]
        : []),
      ...(effect.type === 'apply-status' || effect.type === 'remove-status'
        ? combatStatusStrengthForm(controls, effect)
        : []),
      ...(effect.type === 'damage'
        ? [
            input(t('combat.damage.type'), effect.damageType ?? '', (value) => {
              effect.damageType = value.trim() || undefined
            }),
            input(
              t('combat.minDamage'),
              String(effect.damage.min),
              (v) => {
                effect.damage.min = Number(v)
              },
              'number',
            ),
            input(
              t('combat.maxDamage'),
              String(effect.damage.max),
              (v) => {
                effect.damage.max = Number(v)
              },
              'number',
            ),
          ]
        : effect.type === 'heal' || effect.type === 'guard' || effect.type === 'change-resource'
          ? [
              input(
                t('form.amount'),
                String(effect.amount),
                (v) => {
                  effect.amount = Number(v)
                },
                'number',
              ),
            ]
          : [
              select(t('form.status'), effect.status, Object.keys(draft.statuses ?? {}), (v) => {
                effect.status = v
              }),
            ]),
      ...(effect.type === 'damage' || effect.type === 'heal' || effect.type === 'guard'
        ? [
            combatScalingForm(
              controls,
              t('combat.scaling.effect'),
              effect.scaling,
              (value) => {
                effect.scaling = value
              },
              render,
              Object.keys(draft.mechanics?.resources ?? {}),
              Object.keys(draft.statuses ?? {}),
            ),
          ]
        : []),
      combatEffectValuesForm(
        controls,
        effect,
        render,
        Object.keys(draft.mechanics?.resources ?? {}),
        Object.keys(draft.statuses ?? {}),
      ),
      combatEffectConditionsForm(
        controls,
        effect,
        {
          resources: Object.keys(draft.mechanics?.resources ?? {}),
          phases: Object.keys(draft.mechanics?.phases ?? {}),
          statuses: Object.keys(draft.statuses ?? {}),
          freeReferences: true,
        },
        render,
      ),
      button(t('combat.moveEffectUp'), () => {
        if (!index) return
        const previous = effects[index - 1]!
        effects[index - 1] = effect
        effects[index] = previous
        controls.markEdited()
        render()
      }),
      button(t('form.removeEffect'), () => {
        effects.splice(index, 1)
        controls.markEdited()
        render()
      }),
    ),
  )

  return [
    ...fields,
    button(t('combat.addAbilityEffect'), () => {
      let id = 'effect'
      let n = 1

      while (effects.some((e) => e.id === id)) id = `effect-${n++}`
      effects.push({ id, type: 'heal', amount: 3 })
      controls.markEdited()
      render()
    }),
  ]
}

export function combatStatusesForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: Pick<CombatDefinition, 'statuses'>,
  render: () => void,
): HTMLElement {
  const { input, select, button, group, translation, t } = controls

  const art = [
    '',
    ...Object.keys(view.assets?.images ?? {}),
    ...Object.keys(view.assets?.parts ?? {}),
    ...Object.keys(view.assets?.compositions ?? {}),
  ]

  const rows = Object.entries(draft.statuses ?? {}).map(([id, status]) =>
    group(
      t('combat.statusTitle', { id }),
      select(
        t('combat.statusType'),
        status.type,
        ['damage', 'regeneration', 'modifier', 'stun', 'composite'],
        (type) => {
          draft.statuses![id] = combatStatusSchema.parse({
            ...status,
            type,
            damageType:
              (type === 'damage' ||
                (type === 'composite' &&
                  status.type === 'composite' &&
                  status.damage !== undefined)) &&
              'damageType' in status
                ? status.damageType
                : undefined,
            amount: 3,
            modifiers: type === 'composite' ? { ap: -1 } : { attack: 2 },
          })
          render()
        },
      ),
      combatPassiveGrantsForm(controls, view, status, render),
      combatEffectValuesForm(controls, status, render, [], Object.keys(draft.statuses ?? {})),
      input(t('form.name'), status.label, (value) => {
        status.label = value
      }),
      translation(
        t('form.nameTranslation'),
        status.labelKey ?? '',
        translationChoices(view),
        (value) => {
          status.labelKey = value || undefined
        },
      ),
      input(t('metadata.description'), status.description, (value) => {
        status.description = value
      }),
      translation(
        t('form.descriptionTranslation'),
        status.descriptionKey ?? '',
        translationChoices(view),
        (value) => {
          status.descriptionKey = value || undefined
        },
      ),
      select(t('combat.icon'), status.icon ?? '', art, (value) => {
        status.icon = value || undefined
      }),
      input(
        t('combat.duration'),
        String(status.duration),
        (value) => {
          status.duration = Number(value)
        },
        'number',
      ),
      group(
        t('combat.status.stacking'),
        select(
          t('combat.status.enableStacking'),
          String(Boolean(status.stacking)),
          [
            ['false', t('form.no')],
            ['true', t('form.yes')],
          ],
          (value) => {
            status.stacking = value === 'true' ? { maximum: 3, duration: 'refresh' } : undefined
            render()
          },
        ),
        ...(status.stacking
          ? [
              input(
                t('combat.status.maximumStacks'),
                String(status.stacking.maximum),
                (value) => {
                  status.stacking!.maximum = Number(value)
                },
                'number',
              ),
              select(
                t('combat.status.stackDuration'),
                status.stacking.duration,
                [
                  ['refresh', t('combat.status.refresh')],
                  ['preserve', t('combat.status.preserve')],
                ],
                (value) => {
                  status.stacking!.duration = value
                },
              ),
            ]
          : []),
      ),
      group(
        t('combat.status.intensity'),
        select(
          t('combat.status.enableIntensity'),
          String(Boolean(status.intensity)),
          [
            ['false', t('form.no')],
            ['true', t('form.yes')],
          ],
          (value) => {
            status.intensity =
              value === 'true' ? { initial: 1, maximum: 3, reapply: 'replace' } : undefined
            render()
          },
        ),
        ...(status.intensity
          ? [
              input(
                t('combat.status.initialIntensity'),
                String(status.intensity.initial),
                (value) => {
                  status.intensity!.initial = Number(value)
                },
                'number',
              ),
              input(
                t('combat.status.maximumIntensity'),
                String(status.intensity.maximum),
                (value) => {
                  status.intensity!.maximum = Number(value)
                },
                'number',
              ),
              select(
                t('combat.status.reapply'),
                status.intensity.reapply,
                ['replace', 'maximum', 'add'].map(
                  (value) => [value, t(`combat.status.reapply.${value}`)] as const,
                ),
                (value) => {
                  if (value === 'replace' || value === 'maximum' || value === 'add')
                    status.intensity!.reapply = value
                },
              ),
            ]
          : []),
      ),
      combatDamageDefensesForm(controls, status, render),
      combatRestrictionsForm(controls, status),
      ...(status.type === 'damage' || (status.type === 'composite' && status.damage !== undefined)
        ? [
            input(t('combat.damage.periodicType'), status.damageType ?? '', (value) => {
              status.damageType = value.trim() || undefined
            }),
          ]
        : []),
      ...(status.type === 'damage' || status.type === 'regeneration'
        ? [
            input(
              t('form.amount'),
              String(status.amount),
              (value) => {
                status.amount = Number(value)
              },
              'number',
            ),
          ]
        : status.type === 'modifier' || (status.type === 'composite' && status.modifiers)
          ? temporaryModifierNames.map((stat) =>
              input(
                stat === 'ap' || stat === 'apCost'
                  ? t(`combat.status.modifier.${stat}`)
                  : t('combat.statModifier', { stat }),
                String(status.modifiers?.[stat] ?? 0),
                (value) => {
                  status.modifiers![stat] = Number(value)
                },
                'number',
              ),
            )
          : []),
      ...(status.type === 'modifier' || status.type === 'composite'
        ? [
            group(
              t('combat.scaling.percentHeading'),
              ...combatPercentModifierNames.map((stat) =>
                input(
                  t('combat.scaling.percentStat', { stat: t(`combat.scaling.stat.${stat}`) }),
                  String(status.percentModifiers?.[stat] ?? 0),
                  (value) => {
                    const amount = Number(value)

                    if (amount) (status.percentModifiers ??= {})[stat] = amount
                    else if (status.percentModifiers) {
                      delete status.percentModifiers[stat]

                      if (!Object.keys(status.percentModifiers).length)
                        status.percentModifiers = undefined
                    }
                  },
                  'number',
                ),
              ),
            ),
          ]
        : []),
      ...(status.type === 'composite'
        ? [
            ...(['damage', 'regeneration'] as const).map((kind) =>
              group(
                t(`combat.status.${kind}`),
                select(
                  t('combat.status.enabled'),
                  String(status[kind] !== undefined),
                  [
                    ['false', t('form.no')],
                    ['true', t('form.yes')],
                  ],
                  (value) => {
                    status[kind] = value === 'true' ? 3 : undefined

                    if (kind === 'damage' && value === 'false') status.damageType = undefined
                    render()
                  },
                ),
                ...(status[kind] === undefined
                  ? []
                  : [
                      input(
                        t('form.amount'),
                        String(status[kind]),
                        (value) => {
                          status[kind] = Number(value)
                        },
                        'number',
                      ),
                    ]),
              ),
            ),
            select(
              t('combat.status.enableModifiers'),
              String(Boolean(status.modifiers)),
              [
                ['false', t('form.no')],
                ['true', t('form.yes')],
              ],
              (value) => {
                status.modifiers = value === 'true' ? {} : undefined
                render()
              },
            ),
            select(
              t('combat.status.stun'),
              String(status.stun ?? false),
              [
                ['false', t('form.no')],
                ['true', t('form.yes')],
              ],
              (value) => {
                status.stun = value === 'true' || undefined
              },
            ),
          ]
        : []),
      button(t('combat.removeStatus', { id }), () => {
        delete draft.statuses![id]
        controls.markEdited()
        render()
      }),
    ),
  )

  let nextId = 'status'

  return group(
    t('combat.statuses'),
    ...rows,
    input(t('combat.newStatusId'), nextId, (value) => {
      nextId = value.trim()
    }),
    button(t('combat.addStatus'), () => {
      let id = nextId
      let n = 1

      while (Object.hasOwn(draft.statuses ?? {}, id)) id = `${nextId}-${n++}`
      ;(draft.statuses ??= {})[id] = combatStatusSchema.parse({
        type: 'damage',
        label: 'Poison',
        duration: 3,
        amount: 2,
      })
      controls.markEdited()
      render()
    }),
  )
}
