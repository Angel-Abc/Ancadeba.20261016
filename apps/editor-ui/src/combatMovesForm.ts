import type { CombatSource } from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { abilityEffectsForm } from './combatAbilitiesForm.js'
import { translationChoices, type RuleFormControls } from './ruleFormControls.js'

export function combatMovesForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: Pick<CombatSource, 'moves' | 'statuses'>,
  render: () => void,
  onAdd?: (id: string) => void,
  availableStatuses = draft.statuses,
): HTMLElement[] {
  const { input, select, button, group, translation, t } = controls
  const keys = translationChoices(view)
  const result: HTMLElement[] = []

  const number = (label: string, value: number, change: (value: number) => void) =>
    input(label, String(value), (value) => change(Number(value)), 'number')

  // Fields inside a titled group rely on its legend; top-level fields carry their own prefix.
  const scoped = (prefix: string, text: string) =>
    prefix ? `${prefix} ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text

  const presentation = (
    prefix: string,
    value: {
      label: string
      labelKey?: string | undefined
      description: string
      descriptionKey?: string | undefined
    },
  ) => [
    input(scoped(prefix, t('form.name')), value.label, (next) => {
      value.label = next
    }),
    translation(scoped(prefix, t('form.nameTranslation')), value.labelKey ?? '', keys, (next) => {
      value.labelKey = next || undefined
    }),
    input(scoped(prefix, t('metadata.description')), value.description, (next) => {
      value.description = next
    }),
    translation(
      scoped(prefix, t('form.descriptionTranslation')),
      value.descriptionKey ?? '',
      keys,
      (next) => {
        value.descriptionKey = next || undefined
      },
    ),
  ]

  for (const [id, move] of Object.entries(draft.moves))
    result.push(
      group(
        t('combat.moveTitle', { id }),
        ...presentation('', move),
        number(t('combat.apCost'), move.apCost, (value) => {
          move.apCost = value
        }),
        number(t('combat.cooldown'), move.cooldown ?? 0, (value) => {
          move.cooldown = value || undefined
        }),
        ...(move.type === 'ability'
          ? [
              select(t('combat.abilityTarget'), move.target, ['self', 'enemy'], (value) => {
                move.target = value
              }),
              ...abilityEffectsForm(
                controls,
                { statuses: availableStatuses },
                move.effects,
                render,
              ),
            ]
          : []),
        ...(move.type === 'attack'
          ? [
              number(t('combat.minDamage'), move.damage.min, (value) => {
                move.damage.min = value
              }),
              number(t('combat.maxDamage'), move.damage.max, (value) => {
                move.damage.max = value
              }),
            ]
          : move.type === 'guard'
            ? [
                number(t('combat.guardPoints'), move.guard, (value) => {
                  move.guard = value
                }),
              ]
            : []),
        button(t('combat.removeMove', { id }), () => {
          delete draft.moves[id]
          controls.markEdited()
          render()
        }),
      ),
    )

  let nextId = ''
  result.push(
    input(t('combat.newMoveId'), nextId, (value) => {
      nextId = value.trim()
    }),
  )

  for (const type of ['attack', 'guard', 'ability'] as const)
    result.push(
      button(t('combat.addMove', { type }), () => {
        let id = nextId || type
        let index = 1

        while (Object.hasOwn(draft.moves, id)) id = `${nextId || type}-${index++}`
        draft.moves[id] =
          type === 'attack'
            ? { type, label: 'Attack', description: '', apCost: 1, damage: { min: 2, max: 4 } }
            : type === 'guard'
              ? { type, label: 'Guard', description: '', apCost: 1, guard: 4 }
              : {
                  type,
                  label: 'Recover',
                  description: '',
                  apCost: 1,
                  target: 'self',
                  effects: [{ id: 'heal', type: 'heal', amount: 5 }],
                }
        onAdd?.(id)
        controls.markEdited()
        render()
      }),
    )

  return result
}
