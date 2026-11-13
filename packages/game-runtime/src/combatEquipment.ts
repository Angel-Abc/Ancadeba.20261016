import {
  cloneCombatRules,
  combatEquipmentSchema,
  type CombatEquipment,
  type CombatEquippedEffects,
  type CombatDefinition,
  type CombatActorDefinition,
  type InventoryDefinition,
  type InventoryPlacement,
} from '@ancadeba/schemas'
import { applyCombatPercent } from './combatValues.js'

interface EquipmentItem {
  readonly id: string
  readonly itemType: string
  readonly placement: InventoryPlacement
}

function freezeEffects<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEffects(child)
    Object.freeze(value)
  }

  return value
}

export function combatOwnerEquipment(
  inventory: InventoryDefinition | undefined,
  items: readonly EquipmentItem[],
  owner: string,
): readonly CombatEquippedEffects[] {
  return Object.freeze(
    items.flatMap((item) => {
      const type = inventory?.itemTypes[item.itemType]

      if (
        item.placement.type !== 'equipped' ||
        item.placement.owner !== owner ||
        !type?.combatEffects
      )
        return []

      return [
        Object.freeze({
          item: item.id,
          itemType: item.itemType,
          slot: item.placement.slot,
          label: type.label,
          effects: freezeEffects(cloneCombatRules(type.combatEffects)),
        }),
      ]
    }),
  )
}

export function combatEquipmentFor(
  definition: CombatDefinition,
  inventory?: InventoryDefinition,
  items: readonly EquipmentItem[] = Object.entries(inventory?.items ?? {}).map(([id, item]) => ({
    id,
    ...item,
  })),
): CombatEquipment {
  return Object.freeze(
    Object.fromEntries(
      [definition.player, ...definition.enemies].flatMap((actor) => {
        const effects = actor.equipmentOwner
          ? combatOwnerEquipment(inventory, items, actor.equipmentOwner)
          : []

        return effects.length ? [[actor.id, effects]] : []
      }),
    ),
  )
}

export function combatActorMoves(
  actor: CombatActorDefinition,
  equipment: CombatEquipment = {},
): readonly string[] {
  return [
    ...new Set([
      ...actor.moves,
      ...(equipment[actor.id] ?? []).flatMap(
        (entry) => entry.effects.grantedMoves?.map((reference) => reference.id) ?? [],
      ),
    ]),
  ]
}

export function validateCombatEquipment(
  definition: CombatDefinition,
  equipment: CombatEquipment = {},
): void {
  const parsed = combatEquipmentSchema.parse(equipment)

  const actors = new Map(
    [definition.player, ...definition.enemies].map((actor) => [actor.id, actor]),
  )

  for (const [actor, entries] of Object.entries(parsed)) {
    if (!actors.get(actor)?.equipmentOwner)
      throw new Error('Equipment effects require an actor equipment owner')

    if (
      new Set(entries.map((entry) => entry.item)).size !== entries.length ||
      new Set(entries.map((entry) => entry.slot)).size !== entries.length
    )
      throw new Error('Duplicate combat equipment item or slot')

    for (const entry of entries)
      for (const reference of entry.effects.passives ?? [])
        if (!definition.passiveDefinitions?.[reference.library]?.[reference.id])
          throw new Error(`Equipment passive unavailable: ${reference.library}/${reference.id}`)

    for (const entry of entries)
      for (const move of entry.effects.grantedMoves ?? [])
        if (!definition.moves[move.id]) throw new Error(`Equipment move unavailable: ${move.id}`)
  }
}

/** Positive resource changes only. Sets, payments, recovery losses and unowned gauges bypass gear. */
export function combatEquipmentResourceGain(
  equipment: CombatEquipment | undefined,
  actor: string | undefined,
  resource: string,
  amount: number,
) {
  let flat = 0,
    percent = 0

  const items: string[] = []

  for (const entry of actor ? (equipment?.[actor] ?? []) : []) {
    const modifier = Object.hasOwn(entry.effects.resourceGains ?? {}, resource)
      ? entry.effects.resourceGains?.[resource]
      : undefined

    if (!modifier || (!modifier.flat && !modifier.percent)) continue
    flat += modifier.flat ?? 0
    percent += modifier.percent ?? 0

    if (!Number.isSafeInteger(flat) || !Number.isSafeInteger(Math.round(percent * 100)))
      throw new RangeError('Equipment resource modifier overflow')
    items.push(entry.item)
  }

  const base = amount + flat

  if (!Number.isSafeInteger(base)) throw new RangeError('Equipment resource gain overflow')

  return { amount: items.length ? applyCombatPercent(Math.max(0, base), percent) : amount, items }
}
