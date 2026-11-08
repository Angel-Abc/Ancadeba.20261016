import { inventoryFile, type GameDefinition } from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'

export type ItemCommand = Extract<
  EditorCommand,
  {
    type:
      | 'inventory.setItemPresentation'
      | 'inventory.setEquipmentSlots'
      | 'scene.setInventoryDetails'
      | 'scene.upsertItemView'
      | 'scene.removeItemView'
  }
>

export function editItems(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: ItemCommand,
): string[] {
  if (
    command.type === 'inventory.setItemPresentation' ||
    command.type === 'inventory.setEquipmentSlots'
  ) {
    const kind = command.type === 'inventory.setItemPresentation' ? 'itemTypes' : 'owners'
    const id = command.type === 'inventory.setItemPresentation' ? command.itemType : command.owner

    const file = (game.inventory ?? [])
      .map(inventoryFile)
      .find((file) => Object.hasOwn(object(object(documents[file])[kind]), id))

    if (!file)
      throw new EditorError(404, 'inventory_entry_not_found', 'Inventory entry does not exist')
    const source = object(documents[file])
    const entries = object(source[kind])
    const previous = object(entries[id])
    const properties = Array.isArray(previous.properties) ? previous.properties.map(object) : []

    const next =
      command.type === 'inventory.setItemPresentation'
        ? {
            ...previous,
            ...command.presentation,
            ...(command.combatBonuses !== undefined
              ? {
                  combatBonuses: command.combatBonuses
                    ? { ...object(previous.combatBonuses), ...command.combatBonuses }
                    : undefined,
                }
              : {}),
            ...(command.use !== undefined
              ? {
                  use: command.use
                    ? {
                        ...object(previous.use),
                        ...command.use,
                        ability: {
                          ...object(object(previous.use).ability),
                          ...command.use.ability,
                        },
                        enabledWhen: command.use.enabledWhen
                          ? {
                              ...object(object(previous.use).enabledWhen),
                              ...command.use.enabledWhen,
                              fallback: command.use.enabledWhen.fallback,
                            }
                          : undefined,
                        messages: {
                          ...object(object(previous.use).messages),
                          ...command.use.messages,
                        },
                        messageKeys: { ...command.use.messageKeys },
                      }
                    : undefined,
                }
              : {}),
            labelKey: command.presentation.labelKey,
            descriptionKey: command.presentation.descriptionKey,
            artwork: command.presentation.artwork,
            properties: command.presentation.properties.map((property) => {
              const previous = properties.find((old) => old.id === property.id)

              return {
                ...previous,
                ...property,
                value:
                  typeof property.value === 'object'
                    ? {
                        ...object(previous?.value),
                        ...property.value,
                        fallback: property.value.fallback,
                      }
                    : property.value,
                labelKey: property.labelKey,
                valueKey: property.valueKey,
              }
            }),
          }
        : {
            ...previous,
            equipmentSlots: { ...command.slots },
            ...(command.combatStats !== undefined
              ? {
                  combatStats: command.combatStats
                    ? {
                        ...object(previous.combatStats),
                        ...command.combatStats,
                        ...Object.fromEntries(
                          (['health', 'maximumHealth', 'attack', 'defense', 'guard'] as const).map(
                            (key) => {
                              const value = command.combatStats![key]

                              return [
                                key,
                                typeof value === 'object'
                                  ? { ...object(object(previous.combatStats)[key]), ...value }
                                  : value,
                              ]
                            },
                          ),
                        ),
                        messages: {
                          ...object(object(previous.combatStats).messages),
                          ...command.combatStats.messages,
                        },
                        messageKeys: { ...command.combatStats.messageKeys },
                      }
                    : undefined,
                }
              : {}),
          }

    documents[file] = { ...source, [kind]: { ...entries, [id]: next } }

    return [file]
  }

  const file = `scenes/${command.sceneId}.json`
  const source = object(documents[file])

  if (!game.scenes.includes(command.sceneId) || source.type !== 'game')
    throw new EditorError(422, 'invalid_item_scene', 'Select a game scene')
  const components = Array.isArray(source.components) ? [...source.components] : []
  const id = command.type === 'scene.upsertItemView' ? command.component.id : command.componentId
  const index = components.findIndex((entry) => object(entry).id === id)
  const previous = object(components[index])

  if (command.type === 'scene.setInventoryDetails') {
    if (previous.type !== 'inventory')
      throw new EditorError(422, 'invalid_inventory_panel', 'Select an inventory panel')
    components[index] = { ...previous, descriptionTarget: command.descriptionTarget ?? undefined }
  } else if (command.type === 'scene.removeItemView') {
    if (!['item-details', 'equipment', 'inventory'].includes(String(previous.type)))
      throw new EditorError(422, 'invalid_item_view', 'Select an item view')
    components.splice(index, 1)
  } else {
    const component = command.component

    if (index >= 0 && previous.type !== component.type)
      throw new EditorError(422, 'component_id_in_use', 'This ID belongs to another component')

    const next = {
      ...previous,
      ...component,
      ...(component.type === 'item-details' ? { equipment: component.equipment } : {}),
      labelKey: component.labelKey,
      placement: { ...object(previous.placement), ...component.placement },
      ...(component.type === 'item-details' ? { emptyTextKey: component.emptyTextKey } : {}),
      ...(component.type === 'inventory' ? { descriptionTarget: component.descriptionTarget } : {}),
    }

    if (index < 0) components.push(next)
    else components[index] = next
  }

  documents[file] = { ...source, components }

  return [file]
}
