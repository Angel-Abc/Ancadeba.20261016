import {
  itemUseSchema,
  itemUseTextSchema,
  gameBindingSchema,
  type InventoryDefinition,
} from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { onOffChoices, type RuleFormControls, translationChoices } from './ruleFormControls.js'

export function itemUseForm(
  controls: RuleFormControls,
  view: ProjectView,
  item: InventoryDefinition['itemTypes'][string],
  render: () => void,
) {
  const { group, select, input, create, translation, t } = controls

  const abilities = Object.entries(view.combatLibraries ?? {}).flatMap(([library, data]) =>
    Object.entries(data.moves).flatMap(([id, move]) =>
      move.type === 'ability' ? [`${library}/${id}`] : [],
    ),
  )

  const rows: HTMLElement[] = [
    select(t('items.builtInUse'), item.use ? 'enabled' : 'disabled', onOffChoices(t), (value) => {
      const [library, id] = (abilities[0] ?? '/').split('/')
      item.use =
        value === 'enabled'
          ? itemUseSchema.parse({
              ability: { library: library || 'common', id: id || 'ability' },
              contexts: ['combat'],
            })
          : undefined
      render()
    }),
  ]

  const use = item.use

  if (use) {
    const move = view.combatLibraries?.[use.ability.library]?.moves[use.ability.id]
    const summary = create('p')
    summary.textContent = move
      ? t('items.abilitySummary', {
          label: move.labelKey ? (view.translations?.[move.labelKey] ?? move.label) : move.label,
          cost: move.apCost,
          cooldown: move.cooldown ?? 0,
        })
      : t('items.selectAbility')
    rows.push(
      select(
        t('items.sharedAbility'),
        `${use.ability.library}/${use.ability.id}`,
        abilities,
        (value) => {
          const [library, id] = value.split('/')

          if (library && id) use.ability = { library, id }
          render()
        },
      ),
      summary,
      select(t('items.consumption'), use.consumption, ['consume', 'keep'], (value) => {
        use.consumption = value
      }),
      select(
        t('items.availability'),
        use.contexts.join(','),
        [
          ['combat', t('items.combatOnly')],
          ['outside-combat', t('items.outsideCombat')],
          ['combat,outside-combat', t('items.both')],
        ],
        (value) => {
          use.contexts =
            value === 'combat,outside-combat'
              ? ['combat', 'outside-combat']
              : value === 'combat'
                ? ['combat']
                : ['outside-combat']
        },
      ),
      select(
        t('items.useEnablement'),
        use.enabledWhen ? JSON.stringify(use.enabledWhen) : '',
        [
          '',
          ...(view.rules?.state ?? [])
            .filter((field) => typeof field.value === 'boolean')
            .map(
              (field) =>
                [
                  JSON.stringify({ source: 'game.state', path: field.path }),
                  field.path.join('.'),
                ] as const,
            ),
        ],
        (value) => {
          use.enabledWhen = value ? gameBindingSchema.parse(JSON.parse(value)) : undefined
        },
      ),
    )

    const messages = create('details'),
      heading = create('summary')

    heading.textContent = t('items.useTexts')
    messages.append(heading)

    for (const key of itemUseTextSchema.keyof().options)
      messages.append(
        group(
          key,
          input(t('items.useText', { key }), use.messages[key], (value) => {
            use.messages[key] = value
          }),
          translation(
            t('items.useTranslation', { key }),
            use.messageKeys[key] ?? '',
            translationChoices(view),
            (value) => {
              if (value) use.messageKeys[key] = value
              else delete use.messageKeys[key]
            },
          ),
        ),
      )
    rows.push(messages)
  }

  return group(t('items.usable'), ...rows)
}
