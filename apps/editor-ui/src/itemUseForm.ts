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
  const { group, select, input, create, translation } = controls

  const abilities = Object.entries(view.combatLibraries ?? {}).flatMap(([library, data]) =>
    Object.entries(data.moves).flatMap(([id, move]) =>
      move.type === 'ability' ? [`${library}/${id}`] : [],
    ),
  )

  const rows: HTMLElement[] = [
    select('Built-in item use', item.use ? 'enabled' : 'disabled', onOffChoices, (value) => {
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
      ? `${move.labelKey ? (view.translations?.[move.labelKey] ?? move.label) : move.label} · ${move.apCost} AP · cooldown ${move.cooldown ?? 0}. Edit this definition in Combat libraries.`
      : 'Select an existing shared ability.'
    rows.push(
      select(
        'Item shared ability',
        `${use.ability.library}/${use.ability.id}`,
        abilities,
        (value) => {
          const [library, id] = value.split('/')

          if (library && id) use.ability = { library, id }
          render()
        },
      ),
      summary,
      select('Item consumption', use.consumption, ['consume', 'keep'], (value) => {
        use.consumption = value
      }),
      select(
        'Item availability',
        use.contexts.join(','),
        [
          ['combat', 'Combat only'],
          ['outside-combat', 'Outside combat only'],
          ['combat,outside-combat', 'Combat and outside combat'],
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
        'Item-use enablement',
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

    heading.textContent = 'Item-use text and translations'
    messages.append(heading)

    for (const key of itemUseTextSchema.keyof().options)
      messages.append(
        group(
          key,
          input(`Item use ${key} text`, use.messages[key], (value) => {
            use.messages[key] = value
          }),
          translation(
            `Item use ${key} translation`,
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

  return group('Usable item', ...rows)
}
