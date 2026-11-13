import { combatDamageTypeSchema, type CombatDamageDefenses } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

export function combatDamageDefensesForm(
  controls: RuleFormControls,
  owner: { damageDefenses?: CombatDamageDefenses | undefined },
  render: () => void,
): HTMLElement {
  const { group, input, select, button, t } = controls
  const text = (key: string) => t(`combat.damage.${key}`)

  const edit = (action: () => void) => () => {
    action()
    controls.markEdited()
    render()
  }

  const defenses = owner.damageDefenses

  const types = [
    ...new Set([
      ...Object.keys(defenses?.resistances ?? {}),
      ...Object.keys(defenses?.vulnerabilities ?? {}),
      ...(defenses?.immunities ?? []),
    ]),
  ]

  let addition =
    ['physical', 'fire', 'water', 'lightning', 'poison'].find((type) => !types.includes(type)) ??
    'damage'

  const help = controls.create('p')
  help.textContent = text('help')

  return group(
    text('heading'),
    help,
    ...types.map((type) =>
      group(
        t('combat.damage.typeTitle', { type }),
        ...(['resistances', 'vulnerabilities'] as const).map((kind) =>
          input(
            text(kind),
            String(
              Object.hasOwn(defenses?.[kind] ?? {}, type) ? (defenses?.[kind]?.[type] ?? 0) : 0,
            ),
            (value) => {
              const valueMap = (owner.damageDefenses ??= {})
              const percentages = (valueMap[kind] ??= {})
              percentages[type] = Number(value)
            },
            'number',
          ),
        ),
        select(
          text('immune'),
          String(defenses?.immunities?.includes(type) ?? false),
          [
            ['false', t('form.no')],
            ['true', t('form.yes')],
          ],
          (value) => {
            const entry = (owner.damageDefenses ??= {})
            entry.immunities = [
              ...(entry.immunities ?? []).filter((id) => id !== type),
              ...(value === 'true' ? [type] : []),
            ]
            render()
          },
        ),
        button(
          text('remove'),
          edit(() => {
            delete owner.damageDefenses?.resistances?.[type]
            delete owner.damageDefenses?.vulnerabilities?.[type]

            if (owner.damageDefenses?.immunities)
              owner.damageDefenses.immunities = owner.damageDefenses.immunities.filter(
                (id) => id !== type,
              )
          }),
        ),
      ),
    ),
    input(text('newType'), addition, (value) => {
      addition = value.trim()
    }),
    button(
      text('add'),
      edit(() => {
        if (combatDamageTypeSchema.safeParse(addition).success && !types.includes(addition)) {
          const entry = (owner.damageDefenses ??= {})
          const resistances = (entry.resistances ??= {})
          resistances[addition] = 0
        }
      }),
      types.length >= 100,
    ),
    button(
      text('clear'),
      edit(() => {
        owner.damageDefenses = undefined
      }),
      !defenses,
    ),
  )
}
