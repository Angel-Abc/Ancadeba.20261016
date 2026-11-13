import {
  combatStatNames,
  type CombatBonuses,
  type CombatDefinition,
  type CombatStatsProfile,
} from '@ancadeba/schemas'
import type { GameInstance } from './gameLifecycle.js'
import type { IGameBindings } from './gameBindings.js'
import type { IStateTransactions, StateWrite } from './stateTransactions.js'
import type { InventoryItemSnapshot, InventoryEquipmentPreparation } from './inventory.js'
import { temporaryCombatStats, type TemporaryStatContribution } from './combatEffects.js'
import { combatOwnerEquipment } from './combatEquipment.js'
import type { CombatEquippedEffects } from '@ancadeba/schemas'
import { runtimeText } from './runtimeText.js'

export interface CombatStatsSnapshot {
  readonly equipmentEffects?: readonly CombatEquippedEffects[] | undefined
  readonly temporary: readonly TemporaryStatContribution[]
  readonly base: Readonly<CombatBonuses>
  readonly equipment: Readonly<CombatBonuses>
  readonly total: Readonly<CombatBonuses>
  readonly contributions: readonly {
    readonly item: string
    readonly bonuses: Readonly<CombatBonuses>
  }[]
  readonly health: number
  readonly lockedBy: string | undefined
  readonly version: object
}

export interface EquipmentComparison {
  readonly current: CombatStatsSnapshot
  readonly proposed: CombatStatsSnapshot
  readonly delta: Readonly<CombatBonuses>
  readonly issue: string | undefined
}

export interface IGameCombatStats {
  snapshot(owner: string): CombatStatsSnapshot | undefined
  compare(owner: string, item: string, slot?: string): EquipmentComparison | undefined
  reason(owner: string): string | undefined
  subscribeChanges(listener: () => void): () => void
}

