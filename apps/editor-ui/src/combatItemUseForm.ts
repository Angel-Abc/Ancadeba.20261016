import type { CombatSource } from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { onOffChoices, type RuleFormControls } from './ruleFormControls.js'

export function combatItemUseForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: CombatSource,
  render: () => void,
) {
  const { group, select, input, create, t } = controls

  const rows: HTMLElement[] = [
    select(
      t('combat.itemUse'),
      draft.itemUse ? 'enabled' : 'disabled',
      onOffChoices(t),
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
    hint.textContent = t('combat.itemUseHelp', {
      types: Object.entries(view.inventory?.itemTypes ?? {})
        .filter(([, item]) => item.use?.contexts.includes('combat'))
        .map(([id]) => id)
        .join(', '),
    })
    rows.push(
      select(
        t('combat.itemOwner'),
        use.owner,
        Object.keys(view.inventory?.owners ?? {}),
        (value) => {
          use.owner = value
        },
      ),
      input(t('combat.usableTypes'), use.itemTypes.join(', '), (value) => {
        use.itemTypes = value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      }),
      hint,
    )
  }

  return group(t('combat.playerItemUse'), ...rows)
}
