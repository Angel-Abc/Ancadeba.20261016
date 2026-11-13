import type { ProjectView } from '@ancadeba/editor-core'
import {
  combatStatNames,
  combatBonusesSchema,
  gameBindingSchema,
  type InventoryDefinition,
} from '@ancadeba/schemas'
import { onOffChoices, type RuleFormControls, translationChoices } from './ruleFormControls.js'
import { equipmentCombatForm } from './equipmentCombatForm.js'

export function itemPresentationForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: InventoryDefinition['itemTypes'][string],
  render: () => void,
): HTMLElement[] {
  const { input, select, group, button, translation, t } = controls
  const keys = translationChoices(view)

  const art = [
    '',
    ...Object.keys(view.assets?.images ?? {}),
    ...Object.keys(view.assets?.parts ?? {}),
    ...Object.keys(view.assets?.compositions ?? {}),
  ]

  const fields: HTMLElement[] = [
    equipmentCombatForm(controls, view, draft, render),
    select(
      t('items.equipmentEffects'),
      draft.combatBonuses ? 'enabled' : 'disabled',
      onOffChoices(t),
      (value) => {
        draft.combatBonuses = value === 'enabled' ? combatBonusesSchema.parse({}) : undefined
        render()
      },
    ),
    ...(draft.combatBonuses
      ? combatStatNames.map((stat) =>
          input(
            t('items.statBonus', { stat }),
            String(draft.combatBonuses![stat]),
            (value) => {
              draft.combatBonuses![stat] = Number(value)
            },
            'number',
          ),
        )
      : []),
    input(t('items.itemName'), draft.label, (value) => {
      draft.label = value
    }),
    translation(t('form.nameTranslation'), draft.labelKey ?? '', keys, (value) => {
      draft.labelKey = value || undefined
    }),
    input(t('metadata.description'), draft.description, (value) => {
      draft.description = value
    }),
    translation(t('form.descriptionTranslation'), draft.descriptionKey ?? '', keys, (value) => {
      draft.descriptionKey = value || undefined
    }),
    select(t('items.largeArtwork'), draft.artwork ?? '', art, (value) => {
      draft.artwork = value || undefined
    }),
  ]

  draft.properties.forEach((property, index) => {
    const type = typeof property.value === 'object' ? 'binding' : typeof property.value

    const box = group(
      t('items.property', { number: index + 1 }),
      input(t('items.propertyId'), property.id, (value) => {
        property.id = value.trim()
      }),
      input(t('items.propertyLabel'), property.label, (value) => {
        property.label = value
      }),
      translation(t('items.propertyLabelTranslation'), property.labelKey ?? '', keys, (value) => {
        property.labelKey = value || undefined
      }),
      select(
        t('items.propertyValueType'),
        type,
        [
          ['string', t('tree.text')],
          ['number', t('form.number')],
          ['binding', t('items.gameValue')],
        ],
        (value) => {
          property.value =
            value === 'binding'
              ? {
                  source: 'game.state',
                  path: view.rules?.state.find((field) => typeof field.value !== 'boolean')
                    ?.path ?? ['value'],
                }
              : value === 'number'
                ? 0
                : ''
          delete property.valueKey
          render()
        },
      ),
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
        select(t('items.propertyBinding'), JSON.stringify(binding), choices, (value) => {
          property.value = gameBindingSchema.parse(JSON.parse(value))
        }),
      )
    } else
      box.append(
        input(
          t('items.propertyValue'),
          String(property.value),
          (value) => {
            property.value = type === 'number' ? Number(value) : value
          },
          type === 'number' ? 'number' : 'text',
        ),
      )

    if (typeof property.value === 'string')
      box.append(
        translation(t('items.propertyValueTranslation'), property.valueKey ?? '', keys, (value) => {
          property.valueKey = value || undefined
        }),
      )
    box.append(
      button(
        t('items.movePropertyUp'),
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
      button(t('items.removeProperty'), () => {
        draft.properties.splice(index, 1)
        controls.markEdited()
        render()
      }),
    )
    fields.push(box)
  })
  fields.push(
    button(t('items.addProperty'), () => {
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
