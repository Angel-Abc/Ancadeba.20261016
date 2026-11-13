import { combatAIProfileSchema, type CombatLibrary } from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { combatEnemyAIForm } from './combatEnemyAIForm.js'
import { translationChoices, type RuleFormControls } from './ruleFormControls.js'

export function combatAIProfilesForm(
  controls: RuleFormControls,
  view: ProjectView,
  library: CombatLibrary,
  render: () => void,
): HTMLElement {
  const { input, group, button, translation, create, t } = controls
  const text = (key: string) => t(`combat.aiProfiles.${key}`)

  const edit = (action: () => void) => () => {
    action()
    controls.markEdited()
    render()
  }

  let nextId = 'profile'

  return group(
    text('heading'),
    ...Object.entries(library.aiProfiles ?? {}).map(([id, profile]) => {
      const usage = create('p')
      usage.textContent = t('combat.aiProfiles.usage', {
        encounters:
          Object.values(view.combatSources ?? {})
            .filter((source) =>
              source.enemies.some(
                (enemy) => enemy.aiProfile?.library === library.id && enemy.aiProfile.id === id,
              ),
            )
            .map((source) => source.id)
            .join(', ') || t('combat.none'),
      })
      const help = create('p')
      help.textContent = text('profileHelp')

      return group(
        t('combat.aiProfiles.title', { id }),
        usage,
        help,
        input(t('form.name'), profile.label, (value) => {
          profile.label = value
        }),
        translation(
          t('form.nameTranslation'),
          profile.labelKey ?? '',
          translationChoices(view),
          (value) => {
            profile.labelKey = value || undefined
          },
        ),
        input(t('metadata.description'), profile.description, (value) => {
          profile.description = value
        }),
        translation(
          t('form.descriptionTranslation'),
          profile.descriptionKey ?? '',
          translationChoices(view),
          (value) => {
            profile.descriptionKey = value || undefined
          },
        ),
        input(text('actors'), profile.actors.join(', '), (value) => {
          profile.actors = value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        }),
        button(
          text('applyActors'),
          edit(() => {}),
        ),
        combatEnemyAIForm(
          controls,
          { id: 'self', ai: profile.ai, moves: Object.keys(library.moves) },
          ['self', ...profile.actors].map((id) => ({ id, label: id })),
          undefined,
          Object.keys(library.statuses),
          render,
          { allowRemoval: false, freeReferences: true },
        ),
        button(
          text('remove'),
          edit(() => {
            delete library.aiProfiles![id]
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
        let id = nextId || 'profile'
        let count = 1

        while (Object.hasOwn(library.aiProfiles ?? {}, id)) id = `${nextId || 'profile'}-${count++}`
        library.aiProfiles ??= {}
        library.aiProfiles[id] = combatAIProfileSchema.parse({
          label: id,
          actors: ['opponent'],
          ai: { rules: [] },
        })
      }),
    ),
  )
}
