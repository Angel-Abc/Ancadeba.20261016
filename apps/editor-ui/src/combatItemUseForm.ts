import type { CombatSource } from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import type { RuleFormControls } from './ruleFormControls.js'

export function combatItemUseForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: CombatSource,
  render: () => void,
) {
  const { group, select, input, create } = controls

  const rows: HTMLElement[] = [
    select(
      'Combat item use',
      draft.itemUse ? 'enabled' : 'disabled',
      ['disabled', 'enabled'],
      (value) => {
        draft.itemUse =
          value === 'enabled'
            ? {
                owner:
                  draft.player.equipmentOwner ?? Object.keys(view.inventory?.owners ?? {})[0] ?? '',
                itemTypes: Object.entries(view.inventory?.itemTypes ?? {})
                  .filter(([, item]) => item.use?.contexts.includes('combat'))
                  .map(([id]) => id),
              }
            : undefined
        render()
      },
    ),
  ]

  const use = draft.itemUse

  if (use) {
    const hint = create('p')
    hint.textContent = `Available types: ${Object.entries(view.inventory?.itemTypes ?? {})
      .filter(([, item]) => item.use?.contexts.includes('combat'))
      .map(([id]) => id)
      .join(
        ', ',
      )}. Shared abilities and statuses are included automatically; actor learned moves stay separate.`
    rows.push(
      select('Combat item owner', use.owner, Object.keys(view.inventory?.owners ?? {}), (value) => {
        use.owner = value
      }),
      input('Combat usable item types (IDs)', use.itemTypes.join(', '), (value) => {
        use.itemTypes = value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      }),
      hint,
    )
  }

  return group('Player item use', ...rows)
}
