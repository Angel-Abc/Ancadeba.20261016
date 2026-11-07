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
  const fields = (view.rules?.state ?? [])
    .filter((field) => typeof field.value === 'number')
    .map(
      (field) =>
        [JSON.stringify({ source: 'game.state', path: field.path }), field.path.join('.')] as const,
    )

  const result: HTMLElement[] = [
    controls.select('Current health field', JSON.stringify(profile.health), fields, (value) => {
      profile.health = statFieldSchema.parse(JSON.parse(value))
    }),
  ]

  for (const stat of combatStatNames) {
    const source = profile[stat]
    result.push(
      controls.group(
        `Base ${stat}`,
        controls.select(
          'Source',
          typeof source === 'number' ? '' : JSON.stringify(source),
          [['', 'Constant'], ...fields],
          (value) => {
            profile[stat] = value ? statFieldSchema.parse(JSON.parse(value)) : 0
            render()
          },
        ),
        ...(typeof source === 'number'
          ? [
              controls.input(
                'Value',
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
        `Stat text ${key}`,
        controls.input('Text', profile.messages[key], (value) => {
          profile.messages[key] = value
        }),
        controls.translation(
          'Translation',
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
