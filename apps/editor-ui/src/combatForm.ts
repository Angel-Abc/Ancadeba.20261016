import { combatDamageDefensesForm } from './combatDamageForm.js'
import { combatRestrictionsForm } from './combatRestrictionsForm.js'
import { combatItemUseForm } from './combatItemUseForm.js'
import { combatEnemyProfileForm } from './combatEnemyProfileForm.js'
import { combatRulesetForm, combatDraftMechanics } from './combatRulesetForm.js'
import { combatMovesForm } from './combatMovesForm.js'
import { combatRewardsForm } from './combatRewardsForm.js'
import { combatStatusesForm } from './combatAbilitiesForm.js'
import type { ProjectView } from '@ancadeba/editor-core'
import {
  combatHealthSchema,
  combatEquipmentMoveReferences,
  combatTextSchema,
  gameBindingSchema,
  type CombatSource,
  moveStatusIds,
  resolveCombatSource,
  type CombatActorSource,
} from '@ancadeba/schemas'
import { humanizeCode, type RuleFormControls, translationChoices } from './ruleFormControls.js'
import { sceneChoices } from './choiceLabels.js'

export function combatForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: CombatSource,
  render: () => void,
  creating = false,
): HTMLElement[] {
  const { input, select, group, button, create, translation, t } = controls
  const keys = translationChoices(view)
  const availableStatuses = { ...draft.statuses }

  const resolved = resolveCombatSource(
    draft,
    new Map(Object.entries(view.combatLibraries ?? {})),
    undefined,
    view.inventory,
  )

  for (const [id, origin] of Object.entries(resolved.origins.statuses)) {
    const status = origin.library
      ? view.combatLibraries?.[origin.library]?.statuses[id]
      : draft.statuses?.[id]

    if (status) availableStatuses[id] = status
  }

  const addSharedStatus = (library: string, id: string) => {
    const status = view.combatLibraries?.[library]?.statuses[id]

    if (status) availableStatuses[id] = status
  }

  for (const ref of draft.sharedStatuses ?? []) addSharedStatus(ref.library, ref.id)

  const sharedMoves = [
    ...(draft.sharedMoves ?? []),
    ...(draft.itemUse?.itemTypes ?? []).flatMap((type) => {
      const ability = view.inventory?.itemTypes[type]?.use?.ability

      return ability ? [ability] : []
    }),
  ]

  for (const ref of sharedMoves) {
    const move = view.combatLibraries?.[ref.library]?.moves[ref.id]

    if (move) for (const id of moveStatusIds(move)) addSharedStatus(ref.library, id)
  }

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

  const actorForm = (actor: CombatActorSource, title: string, ...actions: HTMLElement[]) =>
    group(
      title,
      input(t('metadata.id'), actor.id, (value) => {
        actor.id = value.trim()
      }),
      ...presentation('', actor),
      select(t('form.portrait'), actor.portrait ?? '', art, (value) => {
        actor.portrait = value || undefined
      }),
      select(
        t('combat.statOwner'),
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
      select(t('combat.healthField'), JSON.stringify(actor.health), fields, (value) => {
        actor.health = combatHealthSchema.parse(JSON.parse(value))
      }),
      select(
        t('combat.maxHealthSource'),
        typeof actor.maximumHealth === 'number' ? 'fixed' : 'binding',
        ['fixed', 'binding'],
        (value) => {
          actor.maximumHealth = value === 'fixed' ? 40 : { ...actor.health }
          render()
        },
      ),
      typeof actor.maximumHealth === 'number'
        ? number(t('form.maxHealth'), actor.maximumHealth, (value) => {
            actor.maximumHealth = value
          })
        : select(t('form.maxHealthField'), JSON.stringify(actor.maximumHealth), fields, (value) => {
            actor.maximumHealth = gameBindingSchema.parse(JSON.parse(value))
          }),
      combatDamageDefensesForm(controls, actor, render),
      combatRestrictionsForm(controls, actor),
      number('AP', actor.ap, (value) => {
        actor.ap = value
      }),
      input(t('combat.availableMoves'), actor.moves.join(', '), (value) => {
        actor.moves = value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      }),
      ...(actor === draft.player
        ? [
            select(
              t('form.levelingProfile'),
              actor.leveling ?? '',
              ['', ...Object.keys(view.leveling ?? {})],
              (value) => {
                actor.leveling = value || undefined

                if (!value) actor.moveLevels = undefined
                render()
              },
            ),
            ...(actor.leveling
              ? [
                  ...new Set([
                    ...actor.moves,
                    ...combatEquipmentMoveReferences(view.inventory, actor.equipmentOwner).map(
                      (reference) => reference.id,
                    ),
                  ]),
                ].map((move) =>
                  number(
                    t('combat.moveMinLevel', { move }),
                    actor.moveLevels?.[move] ?? 1,
                    (value) => {
                      actor.moveLevels = { ...actor.moveLevels, [move]: value }
                    },
                  ),
                )
              : []),
          ]
        : [
            input(t('combat.rotation'), actor.rotation.join(', '), (value) => {
              actor.rotation = value
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean)
            }),
            combatEnemyProfileForm(
              controls,
              view,
              draft,
              actor,
              combatDraftMechanics(draft, view),
              Object.keys(availableStatuses),
              render,
            ),
          ]),
      ...actions,
    )

  const identity = input(t('combat.encounterId'), draft.id, (value) => {
    if (creating) draft.id = value.trim()
  })

  identity.querySelector('input')!.readOnly = !creating

  const result: HTMLElement[] = [
    identity,
    ...presentation(t('form.encounter'), draft),
    number(t('combat.seed'), draft.seed, (value) => {
      draft.seed = value
    }),
    number(t('combat.roundCost'), draft.roundTimeMs, (value) => {
      draft.roundTimeMs = value
    }),
    number(t('combat.logCapacity'), draft.logCapacity, (value) => {
      draft.logCapacity = value
    }),
    select(
      t('combat.allowEscape'),
      String(draft.allowEscape),
      [
        ['false', t('form.no')],
        ['true', t('form.yes')],
      ],
      (value) => {
        draft.allowEscape = value === 'true'
      },
    ),
    combatItemUseForm(controls, view, draft, render),
    actorForm(draft.player, t('form.player')),
  ]

  draft.enemies.forEach((actor, index) =>
    result.push(
      actorForm(
        actor,
        t('combat.enemyNumber', { number: index + 1 }),
        button(t('combat.removeEnemy', { number: index + 1 }), () => {
          draft.enemies.splice(index, 1)
          controls.markEdited()
          render()
        }),
      ),
    ),
  )
  result.push(
    button(t('combat.addEnemy'), () => {
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
      { ...draft, mechanics: combatDraftMechanics(draft, view) },
      render,
      (id) => draft.player.moves.push(id),
      availableStatuses,
      [draft.player, ...draft.enemies],
    ),
  )
  result.push(
    group(
      t('combat.outcomeDestinations'),
      ...(['victory', 'defeat', 'escaped'] as const).map((outcome) =>
        select(
          t('combat.outcomeDestination', { outcome: humanizeCode(outcome) }),
          draft.outcomes[outcome] ?? '',
          [['', t('combat.notSet')], ...sceneChoices(view)],
          (value) => {
            draft.outcomes[outcome] = value || undefined
          },
        ),
      ),
    ),
  )
  result.push(combatRewardsForm(controls, view, draft, render))
  result.push(combatStatusesForm(controls, view, draft, render))
  result.push(combatRulesetForm(controls, view, draft, render, availableStatuses))
  const messages = create('details')
  const summary = create('summary')
  summary.textContent = t('combat.texts')
  messages.append(summary)

  for (const code of combatTextSchema.keyof().options)
    messages.append(
      group(
        humanizeCode(code),
        input(t('combat.codeText', { code: humanizeCode(code) }), draft.messages[code], (value) => {
          draft.messages[code] = value
        }),
        translation(
          t('combat.codeTranslation', { code: humanizeCode(code) }),
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
