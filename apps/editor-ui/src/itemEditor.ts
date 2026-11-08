import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import {
  combatStatsProfileSchema,
  type CombatStatsProfile,
  equipmentComponentSchema,
  inventoryComponentSchema,
  itemDetailsComponentSchema,
  type InventoryDefinition,
  type ItemDetailsComponentDefinition,
  type EquipmentComponentDefinition,
  type InventoryComponentDefinition,
} from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import {
  placementFields,
  ruleFormControls,
  saveBar,
  translationChoices,
} from './ruleFormControls.js'
import { itemUseForm } from './itemUseForm.js'
import { itemPresentationForm } from './itemPresentationForm.js'
import { combatStatsForm } from './combatStatsForm.js'
import { bindInventoryEditor } from './inventoryEditor.js'

/** Revision conflicts preserve this independent draft, including edits to ordered properties. */
export function bindItemEditor(root: HTMLElement, save: (command: EditorCommand) => void) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  const inventoryRoot = document.createElement('section')
  const navigation = document.createElement('div')
  navigation.className = 'editor-mode-controls'
  root.replaceChildren(navigation, error, inventoryRoot, fields)
  const inventoryEditor = bindInventoryEditor(inventoryRoot, save)
  let definitions = true
  let view: ProjectView | undefined
  let path: string | undefined
  let sceneId = ''
  let target = ''
  let item: InventoryDefinition['itemTypes'][string] | undefined

  let component:
    | ItemDetailsComponentDefinition
    | EquipmentComponentDefinition
    | InventoryComponentDefinition
    | undefined

  let slots: [string, string][] | undefined
  let combatStats: CombatStatsProfile | undefined
  let dirty = false
  let busy = false

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const showDefinitions = (value: boolean) => {
    if (value !== definitions && (dirty || inventoryEditor.hasDrafts())) {
      error.textContent =
        'Save or discard the current inventory or item draft before switching editors.'

      return false
    }

    definitions = value
    error.textContent = ''
    fields.hidden = value
    inventoryRoot.hidden = !value
    definitionButton.setAttribute('aria-pressed', String(value))
    viewButton.setAttribute('aria-pressed', String(!value))

    return true
  }

  const definitionButton = controls.button('Inventory definitions', () => showDefinitions(true))

  const viewButton = controls.button('Item views and advanced settings', () =>
    showDefinitions(false),
  )

  navigation.append(definitionButton, viewButton)
  showDefinitions(true)

  const submit = (command: EditorCommand) => {
    if (busy) return
    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')

    if (parsed.success) {
      if (parsed.data.type === 'scene.upsertItemView') target = `view:${parsed.data.component.id}`
      save(parsed.data)
    }
  }

  const reset = () => {
    item = target.startsWith('item:')
      ? structuredClone(view?.inventory?.itemTypes[target.slice(5)])
      : undefined
    slots = target.startsWith('owner:')
      ? Object.entries(view?.inventory?.owners[target.slice(6)]?.equipmentSlots ?? {})
      : undefined
    combatStats = target.startsWith('owner:')
      ? structuredClone(view?.inventory?.owners[target.slice(6)]?.combatStats)
      : undefined

    const source = view?.scenes
      .find((scene) => scene.id === sceneId)
      ?.components.find((entry) => entry.id === target.slice(5))

    component =
      source?.type === 'item-details' ||
      source?.type === 'equipment' ||
      source?.type === 'inventory'
        ? structuredClone(source)
        : undefined
    dirty = false
    error.textContent = ''
    render()
  }

  const navigate = (nextScene?: string, nextComponent?: string) => {
    const nextTarget = nextComponent ? `view:${nextComponent}` : target

    if (nextComponent && !showDefinitions(false)) return false

    if ((!nextScene || nextScene === sceneId) && nextTarget === target) return true

    if (dirty) {
      error.textContent = 'Save or discard the item draft before switching targets.'

      return false
    }

    sceneId = nextScene ?? sceneId
    target = nextTarget
    reset()

    return true
  }

  function render() {
    fields.replaceChildren()

    if (!view?.game) return
    const scene = view.scenes.find((scene) => scene.id === sceneId)

    const scenePicker = controls.select(
      'Items game scene',
      sceneId,
      view.scenes.filter((scene) => scene.type === 'game').map((scene) => scene.id),
      (value) => {
        if (!navigate(value)) scenePicker.querySelector('select')!.value = sceneId
      },
      false,
    )

    scenePicker.className = 'context-picker'

    const targets = [
      ...Object.keys(view.inventory?.itemTypes ?? {}).map(
        (id) => [`item:${id}`, `Item: ${id}`] as const,
      ),
      ...Object.keys(view.inventory?.owners ?? {}).map(
        (id) => [`owner:${id}`, `Owner slots: ${id}`] as const,
      ),
      ...(scene?.components
        .filter((component) => ['inventory', 'item-details', 'equipment'].includes(component.type))
        .map(
          (component) => [`view:${component.id}`, `${component.type}: ${component.id}`] as const,
        ) ?? []),
    ]

    const picker = controls.select(
      'Item editing target',
      target,
      [['', 'Choose…'], ...targets],
      (value) => {
        if (dirty) {
          error.textContent = 'Save or discard the item draft before switching targets.'
          picker.querySelector('select')!.value = target

          return
        }

        target = value
        reset()
      },
      false,
    )

    picker.className = 'context-picker'

    fields.append(scenePicker, picker)

    if (scene)
      for (const type of ['inventory', 'item-details', 'equipment'] as const)
        fields.append(
          controls.button(`Add ${type}`, () => {
            if (dirty) {
              error.textContent = 'Save or discard the item draft first.'

              return
            }

            let id: string = type
            let number = 1

            while (scene.components.some((component) => component.id === id))
              id = `${type}-${number++}`
            const inventory = scene.components.find((component) => component.type === 'inventory')
            const owner = Object.keys(view?.inventory?.owners ?? {})[0]

            if ((type === 'inventory' && !owner) || (type !== 'inventory' && !inventory)) {
              error.textContent =
                type === 'inventory'
                  ? 'Create and save an inventory owner first.'
                  : 'Add an inventory panel to this scene first.'

              return
            }

            const data = {
              id,
              type,
              inventory: inventory?.id ?? '',
              owner: inventory?.owners[0] ?? '',
              placement: { row: 1, column: 1 },
            }

            component =
              type === 'inventory'
                ? inventoryComponentSchema.parse({
                    id,
                    type,
                    owners: [owner],
                    placement: { row: 1, column: 1 },
                  })
                : type === 'equipment'
                  ? equipmentComponentSchema.parse(data)
                  : itemDetailsComponentSchema.parse(data)
            item = undefined
            slots = undefined
            target = `view:${id}`
            dirty = true
            render()
          }),
        )
    const form = document.createElement('form')
    const button = document.createElement('button')
    button.type = 'submit'
    button.textContent = 'Save items and equipment'
    form.append(saveBar(document, button))

    if (item)
      form.append(
        ...itemPresentationForm(controls, view, item, render),
        itemUseForm(controls, view, item, render),
      )

    if (slots) {
      form.append(
        controls.select(
          'Combat stat profile',
          combatStats ? 'enabled' : 'disabled',
          ['disabled', 'enabled'],
          (value) => {
            const fields =
              view?.rules?.state.filter((field) => typeof field.value === 'number') ?? []

            combatStats =
              value === 'enabled'
                ? combatStatsProfileSchema.parse({
                    health: { source: 'game.state', path: fields[0]?.path ?? ['health'] },
                    maximumHealth: 40,
                  })
                : undefined
            render()
          },
        ),
      )

      if (combatStats) form.append(...combatStatsForm(controls, view, combatStats, render))
      slots.forEach((slot, index) =>
        form.append(
          controls.group(
            `Slot ${index + 1}`,
            controls.input('Slot ID', slot[0], (value) => {
              slot[0] = value.trim()
            }),
            controls.input('Slot name', slot[1], (value) => {
              slot[1] = value
            }),
            controls.button('Remove slot', () => {
              slots!.splice(index, 1)
              controls.markEdited()
              render()
            }),
          ),
        ),
      )
      form.append(
        controls.button('Add slot', () => {
          slots!.push(['', ''])
          controls.markEdited()
          render()
        }),
      )
    }

    const source = scene?.components.find((entry) => entry.id === target.slice(5))

    if (component && scene) {
      const draft = component
      form.append(
        ...(draft.type !== 'inventory'
          ? [
              controls.select(
                'Show equipment stats',
                String(draft.showCombatStats ?? false),
                ['false', 'true'],
                (value) => {
                  draft.showCombatStats = value === 'true'
                },
              ),
            ]
          : []),
        controls.input('View ID', draft.id, (value) => {
          draft.id = value.trim()
        }),
        controls.input('View label', draft.label, (value) => {
          draft.label = value
        }),
        controls.translation(
          'View label translation',
          draft.labelKey ?? '',
          translationChoices(view),
          (value) => {
            draft.labelKey = value || undefined
          },
        ),
        ...(draft.type !== 'inventory'
          ? [
              controls.select(
                'Source inventory',
                draft.inventory,
                scene.components
                  .filter((entry) => entry.type === 'inventory')
                  .map((entry) => entry.id),
                (value) => {
                  draft.inventory = value
                  render()
                },
              ),
            ]
          : []),
        ...placementFields.map(([key, label]) =>
          controls.input(
            label,
            String(draft.placement[key]),
            (value) => {
              draft.placement[key] = Number(value)
            },
            'number',
          ),
        ),
      )

      if (draft.type === 'item-details')
        form.append(
          controls.select(
            'Comparison equipment',
            draft.equipment ?? '',
            [
              '',
              ...scene.components
                .filter(
                  (entry) => entry.type === 'equipment' && entry.inventory === draft.inventory,
                )
                .map((entry) => entry.id),
            ],
            (value) => {
              draft.equipment = value || undefined
            },
          ),
          controls.input('Empty selection text', draft.emptyText, (value) => {
            draft.emptyText = value
          }),
          controls.translation(
            'Empty text translation',
            draft.emptyTextKey ?? '',
            translationChoices(view),
            (value) => {
              draft.emptyTextKey = value || undefined
            },
          ),
        )
      else if (draft.type === 'inventory') {
        form.append(
          ...Object.entries(view.inventory?.owners ?? {}).map(([id, owner]) =>
            controls.select(
              `Show owner ${owner.label}`,
              String(draft.owners.includes(id)),
              ['false', 'true'],
              (value) => {
                draft.owners =
                  value === 'true'
                    ? [...new Set([...draft.owners, id])]
                    : draft.owners.filter((owner) => owner !== id)
              },
            ),
          ),
          controls.select(
            'Inventory read only',
            String(draft.readOnly ?? false),
            ['false', 'true'],
            (value) => {
              draft.readOnly = value === 'true'
            },
          ),
          controls.select(
            'Main text details target',
            draft.descriptionTarget ?? '',
            [
              '',
              ...scene.components.filter((value) => value.type === 'text').map((value) => value.id),
            ],
            (value) => {
              draft.descriptionTarget = value || undefined
            },
          ),
        )
      } else {
        const inventory = scene.components.find(
          (entry) => entry.id === draft.inventory && entry.type === 'inventory',
        )

        form.append(
          controls.select(
            'Equipment owner',
            draft.owner,
            inventory?.type === 'inventory' ? inventory.owners : [],
            (value) => {
              draft.owner = value
              draft.order = []
              render()
            },
          ),
          controls.input(
            'Grid columns',
            String(draft.columns),
            (value) => {
              draft.columns = Number(value)
            },
            'number',
          ),
          controls.select(
            'Equipment changes',
            String(draft.readOnly),
            [
              ['false', 'Allow changes'],
              ['true', 'Read only'],
            ],
            (value) => {
              draft.readOnly = value === 'true'
            },
          ),
          controls.input('Slot order (comma separated IDs)', draft.order.join(', '), (value) => {
            draft.order = value
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          }),
        )
      }
    }

    if (!item && !slots && !component) return
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (item)
        submit({
          type: 'inventory.setItemPresentation',
          itemType: target.slice(5),
          presentation: item,
          combatBonuses: item.combatBonuses ?? null,
          use: item.use ?? null,
        })
      else if (slots) {
        if (new Set(slots.map((slot) => slot[0])).size !== slots.length) {
          error.textContent = 'Slot IDs must be unique'

          return
        }

        submit({
          type: 'inventory.setEquipmentSlots',
          owner: target.slice(6),
          slots: Object.fromEntries(slots),
          combatStats: combatStats ?? null,
        })
      } else if (component) submit({ type: 'scene.upsertItemView', sceneId, component })
    })
    fields.append(form, controls.button('Discard item draft', reset))

    if (component && source)
      fields.append(
        controls.button('Remove item view', () =>
          submit({ type: 'scene.removeItemView', sceneId, componentId: source.id }),
        ),
      )
  }

  return {
    navigate,
    navigateInventory(id: string) {
      if (!showDefinitions(true)) return false

      return inventoryEditor.navigate(id)
    },
    hasDrafts: () => dirty || inventoryEditor.hasDrafts(),
    render(state: ProjectEditorState, replaceFields: boolean) {
      inventoryEditor.render(state, replaceFields)
      const changed = view !== state.view
      const projectChanged = path !== state.path
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        replaceFields &&
        [
          'inventory.setItemPresentation',
          'inventory.setEquipmentSlots',
          'scene.setInventoryDetails',
          'scene.upsertItemView',
          'scene.removeItemView',
        ].includes(state.lastCommand ?? '')

      const resetFields = projectChanged || (replaceFields && !state.preserveDrafts)

      if (resetFields) {
        sceneId = view?.scenes.find((scene) => scene.type === 'game')?.id ?? ''
        target = ''
      }

      if (resetFields || saved || (changed && !dirty)) reset()
      else if (changed) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
