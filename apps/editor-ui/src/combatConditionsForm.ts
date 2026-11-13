import {
  combatEventValueFields,
  combatEventFlagFields,
  combatEventActorReferences,
  combatEventValueFieldsFor,
  type CombatCondition,
} from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export interface CombatConditionChoices {
  actors?: readonly (readonly [string, string])[]
  resources: string[]
  statuses: string[]
  phases: string[]
  defaultActor?: string
  freeReferences?: boolean | undefined
  event?: boolean | undefined
  eventType?: string | undefined
}

/** One expression editor shared by AI, lifecycle triggers and conditional effects. */
export function combatConditionsForm(
  controls: RuleFormControls,
  conditions: CombatCondition[],
  choices: CombatConditionChoices,
  render: () => void,
  prefix = 'combat.mechanics',
  add = true,
): HTMLElement[] {
  const { group, select, input, button, t } = controls
  const text = (key: string) => t(`${prefix}.${key}`)
  const shared = (key: string) => t(`combat.conditions.${key}`)

  const edit = (action: () => void) => () => {
    action()
    controls.markEdited()
    render()
  }

  const leaf = (): CombatCondition =>
    prefix === 'combat.ai'
      ? { type: 'health', actor: choices.defaultActor ?? 'self', operator: 'lte', value: 10 }
      : {
          type: 'resource',
          resource: choices.resources[0] ?? 'resource',
          operator: 'gte',
          value: 1,
        }

  const reference = (
    label: string,
    value: string,
    values: readonly (string | readonly [string, string])[],
    change: (value: string) => void,
  ) =>
    choices.freeReferences
      ? input(label, value, (value) => change(value.trim()))
      : select(label, value, values, change)

  const node = (
    condition: CombatCondition,
    replace: (condition: CombatCondition) => void,
    remove: (() => void) | undefined,
    path: string,
    depth: number,
  ): HTMLElement => {
    const types: CombatCondition['type'][] = [
      'resource',
      'health',
      'status',
      'phase',
      ...(choices.event ? (['event-value', 'event-flag'] as const) : []),
      ...(depth < 8 ? (['and', 'or', 'not'] as const) : []),
    ]

    const fields: HTMLElement[] = [
      select(
        text('conditionType'),
        condition.type,
        types.map(
          (type) =>
            [
              type,
              ['and', 'or', 'not'].includes(type)
                ? shared(type)
                : type.startsWith('event-')
                  ? t(`combat.events.condition.${type}`)
                  : type,
            ] as const,
        ),
        (type) => {
          replace(
            type === 'and' || type === 'or'
              ? {
                  type,
                  conditions:
                    condition.type === 'and' || condition.type === 'or'
                      ? condition.conditions
                      : [condition],
                }
              : type === 'not'
                ? { type, condition }
                : type === 'event-value'
                  ? { type, field: 'amount', operator: 'gte', value: 1 }
                  : type === 'event-flag'
                    ? {
                        type,
                        field: choices.eventType?.startsWith('healing-') ? 'reactive' : 'immune',
                        value: true,
                      }
                    : type === 'phase'
                      ? { type, phase: choices.phases[0] ?? 'phase' }
                      : type === 'status'
                        ? {
                            type,
                            actor: choices.defaultActor ?? 'self',
                            status: choices.statuses[0] ?? 'status',
                            measure: 'stacks',
                            operator: 'gte',
                            value: 1,
                          }
                        : type === 'resource'
                          ? {
                              type,
                              resource: choices.resources[0] ?? 'resource',
                              operator: 'gte',
                              value: 1,
                            }
                          : {
                              type: 'health',
                              actor: choices.defaultActor ?? 'self',
                              operator: 'lte',
                              value: 10,
                            },
          )
          render()
        },
      ),
    ]

    if (condition.type === 'and' || condition.type === 'or') {
      fields.push(
        ...condition.conditions.map((child, index) =>
          node(
            child,
            (next) => {
              condition.conditions[index] = next
            },
            condition.conditions.length > 1
              ? () => {
                  condition.conditions.splice(index, 1)
                }
              : undefined,
            `${path}.${index + 1}`,
            depth + 1,
          ),
        ),
      )
      fields.push(
        button(
          shared('addChild'),
          edit(() => {
            condition.conditions.push(leaf())
          }),
          condition.conditions.length >= 20 || depth >= 8,
        ),
      )
    } else if (condition.type === 'not') {
      fields.push(
        node(
          condition.condition,
          (next) => {
            condition.condition = next
          },
          undefined,
          `${path}.1`,
          depth + 1,
        ),
      )
    } else {
      if ('actor' in condition)
        fields.push(
          reference(
            text('actor'),
            condition.actor,
            [
              ...(choices.actors ?? []),
              ['self', shared('self')],
              ['target', shared('target')],
              ...(choices.event
                ? combatEventActorReferences.map((id) => [id, t(`combat.events.${id}`)] as const)
                : []),
            ],
            (value) => {
              condition.actor = value
            },
          ),
        )

      if ('resource' in condition)
        fields.push(
          reference(text('resource'), condition.resource, choices.resources, (value) => {
            condition.resource = value
          }),
        )

      if ('status' in condition) {
        fields.push(
          reference(t('form.status'), condition.status, choices.statuses, (value) => {
            condition.status = value
          }),
        )
        fields.push(
          select(
            prefix === 'combat.ai' ? text('measure') : shared('measure'),
            condition.measure,
            ['stacks', 'intensity', 'remaining'],
            (value) => {
              condition.measure = value
            },
          ),
        )
      }

      if (condition.type === 'phase')
        fields.push(
          reference(text('phase'), condition.phase, choices.phases, (value) => {
            condition.phase = value
          }),
        )
      else if (condition.type === 'event-flag') {
        fields.push(
          select(
            t('combat.events.flag'),
            condition.field,
            combatEventFlagFields
              .filter((field) => field !== 'immune' || !choices.eventType?.startsWith('healing-'))
              .map((field) => [field, t(`combat.events.flag.${field}`)] as const),
            (value) => {
              condition.field = value
            },
          ),
        )
        fields.push(
          select(
            text('value'),
            String(condition.value),
            [
              ['false', t('form.no')],
              ['true', t('form.yes')],
            ],
            (value) => {
              condition.value = value === 'true'
            },
          ),
        )
      } else {
        if (condition.type === 'event-value')
          fields.push(
            select(
              t('combat.events.field'),
              condition.field,
              (choices.eventType
                ? combatEventValueFieldsFor(choices.eventType)
                : combatEventValueFields
              ).map((field) => [field, t(`combat.events.field.${field}`)] as const),
              (value) => {
                condition.field = value
              },
            ),
          )

        if (condition.type === 'health' || condition.type === 'resource')
          fields.push(
            select(
              shared('unit'),
              condition.unit ?? 'absolute',
              [
                ['absolute', shared('absolute')],
                ['percent', shared('percent')],
              ],
              (value) => {
                condition.unit = value === 'absolute' ? undefined : value
              },
            ),
          )
        fields.push(
          select(
            text('operator'),
            condition.operator,
            ['eq', 'gte', 'lte', 'gt', 'lt'],
            (value) => {
              condition.operator = value
            },
          ),
        )
        fields.push(
          input(
            text('value'),
            String(condition.value),
            (value) => {
              condition.value = Number(value)
            },
            'number',
          ),
        )
      }
    }

    if (remove)
      fields.push(button(text(prefix === 'combat.ai' ? 'removeCondition' : 'remove'), edit(remove)))

    return group(`${text('condition')} ${path}`, ...fields)
  }

  return [
    ...conditions.map((condition, index) =>
      node(
        condition,
        (next) => {
          conditions[index] = next
        },
        () => {
          conditions.splice(index, 1)
        },
        String(index + 1),
        1,
      ),
    ),
    ...(add
      ? [
          button(
            text('addCondition'),
            edit(() => {
              conditions.push(leaf())
            }),
          ),
        ]
      : []),
  ]
}

export function combatEffectConditionsForm(
  controls: RuleFormControls,
  effect: { conditions?: CombatCondition[] | undefined },
  choices: CombatConditionChoices,
  render: () => void,
): HTMLElement {
  return controls.group(
    controls.t('combat.conditions.effect'),
    ...combatConditionsForm(
      controls,
      effect.conditions ?? [],
      choices,
      render,
      'combat.mechanics',
      false,
    ),
    controls.button(controls.t('combat.conditions.addEffect'), () => {
      ;(effect.conditions ??= []).push({
        type: 'health',
        actor: choices.defaultActor ?? 'self',
        operator: 'lte',
        value: 50,
        unit: 'percent',
      })
      controls.markEdited()
      render()
    }),
  )
}
