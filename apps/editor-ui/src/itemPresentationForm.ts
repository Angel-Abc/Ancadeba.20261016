import type { ProjectView } from '@ancadeba/editor-core'
import {
  combatStatNames,
  combatBonusesSchema,
  gameBindingSchema,
  type InventoryDefinition,
} from '@ancadeba/schemas'
import { type RuleFormControls, translationChoices } from './ruleFormControls.js'

export function itemPresentationForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: InventoryDefinition['itemTypes'][string],
  render: () => void,
): HTMLElement[] {
  const { input, select, group, button, translation } = controls
  const keys = translationChoices(view)

  const art = [
    '',
    ...Object.keys(view.assets?.images ?? {}),
    ...Object.keys(view.assets?.parts ?? {}),
    ...Object.keys(view.assets?.compositions ?? {}),
  ]

  const fields: HTMLElement[] = [
    select(
      'Combat equipment effects',
      draft.combatBonuses ? 'enabled' : 'disabled',
      ['disabled', 'enabled'],
      (value) => {
        draft.combatBonuses = value === 'enabled' ? combatBonusesSchema.parse({}) : undefined
        render()
      },
    ),
    ...(draft.combatBonuses
      ? combatStatNames.map((stat) =>
          input(
            `Equipment ${stat} bonus`,
            String(draft.combatBonuses![stat]),
            (value) => {
              draft.combatBonuses![stat] = Number(value)
            },
            'number',
          ),
        )
      : []),
    input('Item name', draft.label, (value) => {
      draft.label = value
    }),
    translation('Name translation', draft.labelKey ?? '', keys, (value) => {
      draft.labelKey = value || undefined
    }),
    input('Description', draft.description, (value) => {
      draft.description = value
    }),
    translation('Description translation', draft.descriptionKey ?? '', keys, (value) => {
      draft.descriptionKey = value || undefined
    }),
    select('Large artwork', draft.artwork ?? '', art, (value) => {
      draft.artwork = value || undefined
    }),
  ]

  draft.properties.forEach((property, index) => {
    const type = typeof property.value === 'object' ? 'binding' : typeof property.value

    const box = group(
      `Property ${index + 1}`,
      input('Property ID', property.id, (value) => {
        property.id = value.trim()
      }),
      input('Property label', property.label, (value) => {
        property.label = value
      }),
      translation('Property label translation', property.labelKey ?? '', keys, (value) => {
        property.labelKey = value || undefined
      }),
      select('Property value type', type, ['string', 'number', 'binding'], (value) => {
        property.value =
          value === 'binding'
            ? {
                source: 'game.state',
                path: view.rules?.state.find((field) => typeof field.value !== 'boolean')?.path ?? [
                  'value',
                ],
              }
            : value === 'number'
              ? 0
              : ''
        delete property.valueKey
        render()
      }),
    )

    if (typeof property.value === 'object') {
      const binding = property.value

      const choices = (view.rules?.state ?? [])
        .filter((field) => typeof field.value !== 'boolean')
        .map(
          (field) =>
            [
              JSON.stringify({ source: 'game.state', path: field.path }),
              field.path.join('.'),
            ] as const,
        )

      box.append(
        select('Property binding', JSON.stringify(binding), choices, (value) => {
          property.value = gameBindingSchema.parse(JSON.parse(value))
        }),
      )
    } else
      box.append(
        input(
          'Property value',
          String(property.value),
          (value) => {
            property.value = type === 'number' ? Number(value) : value
          },
          type === 'number' ? 'number' : 'text',
        ),
      )

    if (typeof property.value === 'string')
      box.append(
        translation('Property value translation', property.valueKey ?? '', keys, (value) => {
          property.valueKey = value || undefined
        }),
      )
    box.append(
      button(
        'Move property up',
        () => {
          ;[draft.properties[index - 1], draft.properties[index]] = [
            property,
            draft.properties[index - 1]!,
          ]
          controls.markEdited()
          render()
        },
        index === 0,
      ),
      button('Remove property', () => {
        draft.properties.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    fields.push(box)
  })
  fields.push(
    button('Add property', () => {
      let id = 'property'
      let number = 1

      while (draft.properties.some((property) => property.id === id)) id = `property-${number++}`
      draft.properties.push({ id, label: 'Property', value: '' })
      controls.markEdited()
      render()
    }),
  )

  return fields
}
