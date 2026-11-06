import type { ProjectView } from '@ancadeba/editor-core'
import {
  combatHealthSchema,
  combatTextSchema,
  gameBindingSchema,
  type CombatDefinition,
  type CombatActorDefinition,
} from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export function combatForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: CombatDefinition,
  render: () => void,
): HTMLElement[] {
  const { input, select, group, button, create } = controls
  const keys = ['', ...(view.translationKeys ?? [])]

  const fields = (view.rules?.state ?? [])
    .filter((field) => typeof field.value === 'number')
    .map(
      (field) =>
        [JSON.stringify({ source: 'game.state', path: field.path }), field.path.join('.')] as const,
    )

  const art = [
    '',
    ...Object.keys(view.assets?.images ?? {}),
    ...Object.keys(view.assets?.parts ?? {}),
    ...Object.keys(view.assets?.compositions ?? {}),
  ]

  const number = (label: string, value: number, change: (value: number) => void) =>
    input(label, String(value), (value) => change(Number(value)), 'number')

  const presentation = (
    title: string,
    value: {
      label: string
      labelKey?: string | undefined
      description: string
      descriptionKey?: string | undefined
    },
  ) => [
    input(`${title} name`, value.label, (next) => {
      value.label = next
    }),
    select(`${title} name translation`, value.labelKey ?? '', keys, (next) => {
      value.labelKey = next || undefined
    }),
    input(`${title} description`, value.description, (next) => {
      value.description = next
    }),
    select(`${title} description translation`, value.descriptionKey ?? '', keys, (next) => {
      value.descriptionKey = next || undefined
    }),
  ]

  const actorForm = (actor: CombatActorDefinition, title: string) =>
    group(
      title,
      input(`${title} ID`, actor.id, (value) => {
        actor.id = value.trim()
      }),
      ...presentation(title, actor),
      select(`${title} portrait`, actor.portrait ?? '', art, (value) => {
        actor.portrait = value || undefined
      }),
      select(`${title} health field`, JSON.stringify(actor.health), fields, (value) => {
        actor.health = combatHealthSchema.parse(JSON.parse(value))
      }),
      select(
        `${title} maximum source`,
        typeof actor.maximumHealth === 'number' ? 'fixed' : 'binding',
        ['fixed', 'binding'],
        (value) => {
          actor.maximumHealth = value === 'fixed' ? 40 : { ...actor.health }
          render()
        },
      ),
      typeof actor.maximumHealth === 'number'
        ? number(`${title} maximum health`, actor.maximumHealth, (value) => {
            actor.maximumHealth = value
          })
        : select(`${title} maximum field`, JSON.stringify(actor.maximumHealth), fields, (value) => {
            actor.maximumHealth = gameBindingSchema.parse(JSON.parse(value))
          }),
      number(`${title} AP`, actor.ap, (value) => {
        actor.ap = value
      }),
      input(`${title} available moves (IDs)`, actor.moves.join(', '), (value) => {
        actor.moves = value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      }),
      ...(actor === draft.player
        ? []
        : [
            input(`${title} rotation (IDs)`, actor.rotation.join(', '), (value) => {
              actor.rotation = value
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean)
            }),
          ]),
    )

  const result: HTMLElement[] = [
    input('Encounter ID', draft.id, (value) => {
      draft.id = value.trim()
    }),
    ...presentation('Encounter', draft),
    number('Encounter seed', draft.seed, (value) => {
      draft.seed = value
    }),
    number('Round world-time cost (ms)', draft.roundTimeMs, (value) => {
      draft.roundTimeMs = value
    }),
    number('Combat log capacity', draft.logCapacity, (value) => {
      draft.logCapacity = value
    }),
    select(
      'Allow escape',
      String(draft.allowEscape),
      [
        ['false', 'No'],
        ['true', 'Yes'],
      ],
      (value) => {
        draft.allowEscape = value === 'true'
      },
    ),
    actorForm(draft.player, 'Player'),
  ]

  draft.enemies.forEach((actor, index) =>
    result.push(
      group(
        `Enemy ${index + 1}`,
        actorForm(actor, `Enemy ${index + 1}`),
        button(`Remove enemy ${index + 1}`, () => {
          draft.enemies.splice(index, 1)
          controls.markEdited()
          render()
        }),
      ),
    ),
  )
  result.push(
    button('Add enemy', () => {
      let id = 'enemy'
      let index = 1

      while ([draft.player, ...draft.enemies].some((actor) => actor.id === id))
        id = `enemy-${index++}`
      const move = Object.keys(draft.moves)[0] ?? ''
      draft.enemies.push({
        id,
        label: 'Opponent',
        description: '',
        health: { source: 'game.state', path: [`${id}-health`] },
        maximumHealth: 20,
        ap: 3,
        moves: move ? [move] : [],
        rotation: move ? [move] : [],
      })
      controls.markEdited()
      render()
    }),
  )

  for (const [id, move] of Object.entries(draft.moves))
    result.push(
      group(
        `Move: ${id}`,
        ...presentation(`Move ${id}`, move),
        number(`Move ${id} AP cost`, move.apCost, (value) => {
          move.apCost = value
        }),
        ...(move.type === 'attack'
          ? [
              number(`Move ${id} minimum damage`, move.damage.min, (value) => {
                move.damage.min = value
              }),
              number(`Move ${id} maximum damage`, move.damage.max, (value) => {
                move.damage.max = value
              }),
            ]
          : [
              number(`Move ${id} guard`, move.guard, (value) => {
                move.guard = value
              }),
            ]),
        button(`Remove move ${id}`, () => {
          delete draft.moves[id]
          controls.markEdited()
          render()
        }),
      ),
    )

  for (const type of ['attack', 'guard'] as const)
    result.push(
      button(`Add ${type} move`, () => {
        let id: string = type
        let index = 1

        while (Object.hasOwn(draft.moves, id)) id = `${type}-${index++}`
        draft.moves[id] =
          type === 'attack'
            ? { type, label: 'Attack', description: '', apCost: 1, damage: { min: 2, max: 4 } }
            : { type, label: 'Guard', description: '', apCost: 1, guard: 4 }
        draft.player.moves.push(id)
        controls.markEdited()
        render()
      }),
    )
  result.push(
    group(
      'Outcome destinations',
      ...(['victory', 'defeat', 'escaped'] as const).map((outcome) =>
        select(
          `${outcome} destination`,
          draft.outcomes[outcome] ?? '',
          ['', ...view.scenes.map((scene) => scene.id)],
          (value) => {
            draft.outcomes[outcome] = value || undefined
          },
        ),
      ),
    ),
  )
  const messages = create('details')
  const summary = create('summary')
  summary.textContent = 'Combat text and translations'
  messages.append(summary)

  for (const code of combatTextSchema.keyof().options)
    messages.append(
      group(
        code,
        input(`${code} text`, draft.messages[code], (value) => {
          draft.messages[code] = value
        }),
        select(`${code} translation`, draft.messageKeys[code] ?? '', keys, (value) => {
          if (value) draft.messageKeys[code] = value
          else delete draft.messageKeys[code]
        }),
      ),
    )
  result.push(messages)

  return result
}
