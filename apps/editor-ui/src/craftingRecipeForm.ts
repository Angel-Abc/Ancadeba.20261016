import type { ProjectView } from '@ancadeba/editor-core'
import type { InventoryDefinition } from '@ancadeba/schemas'
import { displayLabel, type RuleFormControls } from './ruleFormControls.js'
import { fieldPath } from './specialistEntries.js'

export function craftingRecipeForm(
  controls: RuleFormControls,
  view: ProjectView,
  item: InventoryDefinition['itemTypes'][string],
  render: () => void,
) {
  const { t, group, input, select, row, button } = controls
  const types = view.inventory?.itemTypes ?? {}
  const ingredients = item.recipe?.ingredients ?? {}
  const box = group(t('crafting.recipe'))

  for (const [id, quantity] of Object.entries(ingredients)) {
    const label = displayLabel(view, id, types[id] ?? {})
    box.append(
      row(
        fieldPath(
          input(
            t('crafting.quantity', { item: label }),
            String(quantity),
            (value) => {
              ingredients[id] = Number(value)
            },
            'number',
          ),
          'recipe',
          'ingredients',
          id,
        ),
        button(t('crafting.remove', { item: label }), () => {
          delete ingredients[id]

          if (!Object.keys(ingredients).length) delete item.recipe
          controls.markEdited()
          render()
        }),
      ),
    )
  }

  const choices = Object.entries(types)
    .filter(([id]) => !Object.hasOwn(ingredients, id))
    .map(([id, type]) => [id, displayLabel(view, id, type)] as const)

  if (choices.length)
    box.append(
      select(t('crafting.add'), '', ['', ...choices], (id) => {
        if (!id) return
        item.recipe ??= { ingredients: {} }
        item.recipe.ingredients[id] = 1
        render()
      }),
    )

  return controls.section('crafting', box)
}
