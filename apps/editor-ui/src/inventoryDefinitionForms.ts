import type { ProjectView } from '@ancadeba/editor-core'
import {
  assetIdSchema,
  combatStatsProfileSchema,
  inventoryIcon,
  type InventoryDefinition,
} from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'
import { itemPresentationForm } from './itemPresentationForm.js'
import { itemUseForm } from './itemUseForm.js'
import { combatStatsForm } from './combatStatsForm.js'

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
): HTMLElement[] {
  const { input, select, button, group } = controls
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
      'Item behavior',
      select('Can contain items', String(type.container), ['false', 'true'], (value) => {
        type.container = value === 'true'
      }),
      select(
        'Inventory icon',
        type.icon ?? '',
        ['', ...Object.keys(view.assets?.images ?? {}), ...Object.keys(view.assets?.parts ?? {})],
        (value) => {
          type.icon = value || undefined
        },
      ),
      select(
        'Equipped graphic part',
        type.wornPart ?? '',
        ['', ...Object.keys(view.assets?.parts ?? {})],
        (value) => {
          type.wornPart = value || undefined
        },
      ),
      ...slots.map((id) =>
        select(
          `Fits slot ${id}`,
          String(type.equipmentSlots.includes(id)),
          ['false', 'true'],
          (value) => {
            type.equipmentSlots =
              value === 'true'
                ? [...new Set([...type.equipmentSlots, id])]
                : type.equipmentSlots.filter((slot) => slot !== id)
          },
        ),
      ),
    )

    if (!slots.length)
      equipment.append('Add equipment slots to an owner to make this item equippable.')

    return [
      ...itemPresentationForm(controls, view, type, render),
      equipment,
      itemUseForm(controls, view, type, render),
    ]
  }

  const owner = draft.owners[selected.id]

  if (selected.kind === 'owners' && owner) {
    const fields: HTMLElement[] = [
      input('Owner name', owner.label, (value) => {
        owner.label = value
      }),
      ...Object.entries(owner.equipmentSlots).map(([id, label]) =>
        group(
          `Equipment slot ${id}`,
          input('Equipment slot name', label, (value) => {
            owner.equipmentSlots[id] = value
          }),
          button('Remove equipment slot', () =>
            change(() => {
              delete owner.equipmentSlots[id]
            }),
          ),
        ),
      ),
      input('New slot ID', slot.id, (value) => {
        slot.id = value.trim()
      }),
      input('New slot name', slot.label, (value) => {
        slot.label = value
      }),
      button('Add equipment slot', () =>
        change(() => {
          if (
            !assetIdSchema.safeParse(slot.id).success ||
            !slot.label.trim() ||
            Object.hasOwn(owner.equipmentSlots, slot.id)
          )
            throw new Error('Use a unique slot ID and a nonempty slot name.')
          owner.equipmentSlots[slot.id] = slot.label.trim()
          slot.id = ''
          slot.label = ''
        }),
      ),
      select(
        'Owner combat stats',
        owner.combatStats ? 'enabled' : 'disabled',
        ['disabled', 'enabled'],
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
    ]

    if (owner.combatStats)
      fields.push(...combatStatsForm(controls, view, owner.combatStats, render))
    else if (!view.rules?.state.some((field) => typeof field.value === 'number'))
      fields.push(
        group(
          'Combat stat setup',
          'Create numeric health state in Rules before enabling a combat stat profile.',
        ),
      )

    return fields
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
    select(
      'Starting item type',
      item.itemType,
      Object.entries(merged.itemTypes).map(([id, type]) => [id, type.label || id] as const),
      (value) => {
        item.itemType = value
        render()
      },
    ),
    select(
      'Starting placement',
      placement.type,
      [
        ['carried', 'Carried by an owner'],
        ['equipped', 'Equipped in a slot'],
        ['inside', 'Inside a container'],
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
  ]

  if (placement.type === 'inside')
    fields.push(
      select('Starting container', placement.container, containers, (value) => {
        placement.container = value
      }),
    )
  else {
    fields.push(
      select(
        'Starting owner',
        placement.owner,
        Object.entries(merged.owners).map(([id, owner]) => [id, owner.label] as const),
        (value) => {
          placement.owner = value
          render()
        },
      ),
    )

    if (placement.type === 'equipped')
      fields.push(
        select('Starting equipment slot', placement.slot, slots, (value) => {
          placement.slot = value
        }),
      )
  }

  const itemType = merged.itemTypes[item.itemType]
  const icon = itemType?.icon && inventoryIcon(view.assets, itemType.icon)
  const part = itemType?.wornPart && view.assets?.parts[itemType.wornPart]
  const defaults = { ...(icon ? icon.colors : {}), ...(part ? part.colors : {}) }
  const names = [...new Set([...Object.keys(defaults), ...Object.keys(item.colors)])]
  fields.push(
    group(
      'Starting item colors',
      ...names.flatMap((name) => [
        select(
          `Override ${name}`,
          String(Object.hasOwn(item.colors, name)),
          ['false', 'true'],
          (value) => {
            if (value === 'true') item.colors[name] = defaults[name] ?? '#ffffff'
            else delete item.colors[name]
            render()
          },
        ),
        ...(Object.hasOwn(item.colors, name)
          ? [
              input(
                `Color ${name}`,
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
  )

  return fields
}