/** Calculates derived values without changing base fields. Enlists health clamps in inventory commits. */
export class GameCombatStats implements IGameCombatStats {
  private temporaryEffects: (owner: string) => readonly TemporaryStatContribution[] = () => []
  setTemporaryEffects(read: (owner: string) => readonly TemporaryStatContribution[]): () => void {
    this.temporaryEffects = read

    return () => {
      if (this.temporaryEffects === read) this.temporaryEffects = () => []
    }
  }
  baseSnapshot(owner: string): CombatStatsSnapshot | undefined {
    return this.calculate(owner, this.game.inventory?.snapshot ?? [], false, false)
  }
  private readonly locks = new Map<string, { id: string; label: string }>()
  private readonly versions = new Map<string, { signature: string; token: object }>()
  private readonly encounterVersions = new Map<
    string,
    { versions: readonly (object | undefined)[]; token: object }
  >()
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[] = []
  private disposed = false
  constructor(
    private readonly game: GameInstance,
    private readonly bindings: IGameBindings,
    private readonly state: IStateTransactions | undefined,
    private readonly invalidate: () => void,
  ) {
    const inventory = game.inventory

    if (
      Object.values(game.data.inventory?.owners ?? {}).some((owner) => owner.combatStats) &&
      inventory?.setEquipmentPolicy
    )
      this.cleanups.push(
        inventory.setEquipmentPolicy({ prepare: (before, after) => this.prepare(before, after) }),
      )
    this.cleanups.push(bindings.subscribeChanges(() => this.notify()))
  }
  profile(owner: string): CombatStatsProfile | undefined {
    return this.game.data.inventory?.owners[owner]?.combatStats
  }
  /** Validate candidate base values before any state transaction (including level gains) commits. */
  prepareState(writes: readonly StateWrite[], adapter = this.state) {
    if (this.disposed || !adapter) return

    const read = (source: number | CombatStatsProfile['health']) =>
      typeof source === 'number'
        ? source
        : (writes.find((write) => JSON.stringify(write.path) === JSON.stringify(source.path))
            ?.value ?? this.read(source))

    for (const owner of Object.keys(this.game.data.inventory?.owners ?? {})) {
      const profile = this.profile(owner)

      if (!profile) continue
      const totals: CombatBonuses = { attack: 0, defense: 0, guard: 0, maximumHealth: 0 }

      for (const stat of combatStatNames) {
        const base = read(profile[stat])

        if (base === undefined || !Number.isSafeInteger(base) || base < 0) return
        totals[stat] = (this.game.inventory?.snapshot ?? []).reduce(
          (sum, item) =>
            sum +
            (item.placement.type === 'equipped' && item.placement.owner === owner
              ? (this.game.data.inventory?.itemTypes[item.itemType]?.combatBonuses?.[stat] ?? 0)
              : 0),
          base,
        )

        if (
          !Number.isSafeInteger(totals[stat]) ||
          totals[stat] < (stat === 'maximumHealth' ? 1 : 0)
        )
          return
      }

      const hp = read(profile.health)

      if (hp === undefined || !Number.isSafeInteger(hp) || hp < 0 || hp > totals.maximumHealth)
        return
    }

    return adapter.prepare(writes)
  }
  private read(source: number | CombatStatsProfile['health']): number | undefined {
    const result = typeof source === 'number' ? source : this.bindings.read(source)

    const value =
      typeof result === 'number' ? result : result.status === 'resolved' ? result.value : undefined

    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined
  }
  private calculate(
    owner: string,
    items: readonly InventoryItemSnapshot[],
    candidateHealth = false,
    withTemporary = true,
  ): CombatStatsSnapshot | undefined {
    const profile = !this.disposed && this.profile(owner)

    if (!profile) return
    const base: CombatBonuses = { attack: 0, defense: 0, guard: 0, maximumHealth: 0 }
    const equipment: CombatBonuses = { attack: 0, defense: 0, guard: 0, maximumHealth: 0 }

    const contributions = items
      .filter((item) => item.placement.type === 'equipped' && item.placement.owner === owner)
      .map((item) => ({
        item: item.id,
        bonuses: Object.freeze({
          ...equipment,
          ...this.game.data.inventory?.itemTypes[item.itemType]?.combatBonuses,
        }),
      }))

    const total: CombatBonuses = { attack: 0, defense: 0, guard: 0, maximumHealth: 0 }

    for (const stat of combatStatNames) {
      const value = this.read(profile[stat])

      if (value === undefined) return
      base[stat] = value

      for (const contribution of contributions) equipment[stat] += contribution.bonuses[stat]
      total[stat] = value + equipment[stat]

      if (
        !Number.isSafeInteger(equipment[stat]) ||
        !Number.isSafeInteger(total[stat]) ||
        total[stat] < (stat === 'maximumHealth' ? 1 : 0)
      )
        return
    }

    const health = this.read(profile.health)

    if (health === undefined || (!candidateHealth && health > total.maximumHealth)) return
    const lockedBy = this.locks.get(owner)?.id
    const temporary = withTemporary ? this.temporaryEffects(owner) : []
    let effective

    try {
      effective = temporaryCombatStats(total, temporary)
    } catch {
      return
    }

    const equipmentEffects = combatOwnerEquipment(this.game.data.inventory, items, owner)

    const signature = JSON.stringify([
      base,
      contributions,
      equipmentEffects,
      temporary,
      health,
      lockedBy,
    ])

    let version = candidateHealth || !withTemporary ? undefined : this.versions.get(owner)

    if (!version || version.signature !== signature) {
      version = { signature, token: Object.freeze({}) }

      if (!candidateHealth && withTemporary) this.versions.set(owner, version)
    }

    return Object.freeze({
      ...(equipmentEffects.length ? { equipmentEffects } : {}),
      base: Object.freeze(base),
      equipment: Object.freeze(equipment),
      total: effective,
      temporary,
      contributions: Object.freeze(contributions.map((c) => Object.freeze(c))),
      health: Math.min(health, total.maximumHealth),
      lockedBy,
      version: version.token,
    })
  }
  snapshot(owner: string): CombatStatsSnapshot | undefined {
    const snapshot = this.calculate(owner, this.game.inventory?.snapshot ?? [])

    if (!snapshot) this.versions.delete(owner)

    return snapshot
  }
  get bindingValues() {
    return Object.fromEntries(
      Object.keys(this.game.data.inventory?.owners ?? {}).map((owner) => {
        const snapshot = this.snapshot(owner)

        return [
          owner,
          snapshot
            ? {
                ...snapshot.total,
                health: snapshot.health,
                available: true,
                locked: Boolean(snapshot.lockedBy),
              }
            : { available: false, locked: this.locks.has(owner) },
        ]
      }),
    )
  }
  healthBonus(path: readonly string[]): number {
    const owner = Object.entries(this.game.data.inventory?.owners ?? {}).find(
      ([, owner]) => JSON.stringify(owner.combatStats?.health.path) === JSON.stringify(path),
    )?.[0]

    if (!owner) return 0

    return (
      this.game.inventory?.snapshot.reduce(
        (sum, item) =>
          sum +
          (item.placement.type === 'equipped' && item.placement.owner === owner
            ? (this.game.data.inventory?.itemTypes[item.itemType]?.combatBonuses?.maximumHealth ??
              0)
            : 0),
        0,
      ) ?? 0
    )
  }
  reason(owner: string): string | undefined {
    const profile = this.profile(owner)

    if (!profile) return

    if (!this.game.inventory?.setEquipmentPolicy) return profile.messages.unavailable
    const lock = this.locks.get(owner)

    return lock
      ? profile.messages.locked.replace(
          /\{encounter\}/g,
          this.game.data.combat?.get(lock.id)?.label ?? lock.label,
        )
      : this.snapshot(owner)
        ? undefined
        : profile.messages.unavailable
  }
  encounterIssue(definition: CombatDefinition): string | undefined {
    for (const actor of [definition.player, ...definition.enemies]) {
      if (!actor.equipmentOwner) continue

      if (!this.game.inventory?.setEquipmentPolicy) return definition.messages.unavailable
      const lock = this.locks.get(actor.equipmentOwner)

      if (lock && lock.id !== definition.id) return this.reason(actor.equipmentOwner)

      if (!this.snapshot(actor.equipmentOwner))
        return (
          this.profile(actor.equipmentOwner)?.messages.unavailable ??
          definition.messages.unavailable
        )
    }
  }
  encounterVersion(definition: CombatDefinition): object | undefined {
    const versions = [definition.player, ...definition.enemies]
      .filter((a) => a.equipmentOwner)
      .map((a) => this.snapshot(a.equipmentOwner!)?.version)

    if (!versions.length) return
    let entry = this.encounterVersions.get(definition.id)

    if (!entry || entry.versions.some((version, index) => version !== versions[index])) {
      entry = { versions, token: Object.freeze({}) }
      this.encounterVersions.set(definition.id, entry)
    }

    return entry.token
  }
  acquire(definition: CombatDefinition): boolean {
    if (this.encounterIssue(definition)) return false
    let changed = false

    for (const actor of [definition.player, ...definition.enemies])
      if (actor.equipmentOwner && !this.locks.has(actor.equipmentOwner)) {
        this.locks.set(actor.equipmentOwner, { id: definition.id, label: definition.label })
        changed = true
      }

    if (changed) {
      this.versions.clear()
      this.invalidate()
    }

    return true
  }
  release(encounter: string): void {
    let changed = false

    for (const [owner, lock] of this.locks)
      if (lock.id === encounter) {
        this.locks.delete(owner)
        changed = true
      }

    if (changed) this.versions.clear()
  }
  private prepare(
    before: ReadonlyMap<string, InventoryItemSnapshot>,
    after: ReadonlyMap<string, InventoryItemSnapshot>,
  ): InventoryEquipmentPreparation {
    const owners = new Set<string>()

    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(id),
        next = after.get(id)

      if (JSON.stringify(previous?.placement) === JSON.stringify(next?.placement)) continue

      for (const item of [previous, next])
        if (item?.placement.type === 'equipped') owners.add(item.placement.owner)
    }

