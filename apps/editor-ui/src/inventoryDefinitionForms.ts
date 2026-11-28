import { entryEditor, fieldPath, type EntrySelections } from './specialistEntries.js'
import type { ProjectView } from '@ancadeba/editor-core'
import {
  assetIdSchema,
  combatStatsProfileSchema,
  inventoryIcon,
  type InventoryDefinition,
} from '@ancadeba/schemas'
import {
  yesNoChoices,
  onOffChoices,
  translationChoices,
  type RuleFormControls,
} from './ruleFormControls.js'
import { itemPresentationForm } from './itemPresentationForm.js'
import { itemUseForm } from './itemUseForm.js'
import { combatStatsForm } from './combatStatsForm.js'
import { craftingRecipeForm } from './craftingRecipeForm.js'

export type InventoryKind = 'itemTypes' | 'owners' | 'items'

export interface InventoryEntrySelection {
  kind: InventoryKind
  id: string
}

export interface InventorySlotDraft {
  id: string
  label: string
}

export function inventoryDefinitionForms(
  controls: RuleFormControls,
  view: ProjectView,
  draft: InventoryDefinition,
  selected: InventoryEntrySelection,
  slot: InventorySlotDraft,
  change: (operation: () => void) => void,
  render: () => void,
  entries: EntrySelections,
  arrange: (root: HTMLElement) => void,
): HTMLElement[] {
  const { input, select, button, group, t } = controls
  const merged = view.inventory ?? draft
  const type = draft.itemTypes[selected.id]

  if (selected.kind === 'itemTypes' && type) {
    const slots = [
      ...new Set([
        ...Object.values(merged.owners).flatMap((owner) => Object.keys(owner.equipmentSlots)),
        ...type.equipmentSlots,
      ]),
    ]

    const equipment = group(
      t('items.behavior'),
      select(t('items.canContain'), String(type.container), yesNoChoices(t), (value) => {
        type.container = value === 'true'
      }),
      fieldPath(
        select(
          t('items.icon'),
          type.icon ?? '',
          ['', ...Object.keys(view.assets?.images ?? {}), ...Object.keys(view.assets?.parts ?? {})],
          (value) => {
            type.icon = value || undefined
          },
        ),
        'icon',
      ),
      fieldPath(
        select(
          t('items.equippedPart'),
          type.wornPart ?? '',
          ['', ...Object.keys(view.assets?.parts ?? {})],
          (value) => {
            type.wornPart = value || undefined
          },
        ),
        'wornPart',
      ),
      ...slots.map((id) =>
        select(
          t('items.fitsSlot', { id }),
          String(type.equipmentSlots.includes(id)),
          yesNoChoices(t),
          (value) => {
            type.equipmentSlots =
              value === 'true'
                ? [...new Set([...type.equipmentSlots, id])]
                : type.equipmentSlots.filter((slot) => slot !== id)
          },
        ),
      ),
    )

    if (!slots.length) equipment.append(t('items.slotsFirst'))

    return [
      ...itemPresentationForm(controls, view, type, render),
      craftingRecipeForm(controls, view, type, render),
      controls.section('equipment', fieldPath(equipment, 'equipmentSlots')),
      controls.section('use', fieldPath(itemUseForm(controls, view, type, render), 'use')),
    ]
  }

  const owner = draft.owners[selected.id]

  if (selected.kind === 'owners' && owner) {
    const ids = Object.keys(owner.equipmentSlots)

    const fields: HTMLElement[] = [
      fieldPath(
        input(t('items.ownerName'), owner.label, (value) => {
          owner.label = value
        }),
        'label',
      ),
      controls.translation(
        t('form.nameTranslation'),
        owner.labelKey ?? '',
        translationChoices(view),
        (value) => {
          owner.labelKey = value || undefined
        },
      ),
      controls.fold(
        'slots',
        t('items.equipmentSlots'),
        false,
        entryEditor(
          controls,
          entries,
          'ownerSlots',
          t('items.equipmentSlots'),
          ids,
          (id) =>
            (owner.equipmentSlotKeys?.[id] && view.translations?.[owner.equipmentSlotKeys[id]!]) ||
            owner.equipmentSlots[id] ||
            id,
          (id) => {
            const box = group(
              t('items.equipmentSlot', { id }),
              fieldPath(
                input(t('items.equipmentSlotName'), owner.equipmentSlots[id]!, (value) => {
                  owner.equipmentSlots[id] = value
                }),
                'equipmentSlots',
                id,
              ),
              controls.translation(
                t('form.nameTranslation'),
                owner.equipmentSlotKeys?.[id] ?? '',
                translationChoices(view),
                (value) => {
                  owner.equipmentSlotKeys ??= {}

                  if (value) owner.equipmentSlotKeys[id] = value
                  else delete owner.equipmentSlotKeys[id]
                },
              ),
              button(t('items.removeEquipmentSlot'), () =>
                change(() => {
                  delete owner.equipmentSlots[id]

                  if (owner.equipmentSlotKeys) delete owner.equipmentSlotKeys[id]
                }),
              ),
            )

            arrange(box)

            return box
          },
          { path: ['equipmentSlots'], ids },
        ),
        fieldPath(
          input(t('form.newSlotId'), slot.id, (value) => {
            slot.id = value.trim()
          }),
          'newSlotId',
        ),
        fieldPath(
          input(t('items.newSlotName'), slot.label, (value) => {
            slot.label = value
          }),
          'newSlotName',
        ),
        button(t('items.addEquipmentSlot'), () =>
          change(() => {
            if (
              !assetIdSchema.safeParse(slot.id).success ||
              !slot.label.trim() ||
              Object.hasOwn(owner.equipmentSlots, slot.id)
            )
              throw new Error(t('items.invalidSlot'))
            entries.ownerSlots = ids.length
            owner.equipmentSlots[slot.id] = slot.label.trim()
            slot.id = ''
            slot.label = ''
          }),
        ),
      ),
    ]

    const stats = controls.fold(
      'stats',
      t('items.ownerStats'),
      false,
      select(
        t('items.ownerStats'),
        owner.combatStats ? 'enabled' : 'disabled',
        onOffChoices(t),
        (value) => {
          if (value === 'disabled') delete owner.combatStats
          else {
            const field = view.rules?.state.find((field) => typeof field.value === 'number')
            owner.combatStats = combatStatsProfileSchema.parse({
              health: { source: 'game.state', path: field?.path ?? ['health'] },
              maximumHealth: 40,
            })
          }

          render()
        },
      ),
    )

    if (owner.combatStats)
      stats.append(...combatStatsForm(controls, view, owner.combatStats, render))
    else if (!view.rules?.state.some((field) => typeof field.value === 'number'))
      stats.append(group(t('items.statSetup'), t('items.healthFirst')))

    return [...fields, fieldPath(stats, 'combatStats')]
  }

  const item = draft.items[selected.id]

  if (selected.kind !== 'items' || !item) return []
  const placement = item.placement

  const ownerId =
    placement.type === 'inside' ? (Object.keys(merged.owners)[0] ?? '') : placement.owner

  const slots = Object.keys(merged.owners[ownerId]?.equipmentSlots ?? {}).filter((id) =>
    merged.itemTypes[item.itemType]?.equipmentSlots.includes(id),
  )

  const containers = Object.entries(merged.items)
    .filter(([id, value]) => id !== selected.id && merged.itemTypes[value.itemType]?.container)
    .map(([id]) => id)

  const fields: HTMLElement[] = [
    fieldPath(
      select(
        t('items.startingType'),
        item.itemType,
        Object.entries(merged.itemTypes).map(([id, type]) => [id, type.label || id] as const),
        (value) => {
          item.itemType = value
          render()
        },
      ),
      'itemType',
    ),
    fieldPath(
      select(
        t('items.startingPlacement'),
        placement.type,
        [
          ['carried', t('items.carried')],
          ['equipped', t('items.equipped')],
          ['inside', t('items.inContainer')],
        ],
        (value) => {
          item.placement =
            value === 'inside'
              ? { type: 'inside', container: containers[0] ?? '' }
              : value === 'equipped'
                ? { type: 'equipped', owner: ownerId, slot: slots[0] ?? '' }
                : { type: 'carried', owner: ownerId }
          render()
        },
      ),
      'placement',
      'type',
    ),
  ]

  if (placement.type === 'inside')
    fields.push(
      fieldPath(
        select(t('items.startingContainer'), placement.container, containers, (value) => {
          placement.container = value
        }),
        'placement',
        'container',
      ),
    )
  else {
    fields.push(
      fieldPath(
        select(
          t('items.startingOwner'),
          placement.owner,
          Object.entries(merged.owners).map(([id, owner]) => [id, owner.label] as const),
          (value) => {
            placement.owner = value
            render()
          },
        ),
        'placement',
        'owner',
      ),
    )

    if (placement.type === 'equipped')
      fields.push(
        fieldPath(
          select(t('items.startingSlot'), placement.slot, slots, (value) => {
            placement.slot = value
          }),
          'placement',
          'slot',
        ),
      )
  }

  const itemType = merged.itemTypes[item.itemType]
  const icon = itemType?.icon && inventoryIcon(view.assets, itemType.icon)
  const part = itemType?.wornPart && view.assets?.parts[itemType.wornPart]
  const defaults = { ...(icon ? icon.colors : {}), ...(part ? part.colors : {}) }
  const names = [...new Set([...Object.keys(defaults), ...Object.keys(item.colors)])]

  if (names.length)
    fields.push(
      controls.section(
        'colors',
        fieldPath(
          group(
            t('items.startingColors'),
            ...names.flatMap((name) => [
              select(
                t('items.overrideColor', { name }),
                String(Object.hasOwn(item.colors, name)),
                yesNoChoices(t),
                (value) => {
                  if (value === 'true') item.colors[name] = defaults[name] ?? '#ffffff'
                  else delete item.colors[name]
                  render()
                },
              ),
              ...(Object.hasOwn(item.colors, name)
                ? [
                    input(
                      t('form.color', { id: name }),
                      item.colors[name]!,
                      (value) => {
                        item.colors[name] = value
                      },
                      'color',
                    ),
                  ]
                : []),
            ]),
          ),
          'colors',
        ),
      ),
    )

  return fields
}
