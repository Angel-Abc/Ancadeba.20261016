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
  const { input, select, button, group } = controls

  const fields = effects.map((effect, index) =>
    group(
      `Effect ${index + 1}`,
      input('Effect ID', effect.id, (value) => {
        effect.id = value.trim()
      }),
      select(
        'Effect type',
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
        'Effect recipient',
        effect.target ?? 'target',
        [
          ['target', 'Ability target'],
          ['self', 'User'],
        ],
        (value) => {
          effect.target = value
        },
      ),
      ...(effect.type === 'damage'
        ? [
            input(
              'Minimum damage',
              String(effect.damage.min),
              (v) => {
                effect.damage.min = Number(v)
              },
              'number',
            ),
            input(
              'Maximum damage',
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
                'Amount',
                String(effect.amount),
                (v) => {
                  effect.amount = Number(v)
                },
                'number',
              ),
            ]
          : [
              select('Status', effect.status, Object.keys(draft.statuses ?? {}), (v) => {
                effect.status = v
              }),
            ]),
      button('Move effect up', () => {
        if (!index) return
        const previous = effects[index - 1]!
        effects[index - 1] = effect
        effects[index] = previous
        controls.markEdited()
        render()
      }),
      button('Remove effect', () => {
        effects.splice(index, 1)
        controls.markEdited()
        render()
      }),
    ),
  )

  return [
    ...fields,
    button('Add ability effect', () => {
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
  const { input, select, button, group, translation } = controls

  const art = [
    '',
    ...Object.keys(view.assets?.images ?? {}),
    ...Object.keys(view.assets?.parts ?? {}),
    ...Object.keys(view.assets?.compositions ?? {}),
  ]

  const rows = Object.entries(draft.statuses ?? {}).map(([id, status]) =>
    group(
      `Status: ${id}`,
      select('Status type', status.type, ['damage', 'regeneration', 'modifier', 'stun'], (type) => {
        draft.statuses![id] = combatStatusSchema.parse({
          ...status,
          type,
          amount: 3,
          modifiers: { attack: 2 },
        })
        render()
      }),
      input('Name', status.label, (value) => {
        status.label = value
      }),
      translation('Name translation', status.labelKey ?? '', translationChoices(view), (value) => {
        status.labelKey = value || undefined
      }),
      input('Description', status.description, (value) => {
        status.description = value
      }),
      translation(
        'Description translation',
        status.descriptionKey ?? '',
        translationChoices(view),
        (value) => {
          status.descriptionKey = value || undefined
        },
      ),
      select('Icon', status.icon ?? '', art, (value) => {
        status.icon = value || undefined
      }),
      input(
        'Duration (affected turns)',
        String(status.duration),
        (value) => {
          status.duration = Number(value)
        },
        'number',
      ),
      ...(status.type === 'damage' || status.type === 'regeneration'
        ? [
            input(
              'Amount',
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
                `${stat} modifier`,
                String(status.modifiers[stat] ?? 0),
                (value) => {
                  status.modifiers[stat] = Number(value)
                },
                'number',
              ),
            )
          : []),
      button(`Remove status ${id}`, () => {
        delete draft.statuses![id]
        controls.markEdited()
        render()
      }),
    ),
  )

  let nextId = 'status'

  return group(
    'Combat statuses',
    ...rows,
    input('New status ID', nextId, (value) => {
      nextId = value.trim()
    }),
    button('Add status', () => {
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