    const captures = new Map<string, object>()
    const writes: StateWrite[] = []

    for (const owner of owners) {
      const profile = this.profile(owner)

      if (!profile) continue
      const reason = this.reason(owner)

      if (reason) return { reason }
      const previous = this.calculate(owner, [...before.values()])
      const proposed = this.calculate(owner, [...after.values()], true)

      if (!previous || !proposed) return { reason: profile.messages.unavailable }
      captures.set(owner, previous.version)

      if (proposed.health !== previous.health)
        writes.push({
          path: profile.health.path,
          expected: previous.health,
          value: proposed.health,
        })
    }

    const state = writes.length ? this.state?.prepare(writes) : undefined

    if (!captures.size) return {}

    if (writes.length && !state)
      return {
        reason: runtimeText(this.game.data, 'equipment.healthAdjustmentUnavailable'),
      }

    let committed = false,
      notified = false

    const current = () =>
      !this.disposed &&
      !committed &&
      [...captures].every(
        ([owner, version]) => this.snapshot(owner)?.version === version && !this.locks.has(owner),
      ) &&
      (state?.isCurrent() ?? true)

    return {
      effects: {
        isCurrent: current,
        commit: () => {
          if (!current()) return
          state?.commit()
          committed = true
        },
        notify: () => {
          if (!committed || notified) return
          notified = true
          this.invalidate()
        },
      },
    }
  }
  compare(owner: string, itemId: string, slot?: string): EquipmentComparison | undefined {
    const items = this.game.inventory?.snapshot
    const current = this.snapshot(owner)
    const item = items?.find((i) => i.id === itemId)

    if (!current || !items || !item) return
    const equipped = item.placement.type === 'equipped' && item.placement.owner === owner

    if (!equipped && !slot) return

    const staged = items.map((entry) => {
      if (entry.id === itemId)
        return {
          ...entry,
          placement: equipped
            ? { type: 'carried' as const, owner }
            : { type: 'equipped' as const, owner, slot: slot! },
        }

      if (
        !equipped &&
        entry.placement.type === 'equipped' &&
        entry.placement.owner === owner &&
        entry.placement.slot === slot
      )
        return { ...entry, placement: { type: 'carried' as const, owner } }

      return entry
    })

    const proposed = this.calculate(owner, staged, true)

    if (!proposed) return

    const delta: CombatBonuses = {
      attack: proposed.total.attack - current.total.attack,
      defense: proposed.total.defense - current.total.defense,
      guard: proposed.total.guard - current.total.guard,
      maximumHealth: proposed.total.maximumHealth - current.total.maximumHealth,
    }

    return Object.freeze({
      current,
      proposed,
      delta: Object.freeze(delta),
      issue: equipped
        ? this.game.inventory?.checkMove(itemId, { type: 'carried', owner })
        : this.game.inventory?.checkEquip(itemId, owner, slot!),
    })
  }
  subscribeChanges(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }
  private notify(): void {
    if (this.disposed) return

    const errors: unknown[] = []

    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue

      try {
        listener()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length) throw new AggregateError(errors, 'Combat stats observers failed')
  }
  dispose(): void {
    this.disposed = true

    for (const cleanup of this.cleanups.reverse()) cleanup()
    this.locks.clear()
    this.versions.clear()
    this.encounterVersions.clear()
    this.listeners.clear()
  }
}
