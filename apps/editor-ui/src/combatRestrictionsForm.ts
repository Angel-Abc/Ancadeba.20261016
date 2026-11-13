import type { RuleFormControls } from './ruleFormControls.js'

interface RestrictionOwner {
  statusImmunities?: string[] | undefined
  blockedMoveCategories?: string[] | undefined
}

export function combatRestrictionsForm(
  controls: RuleFormControls,
  owner: RestrictionOwner,
): HTMLElement {
  const { group, input, create, t } = controls
  const help = create('p')
  help.textContent = t('combat.restrictions.help')

  return group(
    t('combat.restrictions.heading'),
    help,
    input(
      t('combat.restrictions.immunities'),
      owner.statusImmunities?.join(', ') ?? '',
      (value) => {
        const ids = value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)

        owner.statusImmunities = ids.length ? ids : undefined
      },
    ),
    input(
      t('combat.restrictions.categories'),
      owner.blockedMoveCategories?.join(', ') ?? '',
      (value) => {
        const ids = value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)

        owner.blockedMoveCategories = ids.length ? ids : undefined
      },
    ),
  )
}
