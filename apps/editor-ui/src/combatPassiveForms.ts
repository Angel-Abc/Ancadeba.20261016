import {
  combatPassiveSchema,
  bindingAliasSchema,
  type CombatLibrary,
  type CombatPassiveReference,
} from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { combatMechanicsForm } from './combatMechanicsForm.js'
import { translationChoices, type RuleFormControls } from './ruleFormControls.js'

export function combatPassiveGrantsForm(
  controls: RuleFormControls,
  view: ProjectView,
  owner: { passives?: CombatPassiveReference[] | undefined },
  render: () => void,
): HTMLElement {
  const { group, select, button, t } = controls

  const available = Object.entries(view.combatLibraries ?? {}).flatMap(([library, data]) =>
    Object.entries(data.passives ?? {})
      .filter(
        ([id]) =>
          !owner.passives?.some(
            (reference) => reference.library === library && reference.id === id,
          ),
      )
      .map(
        ([id, passive]) =>
          [`${library}/${id}`, `${passive.label || id} (${library}/${id})`] as const,
      ),
  )

  let choice = available[0]?.[0] ?? ''

  return group(
    t('combat.passives.grants'),
    ...(owner.passives ?? []).map((reference, index) =>
      group(
        `${reference.library}/${reference.id}`,
        button(t('combat.passives.removeGrant'), () => {
          owner.passives!.splice(index, 1)
          controls.markEdited()
          render()
        }),
      ),
    ),
    select(
      t('combat.passives.choose'),
      choice,
      available,
      (value) => {
        choice = value
      },
      false,
    ),
    button(
      t('combat.passives.grant'),
      () => {
        const [library, id] = choice.split('/')

        if (library && id) owner.passives = [...(owner.passives ?? []), { library, id }]
        controls.markEdited()
        render()
      },
      !choice || (owner.passives?.length ?? 0) >= 20,
    ),
    button(
      t('combat.passives.clear'),
      () => {
        owner.passives = undefined
        controls.markEdited()
        render()
      },
      !owner.passives?.length,
    ),
  )
}

export function combatPassivesForm(
  controls: RuleFormControls,
  view: ProjectView,
  library: CombatLibrary,
  render: () => void,
): HTMLElement {
  const { group, input, button, translation, t, create } = controls
  const text = (key: string) => t(`combat.passives.${key}`)
  const help = create('p')
  help.textContent = text('help')
  let nextId = 'passive'

  return group(
    text('heading'),
    help,
    ...Object.entries(library.passives ?? {}).map(([id, passive]) => {
      const mechanics = {
        resources: {},
        phases: {},
        triggers: passive.triggers,
        victory: 'enemies-defeated' as const,
      }

      const refresh = () => {
        passive.triggers = mechanics.triggers
        render()
      }

      return group(
        t('combat.passives.title', { id }),
        input(t('form.name'), passive.label, (value) => {
          passive.label = value
        }),
        translation(
          t('form.nameTranslation'),
          passive.labelKey ?? '',
          translationChoices(view),
          (value) => {
            passive.labelKey = value || undefined
          },
        ),
        input(t('metadata.description'), passive.description, (value) => {
          passive.description = value
        }),
        translation(
          t('form.descriptionTranslation'),
          passive.descriptionKey ?? '',
          translationChoices(view),
          (value) => {
            passive.descriptionKey = value || undefined
          },
        ),
        combatMechanicsForm(
          controls,
          view,
          {
            mechanics,
            statuses: library.statuses,
            player: { id: 'self', label: text('self') },
            enemies: [],
          },
          refresh,
          library.statuses,
          false,
          [],
          true,
        ),
        button(text('remove'), () => {
          delete library.passives?.[id]
          controls.markEdited()
          render()
        }),
      )
    }),
    input(text('newId'), nextId, (value) => {
      nextId = value.trim()
    }),
    button(
      text('add'),
      () => {
        if (
          !bindingAliasSchema.safeParse(nextId).success ||
          ['__proto__', 'prototype', 'constructor'].includes(nextId) ||
          Object.hasOwn(library.passives ?? {}, nextId)
        )
          return
        ;(library.passives ??= {})[nextId] = combatPassiveSchema.parse({
          label: nextId,
          triggers: {
            recover: {
              event: 'turn-start',
              actor: 'self',
              effects: [{ type: 'change-resource', resource: 'exhaustion', amount: -1 }],
            },
          },
        })
        controls.markEdited()
        render()
      },
      Object.keys(library.passives ?? {}).length >= 100,
    ),
  )
}
