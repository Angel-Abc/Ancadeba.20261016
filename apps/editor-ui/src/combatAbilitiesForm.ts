import {
  abilityEffectSchema,
  combatStatusSchema,
  type CombatDefinition,
  type AbilityEffect,
} from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { translationChoices, type RuleFormControls } from './ruleFormControls.js'

export function abilityEffectsForm(
  controls: RuleFormControls,
  draft: Pick<CombatDefinition, 'statuses'>,
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
        ['damage', 'heal', 'guard', 'apply-status', 'remove-status'],
        (type) => {
          effects[index] = abilityEffectSchema.parse({
            id: effect.id,
            type,
            target: effect.target,
            amount: 3,
            damage: { min: 2, max: 4 },
            status: Object.keys(draft.statuses ?? {})[0] ?? 'status',
          })
          render()
        },
      ),
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
      ...(effect.type === 'damage'
        ? [
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
        : effect.type === 'heal' || effect.type === 'guard'
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
        ['damage', 'regeneration', 'modifier', 'stun'],
        (type) => {
          draft.statuses![id] = combatStatusSchema.parse({
            ...status,
            type,
            amount: 3,
            modifiers: { attack: 2 },
          })
          render()
        },
      ),
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
        : status.type === 'modifier'
          ? (['attack', 'defense', 'guard'] as const).map((stat) =>
              input(
                t('combat.statModifier', { stat }),
                String(status.modifiers[stat] ?? 0),
                (value) => {
                  status.modifiers[stat] = Number(value)
                },
                'number',
              ),
            )
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
