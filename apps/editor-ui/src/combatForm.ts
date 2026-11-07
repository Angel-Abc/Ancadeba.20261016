import { combatMovesForm } from './combatMovesForm.js'
import { combatRewardsForm } from './combatRewardsForm.js'
import { combatStatusesForm } from './combatAbilitiesForm.js'
import type { ProjectView } from '@ancadeba/editor-core'
import {
  combatHealthSchema,
  combatTextSchema,
  gameBindingSchema,
  type CombatSource,
  resolveCombatSource,
  type CombatActorDefinition,
} from '@ancadeba/schemas'
import { humanizeCode, type RuleFormControls, translationChoices } from './ruleFormControls.js'

export function combatForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: CombatSource,
  render: () => void,
): HTMLElement[] {
  const { input, select, group, button, create, translation } = controls
  const keys = translationChoices(view)

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
    input(scoped(prefix, 'Name'), value.label, (next) => {
      value.label = next
    }),
    translation(scoped(prefix, 'Name translation'), value.labelKey ?? '', keys, (next) => {
      value.labelKey = next || undefined
    }),
    input(scoped(prefix, 'Description'), value.description, (next) => {
      value.description = next
    }),
    translation(
      scoped(prefix, 'Description translation'),
      value.descriptionKey ?? '',
      keys,
      (next) => {
        value.descriptionKey = next || undefined
      },
    ),
  ]

  const actorForm = (actor: CombatActorDefinition, title: string, ...actions: HTMLElement[]) =>
    group(
      title,
      input('ID', actor.id, (value) => {
        actor.id = value.trim()
      }),
      ...presentation('', actor),
      select('Portrait', actor.portrait ?? '', art, (value) => {
        actor.portrait = value || undefined
      }),
      select(
        'Equipment stat owner',
        actor.equipmentOwner ?? '',
        [
          '',
          ...Object.entries(view.inventory?.owners ?? {})
            .filter(([, owner]) => owner.combatStats)
            .map(([id]) => id),
        ],
        (value) => {
          actor.equipmentOwner = value || undefined
          const stats = view.inventory?.owners[value]?.combatStats

          if (stats) {
            actor.health = structuredClone(stats.health)
            actor.maximumHealth = structuredClone(stats.maximumHealth)
          }

          render()
        },
      ),
      select('Health field', JSON.stringify(actor.health), fields, (value) => {
        actor.health = combatHealthSchema.parse(JSON.parse(value))
      }),
      select(
        'Maximum health source',
        typeof actor.maximumHealth === 'number' ? 'fixed' : 'binding',
        ['fixed', 'binding'],
        (value) => {
          actor.maximumHealth = value === 'fixed' ? 40 : { ...actor.health }
          render()
        },
      ),
      typeof actor.maximumHealth === 'number'
        ? number('Maximum health', actor.maximumHealth, (value) => {
            actor.maximumHealth = value
          })
        : select('Maximum health field', JSON.stringify(actor.maximumHealth), fields, (value) => {
            actor.maximumHealth = gameBindingSchema.parse(JSON.parse(value))
          }),
      number('AP', actor.ap, (value) => {
        actor.ap = value
      }),
      input('Available moves (IDs)', actor.moves.join(', '), (value) => {
        actor.moves = value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      }),
      ...(actor === draft.player
        ? [
            select(
              'Leveling profile',
              actor.leveling ?? '',
              ['', ...Object.keys(view.leveling ?? {})],
              (value) => {
                actor.leveling = value || undefined

                if (!value) actor.moveLevels = undefined
                render()
              },
            ),
            ...(actor.leveling
              ? actor.moves.map((move) =>
                  number(`Move ${move} minimum level`, actor.moveLevels?.[move] ?? 1, (value) => {
                    actor.moveLevels = { ...actor.moveLevels, [move]: value }
                  }),
                )
              : []),
          ]
        : [
            input('Rotation (IDs)', actor.rotation.join(', '), (value) => {
              actor.rotation = value
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean)
            }),
          ]),
      ...actions,
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
      actorForm(
        actor,
        `Enemy ${index + 1}`,
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

  result.push(
    ...combatMovesForm(
      controls,
      view,
      draft,
      render,
      (id) => draft.player.moves.push(id),
      resolveCombatSource(draft, new Map(Object.entries(view.combatLibraries ?? {}))).definition
        ?.statuses ?? draft.statuses,
    ),
  )
  result.push(
    group(
      'Outcome destinations',
      ...(['victory', 'defeat', 'escaped'] as const).map((outcome) =>
        select(
          `${humanizeCode(outcome)} destination`,
          draft.outcomes[outcome] ?? '',
          ['', ...view.scenes.map((scene) => scene.id)],
          (value) => {
            draft.outcomes[outcome] = value || undefined
          },
        ),
      ),
    ),
  )
  result.push(combatRewardsForm(controls, view, draft, render))
  result.push(combatStatusesForm(controls, view, draft, render))
  const messages = create('details')
  const summary = create('summary')
  summary.textContent = 'Combat text and translations'
  messages.append(summary)

  for (const code of combatTextSchema.keyof().options)
    messages.append(
      group(
        humanizeCode(code),
        input(`${humanizeCode(code)} text`, draft.messages[code], (value) => {
          draft.messages[code] = value
        }),
        translation(
          `${humanizeCode(code)} translation`,
          draft.messageKeys[code] ?? '',
          keys,
          (value) => {
            if (value) draft.messageKeys[code] = value
            else delete draft.messageKeys[code]
          },
        ),
      ),
    )
  result.push(messages)

  return result
}
