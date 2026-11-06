import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import {
  equipmentComponentSchema,
  itemDetailsComponentSchema,
  type InventoryDefinition,
  type ItemDetailsComponentDefinition,
  type EquipmentComponentDefinition,
} from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { placementFields, ruleFormControls, saveBar } from './ruleFormControls.js'
import { itemPresentationForm } from './itemPresentationForm.js'

/** Revision conflicts preserve this independent draft, including edits to ordered properties. */
export function bindItemEditor(root: HTMLElement, save: (command: EditorCommand) => void) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let sceneId = ''
  let target = ''
  let item: InventoryDefinition['itemTypes'][string] | undefined
  let component: ItemDetailsComponentDefinition | EquipmentComponentDefinition | undefined
  let descriptionTarget: string | undefined
  let slots: [string, string][] | undefined
  let dirty = false
  let busy = false

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

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

    const source = view?.scenes
      .find((scene) => scene.id === sceneId)
      ?.components.find((entry) => entry.id === target.slice(5))

    component =
      source?.type === 'item-details' || source?.type === 'equipment'
        ? structuredClone(source)
        : undefined
    descriptionTarget = source?.type === 'inventory' ? source.descriptionTarget : undefined
    dirty = false
    error.textContent = ''
    render()
  }

  const navigate = (nextScene?: string, nextComponent?: string) => {
    const nextTarget = nextComponent ? `view:${nextComponent}` : target

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

    fields.append(scenePicker, picker)

    if (scene)
      for (const type of ['item-details', 'equipment'] as const)
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

            const data = {
              id,
              type,
              inventory: inventory?.id ?? '',
              owner: inventory?.owners[0] ?? '',
              placement: { row: 1, column: 1 },
            }

            component =
              type === 'equipment'
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

    if (item) form.append(...itemPresentationForm(controls, view, item, render))

    if (slots) {
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

    if (source?.type === 'inventory')
      form.append(
        controls.select(
          'Main text details target',
          descriptionTarget ?? '',
          [
            ['', 'No main text details'],
            ...(scene?.components
              .filter((entry) => entry.type === 'text')
              .map((entry) => entry.id) ?? []),
          ],
          (value) => {
            descriptionTarget = value || undefined
          },
        ),
      )

    if (component && scene) {
      const draft = component
      form.append(
        controls.input('View ID', draft.id, (value) => {
          draft.id = value.trim()
        }),
        controls.input('View label', draft.label, (value) => {
          draft.label = value
        }),
        controls.select(
          'View label translation',
          draft.labelKey ?? '',
          ['', ...(view.translationKeys ?? [])],
          (value) => {
            draft.labelKey = value || undefined
          },
        ),
        controls.select(
          'Source inventory',
          draft.inventory,
          scene.components.filter((entry) => entry.type === 'inventory').map((entry) => entry.id),
          (value) => {
            draft.inventory = value
            render()
          },
        ),
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
          controls.input('Empty selection text', draft.emptyText, (value) => {
            draft.emptyText = value
          }),
          controls.select(
            'Empty text translation',
            draft.emptyTextKey ?? '',
            ['', ...(view.translationKeys ?? [])],
            (value) => {
              draft.emptyTextKey = value || undefined
            },
          ),
        )
      else {
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

    if (!item && !slots && !component && source?.type !== 'inventory') return
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (item)
        submit({
          type: 'inventory.setItemPresentation',
          itemType: target.slice(5),
          presentation: item,
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
        })
      } else if (component) submit({ type: 'scene.upsertItemView', sceneId, component })
      else
        submit({
          type: 'scene.setInventoryDetails',
          sceneId,
          componentId: target.slice(5),
          descriptionTarget: descriptionTarget ?? null,
        })
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
    hasDrafts: () => dirty,
    render(state: ProjectEditorState, replaceFields: boolean) {
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
