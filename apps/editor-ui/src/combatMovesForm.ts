import { combatRequirementsForm } from './combatRequirementsForm.js'
import { combatScalingForm } from './combatScalingForm.js'
import type { CombatSource } from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { abilityEffectsForm } from './combatAbilitiesForm.js'
import { displayLabel, translationChoices, type RuleFormControls } from './ruleFormControls.js'

export function combatMovesForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: Pick<CombatSource, 'moves' | 'statuses' | 'mechanics'>,
  render: () => void,
  onAdd?: (id: string) => void,
  availableStatuses = draft.statuses,
  actors: readonly { id: string; label: string }[] = [],
): HTMLElement[] {
  const { input, select, button, group, fold, translation, t } = controls
  const keys = translationChoices(view)
  const result: HTMLElement[] = []

  // A summary names the move, so a long list can be scanned while its forms stay folded.
  const summary = (id: string, move: { label?: string; labelKey?: string | undefined }) => {
    const name = displayLabel(view, id, move)
    const title = t('combat.moveTitle', { id })

    return name === id ? title : `${title} · ${name}`
  }

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
      fold(
        `move:${id}`,
        summary(id, move),
        false,
        group(
          t('combat.moveTitle', { id }),
          ...presentation('', move),
          input(
            t('combat.restrictions.moveCategories'),
            move.categories?.join(', ') ?? '',
            (value) => {
              const ids = value
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean)

              move.categories = ids.length ? ids : undefined
            },
          ),
          combatRequirementsForm(
            controls,
            move,
            {
              resources: Object.keys(draft.mechanics?.resources ?? {}),
              statuses: Object.keys(availableStatuses ?? {}),
              phases: Object.keys(draft.mechanics?.phases ?? {}),
              actors: actors.map((actor) => [actor.id, actor.label || actor.id] as const),
              defaultActor: 'self',
              freeReferences: !actors.length,
            },
            render,
          ),
          number(t('combat.apCost'), move.apCost, (value) => {
            move.apCost = value
          }),
          combatScalingForm(
            controls,
            t('combat.scaling.apCost'),
            move.apCostScaling,
            (value) => {
              move.apCostScaling = value
            },
            render,
            Object.keys(draft.mechanics?.resources ?? {}),
            Object.keys(availableStatuses ?? {}),
          ),
          number(t('combat.cooldown'), move.cooldown ?? 0, (value) => {
            move.cooldown = value || undefined
          }),
          group(
            t('combat.mechanics.costs'),
            ...Object.entries(move.resourceCosts ?? {}).map(([id, amount]) => {
              let resource = id

              return group(
                id,
                input(t('combat.mechanics.resourceId'), resource, (value) => {
                  const next = value.trim()

                  if (!next || next === resource || Object.hasOwn(move.resourceCosts ?? {}, next))
                    return
                  const cost = move.resourceCosts![resource]!

                  if (move.resourceCostScaling?.[resource]) {
                    move.resourceCostScaling[next] = move.resourceCostScaling[resource]!
                    delete move.resourceCostScaling[resource]
                  }

                  delete move.resourceCosts![resource]
                  move.resourceCosts![next] = cost
                  resource = next
                }),
                number(t('form.amount'), amount, (value) => {
                  move.resourceCosts![resource] = value
                }),
                combatScalingForm(
                  controls,
                  t('combat.scaling.resourceCost'),
                  move.resourceCostScaling?.[resource],
                  (value) => {
                    if (value) (move.resourceCostScaling ??= {})[resource] = value
                    else delete move.resourceCostScaling?.[resource]
                  },
                  render,
                  Object.keys(draft.mechanics?.resources ?? {}),
                  Object.keys(availableStatuses ?? {}),
                ),
                button(t('combat.mechanics.remove'), () => {
                  delete move.resourceCosts![resource]
                  delete move.resourceCostScaling?.[resource]
                  controls.markEdited()
                  render()
                }),
              )
            }),
            button(t('combat.mechanics.addCost'), () => {
              let id =
                Object.keys(draft.mechanics?.resources ?? {}).find(
                  (id) => !Object.hasOwn(move.resourceCosts ?? {}, id),
                ) ?? 'resource'

              let index = 1

              while (Object.hasOwn(move.resourceCosts ?? {}, id)) id = `resource-${index++}`
              move.resourceCosts = { ...move.resourceCosts, [id]: 1 }
              controls.markEdited()
              render()
            }),
          ),
          ...(move.type === 'ability'
            ? [
                select(t('combat.abilityTarget'), move.target, ['self', 'enemy'], (value) => {
                  move.target = value
                }),
                ...abilityEffectsForm(
                  controls,
                  { statuses: availableStatuses, mechanics: draft.mechanics },
                  move.effects,
                  render,
                ),
              ]
            : []),
          ...(move.type === 'attack'
            ? [
                input(t('combat.damage.type'), move.damageType ?? '', (value) => {
                  move.damageType = value.trim() || undefined
                }),
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
          ...(move.type !== 'ability'
            ? [
                combatScalingForm(
                  controls,
                  t('combat.scaling.effect'),
                  move.scaling,
                  (value) => {
                    move.scaling = value
                  },
                  render,
                  Object.keys(draft.mechanics?.resources ?? {}),
                  Object.keys(availableStatuses ?? {}),
                ),
              ]
            : []),
          button(t('combat.removeMove', { id }), () => {
            delete draft.moves[id]
            controls.markEdited()
            render()
          }),
        ),
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
        controls.unfold(`move:${id}`)
        controls.markEdited()
        render()
      }),
    )

  return result
}
