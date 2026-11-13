import { combatRulesetReferences } from '@ancadeba/schemas'
import { combatRulesetSchema, type CombatLibrary } from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { combatMechanicsForm } from './combatMechanicsForm.js'
import { translationChoices, type RuleFormControls } from './ruleFormControls.js'

export function combatRulesetsForm(
  controls: RuleFormControls,
  view: ProjectView,
  library: CombatLibrary,
  render: () => void,
): HTMLElement {
  const { input, group, button, translation, create, t } = controls
  const text = (key: string) => t(`combat.rulesets.${key}`)

  const edit = (action: () => void) => () => {
    action()
    controls.markEdited()
    render()
  }

  let nextId = 'ruleset'

  return group(
    text('heading'),
    ...Object.entries(library.rulesets ?? {}).map(([id, ruleset]) => {
      const usage = create('p')

      const encounters = Object.values(view.combatSources ?? {}).filter((source) =>
        combatRulesetReferences(source).some(
          (reference) => reference.library === library.id && reference.id === id,
        ),
      )

      usage.textContent = t('combat.rulesets.usage', {
        encounters: encounters.map((source) => source.id).join(', ') || t('combat.none'),
      })

      const mechanicsDraft = {
        mechanics: ruleset.mechanics,
        statuses: library.statuses,
        player: { id: ruleset.actors[0] ?? 'player', label: ruleset.actors[0] ?? 'player' },
        enemies: ruleset.actors.slice(1).map((id) => ({ id, label: id })),
      }

      return group(
        t('combat.rulesets.title', { id }),
        usage,
        input(t('form.name'), ruleset.label, (value) => {
          ruleset.label = value
        }),
        translation(
          t('form.nameTranslation'),
          ruleset.labelKey ?? '',
          translationChoices(view),
          (value) => {
            ruleset.labelKey = value || undefined
          },
        ),
        input(t('metadata.description'), ruleset.description, (value) => {
          ruleset.description = value
        }),
        translation(
          t('form.descriptionTranslation'),
          ruleset.descriptionKey ?? '',
          translationChoices(view),
          (value) => {
            ruleset.descriptionKey = value || undefined
          },
        ),
        input(text('actors'), ruleset.actors.join(', '), (value) => {
          ruleset.actors = value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        }),
        button(
          text('applyActors'),
          edit(() => {}),
        ),
        combatMechanicsForm(
          controls,
          view,
          mechanicsDraft,
          render,
          library.statuses,
          false,
          ruleset.actors.map((id) => ({ id, label: id })),
        ),
        button(
          text('remove'),
          edit(() => {
            delete library.rulesets![id]
          }),
        ),
      )
    }),
    input(text('newId'), nextId, (value) => {
      nextId = value.trim()
    }),
    button(
      text('add'),
      edit(() => {
        let id = nextId || 'ruleset'
        let count = 1

        while (Object.hasOwn(library.rulesets ?? {}, id)) id = `${nextId || 'ruleset'}-${count++}`
        library.rulesets ??= {}
        library.rulesets[id] = combatRulesetSchema.parse({
          label: id,
          actors: ['player', 'enemy'],
          mechanics: {},
        })
      }),
    ),
  )
}
