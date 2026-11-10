import {
  combatStatNames,
  combatStatsTextSchema,
  statFieldSchema,
  type CombatStatsProfile,
} from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { translationChoices, type RuleFormControls } from './ruleFormControls.js'

export function combatStatsForm(
  controls: RuleFormControls,
  view: ProjectView,
  profile: CombatStatsProfile,
  render: () => void,
): HTMLElement[] {
  const { t } = controls

  const fields = (view.rules?.state ?? [])
    .filter((field) => typeof field.value === 'number')
    .map(
      (field) =>
        [JSON.stringify({ source: 'game.state', path: field.path }), field.path.join('.')] as const,
    )

  const result: HTMLElement[] = [
    controls.select(
      t('form.currentHealthField'),
      JSON.stringify(profile.health),
      fields,
      (value) => {
        profile.health = statFieldSchema.parse(JSON.parse(value))
      },
    ),
  ]

  for (const stat of combatStatNames) {
    const source = profile[stat]
    result.push(
      controls.group(
        t('combat.baseStat', { stat }),
        controls.select(
          t('form.source'),
          typeof source === 'number' ? '' : JSON.stringify(source),
          [['', t('form.constant')], ...fields],
          (value) => {
            profile[stat] = value ? statFieldSchema.parse(JSON.parse(value)) : 0
            render()
          },
        ),
        ...(typeof source === 'number'
          ? [
              controls.input(
                t('form.value'),
                String(source),
                (value) => {
                  profile[stat] = Number(value)
                },
                'number',
              ),
            ]
          : []),
      ),
    )
  }

  for (const key of combatStatsTextSchema.keyof().options)
    result.push(
      controls.group(
        t('combat.statText', { key }),
        controls.input(t('tree.text'), profile.messages[key], (value) => {
          profile.messages[key] = value
        }),
        controls.translation(
          t('form.translation'),
          profile.messageKeys[key] ?? '',
          translationChoices(view),
          (value) => {
            if (value) profile.messageKeys[key] = value
            else delete profile.messageKeys[key]
          },
        ),
      ),
    )

  return result
}
