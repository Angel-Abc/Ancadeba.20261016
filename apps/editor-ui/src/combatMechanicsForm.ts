import { combatInterceptionForm } from './combatInterceptionForm.js'
import {
  combatMechanicsSchema,
  combatResourceSchema,
  combatPhaseSchema,
  combatTriggerSchema,
  combatTriggerEvents,
  combatEffectEvents,
  combatEffectDeliveries,
  combatEventActorReferences,
  combatEventValueFieldsFor,
  type CombatSource,
  type CombatActorDefinition,
  type CombatTriggerCondition,
  type CombatTriggerEffect,
} from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { translationChoices, type RuleFormControls } from './ruleFormControls.js'
import { combatConditionsForm, combatEffectConditionsForm } from './combatConditionsForm.js'
import { combatStatusStrengthForm } from './combatStatusStrengthForm.js'
import { combatEventValueForm } from './combatEventValueForm.js'

/** Structured encounter mechanics authoring; references are validated with the resolved encounter. */
export function combatMechanicsForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: Pick<CombatSource, 'mechanics' | 'statuses'> & {
    player: Pick<CombatActorDefinition, 'id' | 'label'>
    enemies: Pick<CombatActorDefinition, 'id' | 'label'>[]
  },
  render: () => void,
  statuses = draft.statuses,
  allowRemoval = true,
  rotationActors = draft.enemies,
  passive = false,
): HTMLElement {
  const { input, select, button, group, translation, t } = controls
  const text = (key: string) => t(`combat.mechanics.${key}`)

  const reference = (
    label: string,
    value: string,
    choices: readonly (string | readonly [string, string])[],
    change: (value: string) => void,
  ) =>
    passive
      ? input(label, value, (value) => change(value.trim()))
      : select(label, value, choices, change)

  const edit = (action: () => void) => () => {
    action()
    controls.markEdited()
    render()
  }

  const number = (label: string, value: number, change: (value: number) => void) =>
    input(label, String(value), (value) => change(Number(value)), 'number')

  const mechanics = draft.mechanics

  if (!mechanics)
    return group(
      text('heading'),
      button(
        text('enable'),
        edit(() => {
          draft.mechanics = combatMechanicsSchema.parse({})
        }),
      ),
    )

  const actors = [draft.player, ...draft.enemies].map(
    (actor) => [actor.id, actor.label || actor.id] as const,
  )

  const effectActors = [
    ...actors,
    ...combatEventActorReferences.map((id) => [id, t(`combat.events.${id}`)] as const),
  ]

  const resources = Object.keys(mechanics.resources)
  const phases = Object.keys(mechanics.phases)
  const statusIds = Object.keys(statuses ?? {})

  const unique = (id: string, values: Record<string, unknown>) => {
    let next = id || 'entry'
    let count = 1

    while (Object.hasOwn(values, next)) next = `${id || 'entry'}-${count++}`

    return next
  }

  const presentation = (entry: {
    label: string
    description: string
    labelKey?: string | undefined
    descriptionKey?: string | undefined
  }) => [
    input(t('form.name'), entry.label, (value) => {
      entry.label = value
    }),
    translation(
      t('form.nameTranslation'),
      entry.labelKey ?? '',
      translationChoices(view),
      (value) => {
        entry.labelKey = value || undefined
      },
    ),
    input(t('metadata.description'), entry.description, (value) => {
      entry.description = value
    }),
    translation(
      t('form.descriptionTranslation'),
      entry.descriptionKey ?? '',
      translationChoices(view),
      (value) => {
        entry.descriptionKey = value || undefined
      },
    ),
  ]

  const effectsForm = (effects: CombatTriggerEffect[], eventType?: string) => {
    const event = eventType !== undefined

    const fields: HTMLElement[] = effects.map((effect, index) =>
      group(
        `${text('effect')} ${index + 1}`,
        select(
          t('form.effectType'),
          effect.type,
          (
            [
              'change-resource',
              'set-resource',
              'apply-status',
              'remove-status',
              'set-phase',
              ...(eventType === 'damage-pending' || eventType === 'healing-pending'
                ? [
                    'adjust-effect',
                    ...(eventType === 'damage-pending'
                      ? ['absorb-damage', 'redirect-damage', 'prevent-lethal']
                      : []),
                  ]
                : ['finish', 'damage', 'heal']),
            ] as const
          ).map(
            (type) =>
              [
                type,
                ['adjust-effect', 'absorb-damage', 'redirect-damage', 'prevent-lethal'].includes(
                  type,
                )
                  ? t(`combat.interception.type.${type}`)
                  : type,
              ] as const,
          ),
          (type) => {
            effects[index] =
              type === 'adjust-effect'
                ? { type, amount: 0, percent: -50 }
                : type === 'absorb-damage'
                  ? { type, resource: resources[0] ?? 'resource', maximum: 8 }
                  : type === 'redirect-damage'
                    ? { type, actor: 'event.source', percent: 50 }
                    : type === 'prevent-lethal'
                      ? { type, minimumHealth: 1 }
                      : type === 'change-resource' || type === 'set-resource'
                        ? { type, resource: resources[0] ?? 'resource', amount: 1 }
                        : type === 'damage' || type === 'heal'
                          ? { type, actor: draft.player.id, amount: 1 }
                          : type === 'apply-status' || type === 'remove-status'
                            ? { type, actor: draft.player.id, status: statusIds[0] ?? 'status' }
                            : type === 'set-phase'
                              ? { type, phase: phases[0] ?? 'phase' }
                              : { type: 'finish', outcome: 'victory' }
            render()
          },
        ),
        ...('resource' in effect
          ? [
              reference(text('resource'), effect.resource, resources, (value) => {
                effect.resource = value
              }),
              ...('amount' in effect
                ? [
                    number(t('form.amount'), effect.amount, (value) => {
                      effect.amount = value
                    }),
                  ]
                : []),
            ]
          : []),
        ...('actor' in effect
          ? [
              reference(
                effect.type === 'redirect-damage'
                  ? t('combat.interception.recipient')
                  : effect.type === 'damage' || effect.type === 'heal'
                    ? t('combat.events.effectRecipient')
                    : text('actor'),
                effect.actor,
                event ? effectActors : actors,
                (value) => {
                  effect.actor = value
                },
              ),
            ]
          : []),
        ...('status' in effect
          ? [
              reference(t('form.status'), effect.status, statusIds, (value) => {
                effect.status = value
              }),
              ...combatStatusStrengthForm(controls, effect),
            ]
          : []),
        ...(effect.type === 'damage' || effect.type === 'heal'
          ? [
              reference(
                t('combat.events.effectSource'),
                effect.source ?? '',
                [['', t('combat.events.sameActor')], ...effectActors],
                (value) => {
                  effect.source = value || undefined
                },
              ),
              number(t('form.amount'), effect.amount, (value) => {
                effect.amount = value
              }),
              ...(effect.type === 'damage'
                ? [
                    input(t('combat.damage.type'), effect.damageType ?? '', (value) => {
                      effect.damageType = value.trim() || undefined
                    }),
                  ]
                : []),
            ]
          : []),
        ...((effect.type === 'change-resource' ||
          effect.type === 'set-resource' ||
          effect.type === 'damage' ||
          effect.type === 'heal') &&
        (event || effect.eventValue)
          ? [
              combatEventValueForm(
                controls,
                effect,
                render,
                eventType ? combatEventValueFieldsFor(eventType) : undefined,
              ),
            ]
          : []),
        ...('phase' in effect
          ? [
              reference(text('phase'), effect.phase, phases, (value) => {
                effect.phase = value
              }),
            ]
          : []),
        ...('outcome' in effect
          ? [
              select(text('outcome'), effect.outcome, ['victory', 'defeat'], (value) => {
                effect.outcome = value
              }),
            ]
          : []),
        ...combatInterceptionForm(controls, effect),
        combatEffectConditionsForm(
          controls,
          effect,
          {
            actors,
            resources,
            phases,
            statuses: statusIds,
            defaultActor: draft.player.id,
            freeReferences: passive,
            event,
            eventType,
          },
          render,
        ),
        button(
          t('combat.moveEffectUp'),
          edit(() => {
            if (index) [effects[index - 1], effects[index]] = [effects[index]!, effects[index - 1]!]
          }),
          index === 0,
        ),
        button(
          text('remove'),
          edit(() => {
            effects.splice(index, 1)
          }),
        ),
      ),
    )

    fields.push(
      button(
        text('addEffect'),
        edit(() => {
          effects.push({ type: 'change-resource', resource: resources[0] ?? 'resource', amount: 1 })
        }),
      ),
    )

    return fields
  }

  const conditionChoices = {
    actors,
    resources,
    phases,
    statuses: statusIds,
    defaultActor: draft.player.id,
    freeReferences: passive,
  }

  const conditionsForm = (conditions: CombatTriggerCondition[], eventType?: string) =>
    combatConditionsForm(
      controls,
      conditions,
      { ...conditionChoices, event: eventType !== undefined, eventType },
      render,
    )

  let resourceId = 'resource'
  let phaseId = 'phase'
  let triggerId = 'trigger'

  return group(
    text('heading'),
    ...(passive
      ? []
      : [
          select(
            text('victory'),
            mechanics.victory,
            [
              ['enemies-defeated', text('healthVictory')],
              ['triggers', text('triggerVictory')],
            ],
            (value) => {
              mechanics.victory = value
            },
          ),
          group(
            text('resources'),
            ...Object.entries(mechanics.resources).map(([id, resource]) =>
              group(
                id,
                ...presentation(resource),
                select(
                  text('actor'),
                  resource.actor ?? '',
                  [['', text('encounter')], ...actors],
                  (value) => {
                    resource.actor = value || undefined
                  },
                ),
                number(text('initial'), resource.initial, (value) => {
                  resource.initial = value
                }),
                number(text('maximum'), resource.maximum, (value) => {
                  resource.maximum = value
                }),
                button(
                  text('remove'),
                  edit(() => {
                    delete mechanics.resources[id]
                  }),
                ),
              ),
            ),
            input(text('resourceId'), resourceId, (value) => {
              resourceId = value.trim()
            }),
            button(
              text('addResource'),
              edit(() => {
                const id = unique(resourceId, mechanics.resources)
                mechanics.resources[id] = combatResourceSchema.parse({
                  label: id,
                  initial: 0,
                  maximum: 100,
                })
              }),
            ),
          ),
          group(
            text('phases'),
            select(
              text('initialPhase'),
              mechanics.initialPhase ?? '',
              [['', t('combat.notSet')], ...phases],
              (value) => {
                mechanics.initialPhase = value || undefined
              },
            ),
            ...Object.entries(mechanics.phases).map(([id, phase]) =>
              group(
                id,
                ...presentation(phase),
                group(text('onEnter'), ...effectsForm(phase.onEnter)),
                group(
                  text('rotations'),
                  ...rotationActors.map((enemy) =>
                    input(
                      enemy.label || enemy.id,
                      phase.enemyRotations?.[enemy.id]?.join(', ') ?? '',
                      (value) => {
                        const rotation = value
                          .split(',')
                          .map((id) => id.trim())
                          .filter(Boolean)

                        phase.enemyRotations ??= {}

                        if (rotation.length) phase.enemyRotations[enemy.id] = rotation
                        else delete phase.enemyRotations[enemy.id]
                      },
                    ),
                  ),
                ),
                button(
                  text('remove'),
                  edit(() => {
                    delete mechanics.phases[id]

                    if (mechanics.initialPhase === id)
                      mechanics.initialPhase = Object.keys(mechanics.phases)[0]
                  }),
                ),
              ),
            ),
            input(text('phaseId'), phaseId, (value) => {
              phaseId = value.trim()
            }),
            button(
              text('addPhase'),
              edit(() => {
                const id = unique(phaseId, mechanics.phases)
                mechanics.phases[id] = combatPhaseSchema.parse({ label: id })
                mechanics.initialPhase ??= id
              }),
            ),
          ),
        ]),
    group(
      text('triggers'),
      ...Object.entries(mechanics.triggers).map(([id, trigger]) =>
        group(
          id,
          select(
            text('event'),
            trigger.event,
            combatTriggerEvents.map((event) => [event, text(`event.${event}`)] as const),
            (value) => {
              trigger.event = value
              const effectEvent = combatEffectEvents.some((event) => event === value)

              if (!effectEvent) {
                trigger.source = undefined
                trigger.target = undefined
                trigger.delivery = undefined
                trigger.includeReactions = undefined
              }

              if (!value.startsWith('damage-')) trigger.damageType = undefined
              render()
            },
          ),
          ...(combatEffectEvents.some((event) => event === trigger.event)
            ? [
                reference(
                  t('combat.events.sourceFilter'),
                  trigger.source ?? '',
                  [['', text('any')], ...actors],
                  (value) => {
                    trigger.source = value || undefined
                  },
                ),
                reference(
                  t('combat.events.targetFilter'),
                  trigger.target ?? '',
                  [['', text('any')], ...actors],
                  (value) => {
                    trigger.target = value || undefined
                  },
                ),
                ...(trigger.event.startsWith('damage-')
                  ? [
                      input(
                        t('combat.events.damageTypeFilter'),
                        trigger.damageType ?? '',
                        (value) => {
                          trigger.damageType = value.trim() || undefined
                        },
                      ),
                    ]
                  : []),
                select(
                  t('combat.events.deliveryFilter'),
                  trigger.delivery ?? '',
                  [
                    ['', text('any')],
                    ...combatEffectDeliveries.map(
                      (id) => [id, t(`combat.events.delivery.${id}`)] as const,
                    ),
                  ],
                  (value) => {
                    trigger.delivery = value || undefined
                  },
                ),
                select(
                  t('combat.events.includeReactions'),
                  String(
                    trigger.includeReactions ??
                      (trigger.event === 'damage-pending' || trigger.event === 'healing-pending'),
                  ),
                  [
                    ['false', t('form.no')],
                    ['true', t('form.yes')],
                  ],
                  (value) => {
                    trigger.includeReactions = value === 'true' ? true : undefined
                  },
                ),
              ]
            : []),
          reference(
            text('actorFilter'),
            trigger.actor ?? '',
            [['', text('any')], ...actors],
            (value) => {
              trigger.actor = value || undefined
            },
          ),
          input(text('moveFilter'), trigger.move ?? '', (value) => {
            trigger.move = value.trim() || undefined
          }),
          reference(
            text('resourceFilter'),
            trigger.resource ?? '',
            [['', text('any')], ...resources],
            (value) => {
              trigger.resource = value || undefined
            },
          ),
          reference(
            t('combat.conditions.statusFilter'),
            trigger.status ?? '',
            [['', text('any')], ...statusIds],
            (value) => {
              trigger.status = value || undefined
            },
          ),
          reference(
            text('phaseFilter'),
            trigger.phase ?? '',
            [['', text('any')], ...phases],
            (value) => {
              trigger.phase = value || undefined
            },
          ),
          select(
            text('once'),
            String(trigger.once),
            [
              ['false', t('form.no')],
              ['true', t('form.yes')],
            ],
            (value) => {
              trigger.once = value === 'true'
            },
          ),
          group(
            text('conditions'),
            ...conditionsForm(
              trigger.conditions,
              combatEffectEvents.some((event) => event === trigger.event)
                ? trigger.event
                : undefined,
            ),
          ),
          group(
            text('effects'),
            ...effectsForm(
              trigger.effects,
              combatEffectEvents.some((event) => event === trigger.event)
                ? trigger.event
                : undefined,
            ),
          ),
          button(
            text('moveUp'),
            edit(() => {
              const entries = Object.entries(mechanics.triggers)
              const index = entries.findIndex(([key]) => key === id)

              if (index > 0)
                [entries[index - 1], entries[index]] = [entries[index]!, entries[index - 1]!]
              mechanics.triggers = Object.fromEntries(entries)
            }),
          ),
          button(
            text('remove'),
            edit(() => {
              delete mechanics.triggers[id]
            }),
          ),
        ),
      ),
      input(text('triggerId'), triggerId, (value) => {
        triggerId = value.trim()
      }),
      button(
        text('addTrigger'),
        edit(() => {
          const id = unique(triggerId, mechanics.triggers)
          mechanics.triggers[id] = combatTriggerSchema.parse({
            event: 'round-end',
            effects: [{ type: 'change-resource', resource: resources[0] ?? 'resource', amount: 1 }],
          })
        }),
      ),
    ),
    ...(allowRemoval
      ? [
          button(
            text('disable'),
            edit(() => {
              draft.mechanics = undefined
            }),
          ),
        ]
      : []),
  )
}
