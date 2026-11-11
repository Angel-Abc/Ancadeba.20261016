import { registerEditorDraft } from './editorDraftState.js'
import { z } from 'zod'
import { inventorySchema } from '@ancadeba/schemas'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
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
  yesNoChoices,
  onOffChoices,
  placementFields,
  ruleFormControls,
  saveBar,
  translationChoices,
  languageWatcher,
} from './ruleFormControls.js'
import { itemUseForm } from './itemUseForm.js'
import { itemPresentationForm } from './itemPresentationForm.js'
import { combatStatsForm } from './combatStatsForm.js'
import { bindInventoryEditor } from './inventoryEditor.js'
import { sceneChoices } from './choiceLabels.js'

/** Revision conflicts preserve this independent draft, including edits to ordered properties. */
export function bindItemEditor(
  root: HTMLElement,
  save: (command: EditorCommand) => void,
  t: Translate = editorLocalization().t,
) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  const inventoryRoot = document.createElement('section')
  const navigation = document.createElement('div')
  navigation.className = 'editor-mode-controls'
  root.replaceChildren(navigation, error, inventoryRoot, fields)
  const inventoryEditor = bindInventoryEditor(inventoryRoot, save, t)
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
  let creating = false
  let submitted: EditorCommand | undefined
  let hiddenPreviews: InventoryComponentDefinition['previews'] = {}

  const languageChanged = languageWatcher(t)

  const controls = ruleFormControls(
    document,
    () => {
      dirty = true
    },
    t,
  )

  const showDefinitions = (value: boolean) => {
    if (value !== definitions && (dirty || inventoryEditor.hasDrafts())) {
      error.textContent = t('items.saveBeforeEditors')

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

  const definitionButton = controls.button(t('items.definitions'), () => showDefinitions(true))

  const viewButton = controls.button(t('items.views'), () => showDefinitions(false))

  navigation.append(definitionButton, viewButton)
  showDefinitions(true)

  const submit = (command: EditorCommand) => {
    if (busy) return
    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')

    if (parsed.success) {
      submitted = parsed.data
      save(parsed.data)
    }
  }

  const reset = () => {
    creating = false
    hiddenPreviews = {}
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
      error.textContent = t('items.saveFirstTargets')

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
      t('items.gameScene'),
      sceneId,
      sceneChoices(view, 'game'),
      (value) => {
        if (!navigate(value)) scenePicker.querySelector('select')!.value = sceneId
      },
      false,
    )

    scenePicker.className = 'context-picker'

    const targets = [
      ...Object.keys(view.inventory?.itemTypes ?? {}).map(
        (id) => [`item:${id}`, t('items.itemTitle', { id })] as const,
      ),
      ...Object.keys(view.inventory?.owners ?? {}).map(
        (id) => [`owner:${id}`, t('items.ownerSlots', { id })] as const,
      ),
      ...(scene?.components
        .filter((component) => ['inventory', 'item-details', 'equipment'].includes(component.type))
        .map(
          (component) => [`view:${component.id}`, `${component.type}: ${component.id}`] as const,
        ) ?? []),
    ]

    const picker = controls.select(
      t('items.editingTarget'),
      target,
      [['', t('form.choose')], ...targets],
      (value) => {
        if (dirty) {
          error.textContent = t('items.saveFirstTargets')
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
          controls.button(t('items.addView', { type }), () => {
            if (dirty) {
              error.textContent = t('items.saveFirst')

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
                type === 'inventory' ? t('items.ownerFirst') : t('items.panelFirst')

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
            creating = true
            hiddenPreviews = {}
            dirty = true
            render()
          }),
        )
    const form = document.createElement('form')
    const button = document.createElement('button')
    button.type = 'submit'
    button.textContent = t('items.save')
    form.append(saveBar(document, button))

    if (item)
      form.append(
        ...itemPresentationForm(controls, view, item, render),
        itemUseForm(controls, view, item, render),
      )

    if (slots) {
      form.append(
        controls.select(
          t('items.statProfile'),
          combatStats ? 'enabled' : 'disabled',
          onOffChoices(t),
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
            t('form.slot', { id: index + 1 }),
            controls.input(t('items.slotId'), slot[0], (value) => {
              slot[0] = value.trim()
            }),
            controls.input(t('items.slotName'), slot[1], (value) => {
              slot[1] = value
            }),
            controls.button(t('items.removeSlot'), () => {
              slots!.splice(index, 1)
              controls.markEdited()
              render()
            }),
          ),
        ),
      )
      form.append(
        controls.button(t('items.addSlot'), () => {
          slots!.push(['', ''])
          controls.markEdited()
          render()
        }),
      )
    }

    const source = scene?.components.find((entry) => entry.id === target.slice(5))

    if (component && scene) {
      const draft = component

      const identity = controls.input(t('items.viewId'), draft.id, (value) => {
        if (creating) draft.id = value.trim()
      })

      identity.querySelector('input')!.readOnly = !creating
      form.append(
        ...(draft.type !== 'inventory'
          ? [
              controls.select(
                t('items.showStats'),
                String(draft.showCombatStats ?? false),
                yesNoChoices(t),
                (value) => {
                  draft.showCombatStats = value === 'true'
                },
              ),
            ]
          : []),
        identity,
        controls.input(t('items.viewLabel'), draft.label, (value) => {
          draft.label = value
        }),
        controls.translation(
          t('items.viewLabelTranslation'),
          draft.labelKey ?? '',
          translationChoices(view),
          (value) => {
            draft.labelKey = value || undefined
          },
        ),
        ...(draft.type !== 'inventory'
          ? [
              controls.select(
                t('items.sourceInventory'),
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
        ...placementFields(t).map(([key, label]) =>
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
            t('items.comparisonEquipment'),
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
          controls.input(t('items.emptyText'), draft.emptyText, (value) => {
            draft.emptyText = value
          }),
          controls.translation(
            t('items.emptyTextTranslation'),
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
              t('items.showOwner', { owner: owner.label }),
              String(draft.owners.includes(id)),
              yesNoChoices(t),
              (value) => {
                draft.owners =
                  value === 'true'
                    ? [...new Set([...draft.owners, id])]
                    : draft.owners.filter((owner) => owner !== id)

                if (value === 'false') {
                  if (draft.previews[id]) hiddenPreviews[id] = draft.previews[id]
                  delete draft.previews[id]
                } else if (hiddenPreviews[id]) {
                  draft.previews[id] = hiddenPreviews[id]
                  delete hiddenPreviews[id]
                }
              },
            ),
          ),
          controls.select(
            t('items.readOnlyInventory'),
            String(draft.readOnly ?? false),
            yesNoChoices(t),
            (value) => {
              draft.readOnly = value === 'true'
            },
          ),
          controls.select(
            t('items.detailsTarget'),
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
            t('items.equipmentOwner'),
            draft.owner,
            inventory?.type === 'inventory' ? inventory.owners : [],
            (value) => {
              draft.owner = value
              draft.order = []
              render()
            },
          ),
          controls.input(
            t('items.gridColumns'),
            String(draft.columns),
            (value) => {
              draft.columns = Number(value)
            },
            'number',
          ),
          controls.select(
            t('items.equipmentChanges'),
            String(draft.readOnly),
            [
              ['false', t('items.allowChanges')],
              ['true', t('items.readOnly')],
            ],
            (value) => {
              draft.readOnly = value === 'true'
            },
          ),
          controls.input(t('items.slotOrder'), draft.order.join(', '), (value) => {
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
          error.textContent = t('items.uniqueSlotIds')

          return
        }

        submit({
          type: 'inventory.setEquipmentSlots',
          owner: target.slice(6),
          slots: Object.fromEntries(slots),
          combatStats: combatStats ?? null,
        })
      } else if (component) {
        const id = component.id

        if (creating && scene?.components.some((entry) => entry.id === id)) {
          error.textContent = t('form.componentExists')

          return
        }

        submit({ type: 'scene.upsertItemView', sceneId, component, createOnly: creating })
      }
    })
    fields.append(form, controls.button(t('items.discard'), reset))

    if (component && source && !creating)
      fields.append(
        controls.button(t('items.removeView'), () =>
          submit({ type: 'scene.removeItemView', sceneId, componentId: source.id }),
        ),
      )
  }

  registerEditorDraft(
    root,
    'item',
    z.object({
      definitions: z.boolean(),
      sceneId: z.string(),
      target: z.string(),
      item: inventorySchema.shape.itemTypes.valueType.optional(),
      component: z
        .union([itemDetailsComponentSchema, equipmentComponentSchema, inventoryComponentSchema])
        .optional(),
      slots: z.array(z.tuple([z.string(), z.string()])).optional(),
      combatStats: combatStatsProfileSchema.optional(),
      creating: z.boolean(),
      hiddenPreviews: inventoryComponentSchema.shape.previews,
    }),
    () =>
      dirty || inventoryEditor.hasDrafts()
        ? {
            definitions,
            sceneId,
            target,
            item,
            component,
            slots,
            combatStats,
            creating,
            hiddenPreviews,
          }
        : undefined,
    (saved) => {
      definitions = saved.definitions
      sceneId = saved.sceneId
      target = saved.target
      item = saved.item
      component = saved.component
      slots = saved.slots
      combatStats = saved.combatStats
      creating = saved.creating
      hiddenPreviews = saved.hiddenPreviews
      fields.hidden = definitions
      inventoryRoot.hidden = !definitions
      dirty = !definitions
      render()
    },
  )

  return {
    navigate,
    navigateInventory(id: string) {
      if (!showDefinitions(true)) return false

      return inventoryEditor.navigate(id)
    },
    hasDrafts: () => dirty || inventoryEditor.hasDrafts(),
    render(state: ProjectEditorState, replaceFields: boolean) {
      const translated = languageChanged()
      inventoryEditor.render(state, replaceFields)
      const changed = view !== state.view
      const projectChanged = path !== state.path
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        submitted && !busy && !state.error && replaceFields && state.lastCommand === submitted.type

      if (saved && submitted?.type === 'scene.upsertItemView')
        target = `view:${submitted.component.id}`

      if (!busy) submitted = undefined

      const resetFields = projectChanged || (replaceFields && !state.preserveDrafts)

      if (resetFields) {
        sceneId = view?.scenes.find((scene) => scene.type === 'game')?.id ?? ''
        target = ''
      }

      if (translated) {
        definitionButton.textContent = t('items.definitions')
        viewButton.textContent = t('items.views')
      }

      if (resetFields || saved || (changed && !dirty)) reset()
      else if (changed || translated) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
