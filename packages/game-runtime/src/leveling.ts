import { levelForXp, type CombatDefinition } from '@ancadeba/schemas'
import type { GameInstance } from './gameLifecycle.js'
import type { IGameBindings } from './gameBindings.js'
import type { IStateTransactions, StateWrite, PreparedStateWrites } from './stateTransactions.js'
import type { GameSave } from '@ancadeba/schemas'

interface LevelReceipt {
  readonly from: number
  readonly to: number
  readonly gains: readonly { level: number; id: string; amount: number }[]
}

export interface LevelingSnapshot {
  readonly xp: number
  readonly level: number
  readonly maximumLevel: number
  readonly capped: boolean
  readonly nextLevelXp: number | undefined
  readonly xpIntoLevel: number
  readonly xpToNextLevel: number
  readonly progressValue: number
  readonly progressMaximum: number
  readonly available: boolean
  readonly receipt: LevelReceipt | undefined
}

export type XpGrantResult = { readonly status: 'applied' } | { readonly status: 'rejected' }

export interface IGameLeveling {
  snapshot(profile: string): LevelingSnapshot | undefined
  grantXp(profile: string, amount: number): XpGrantResult
  text(profile: string): string
  subscribeChanges(listener: () => void): () => void
}

/** Expands XP writes into one validated state batch. Prepared commits never notify observers. */
export class GameLeveling implements IGameLeveling, IStateTransactions {
  private healthBonus: (path: readonly string[]) => number = () => 0
  setHealthBonus(read: (path: readonly string[]) => number): void {
    this.healthBonus = read
  }
  private readonly receipts = new Map<string, LevelReceipt>()
  private readonly listeners = new Set<() => void>()
  private readonly versions = new Map<string, { signature: string; token: object }>()
  private readonly unsubscribe: () => void
  private disposed = false

  save(): GameSave['leveling'] {
    return Object.fromEntries(
      [...this.receipts].map(([id, receipt]) => [
        id,
        { ...receipt, gains: receipt.gains.map((gain) => ({ ...gain })) },
      ]),
    )
  }

  restore(save: GameSave['leveling']): void {
    for (const [id, receipt] of Object.entries(save)) {
      const profile = this.game.data.leveling?.get(id)

      if (!profile || receipt.from > receipt.to || receipt.to > profile.levels.length)
        throw new Error('Invalid saved level receipt')
      this.receipts.set(id, receipt)
    }
  }
  constructor(
    private readonly game: GameInstance,
    private readonly bindings: IGameBindings,
    private readonly state: IStateTransactions | undefined,
    private readonly invalidate: () => void,
  ) {
    this.unsubscribe = bindings.subscribeChanges(() => this.notify())
  }
  private read(path: readonly string[]): number | undefined {
    const result = this.bindings.read({ source: 'game.state', path })

    return result.status === 'resolved' &&
      typeof result.value === 'number' &&
      Number.isSafeInteger(result.value) &&
      result.value >= 0
      ? result.value
      : undefined
  }
  snapshot(id: string): LevelingSnapshot | undefined {
    const profile = !this.disposed && this.game.data.leveling?.get(id)

    if (!profile) return
    const xp = this.read(profile.xp.path)
    const level = this.read(profile.level.path)

    const fields = [
      profile.xp,
      profile.level,
      ...profile.levels.flatMap((row) => row.gains.map((gain) => gain.field)),
      ...(profile.health ? [profile.health.current, profile.health.maximum] : []),
    ]

    let available = xp !== undefined && level !== undefined && level === levelForXp(profile, xp)
    const writes = new Map<string, StateWrite>()

    for (const field of fields) {
      const value = this.read(field.path)

      if (value === undefined) {
        available = false
        continue
      }

      writes.set(JSON.stringify(field.path), { path: field.path, expected: value, value })
    }

    if (profile.health) {
      const current = this.read(profile.health.current.path)
      const baseMaximum = this.read(profile.health.maximum.path)

      const maximum =
        baseMaximum === undefined
          ? undefined
          : baseMaximum + this.healthBonus(profile.health.current.path)

      if (
        current === undefined ||
        maximum === undefined ||
        !Number.isSafeInteger(maximum) ||
        maximum <= 0 ||
        current > maximum
      )
        available = false
    }

    try {
      if (!this.state?.prepare([...writes.values()])) available = false
    } catch {
      available = false
    }

    const validLevel =
      level !== undefined && level >= 1 && level <= profile.levels.length ? level : 1

    const next = profile.levels[validLevel]?.xp
    const into = Math.max(0, (xp ?? 0) - profile.levels[validLevel - 1]!.xp)
    const capped = validLevel === profile.levels.length

    return Object.freeze({
      xp: xp ?? 0,
      level: validLevel,
      maximumLevel: profile.levels.length,
      capped,
      nextLevelXp: next,
      xpIntoLevel: into,
      xpToNextLevel: next === undefined ? 0 : Math.max(0, next - (xp ?? 0)),
      progressValue: capped ? 1 : into,
      progressMaximum: capped ? 1 : next! - profile.levels[validLevel - 1]!.xp,
      available,
      receipt: this.receipts.get(id),
    })
  }
  get bindingValues(): Readonly<Record<string, LevelingSnapshot>> {
    return Object.fromEntries(
      [...(this.game.data.leveling?.keys() ?? [])].flatMap((id) => {
        const value = this.snapshot(id)

        return value ? [[id, value]] : []
      }),
    )
  }
  version(id: string | undefined): object | undefined {
    if (!id) return
    const value = this.snapshot(id)

    const signature = JSON.stringify(
      value ? [value.xp, value.level, value.available, value.receipt] : undefined,
    )

    let version = this.versions.get(id)

    if (!version || version.signature !== signature) {
      version = { signature, token: {} }
      this.versions.set(id, version)
    }

    return version.token
  }
  moveAvailable(definition: CombatDefinition, move: string): boolean {
    if (!definition.player.leveling) return true
    const snapshot = this.snapshot(definition.player.leveling)

    return Boolean(
      snapshot?.available && snapshot.level >= (definition.player.moveLevels?.[move] ?? 1),
    )
  }
  prepare(incoming: readonly StateWrite[]): PreparedStateWrites | undefined {
    if (this.disposed || !this.state) return

    if (
      incoming.some(
        (write) =>
          this.read(write.path) !== write.expected ||
          !Number.isSafeInteger(write.value) ||
          write.value < 0,
      )
    )
      return
    const profiles = [...(this.game.data.leveling?.values() ?? [])]
    const key = (path: readonly string[]) => JSON.stringify(path)

    if (
      new Set(incoming.map((write) => key(write.path))).size !== incoming.length ||
      incoming.some((write) =>
        profiles.some((profile) => key(profile.level.path) === key(write.path)),
      )
    )
      return

    const writes = new Map(
      incoming.map((write) => [key(write.path), { ...write, path: [...write.path] }]),
    )

    const receipts = new Map<string, LevelReceipt>()

    const set = (path: readonly string[], value: number) => {
      const expected = this.read(path)

      if (expected === undefined || !Number.isSafeInteger(value) || value < 0) return false
      writes.set(key(path), { path: [...path], expected, value })

      return true
    }

    const candidate = (path: readonly string[]) => writes.get(key(path))?.value ?? this.read(path)

    for (const profile of profiles) {
      const xpWrite = writes.get(key(profile.xp.path))

      if (!xpWrite) continue
      const previous = this.snapshot(profile.id)

      if (
        !previous?.available ||
        xpWrite.expected !== previous.xp ||
        xpWrite.value < previous.xp ||
        !Number.isSafeInteger(xpWrite.value)
      )
        return
      const nextLevel = levelForXp(profile, xpWrite.value)

      if (nextLevel === previous.level) continue
      const gains: { level: number; id: string; amount: number }[] = []

      for (let level = previous.level + 1; level <= nextLevel; level++)
        for (const gain of profile.levels[level - 1]!.gains) {
          const value = candidate(gain.field.path)

          if (value === undefined || !set(gain.field.path, value + gain.amount)) return
          gains.push(Object.freeze({ level, id: gain.id, amount: gain.amount }))
        }

      if (!set(profile.level.path, nextLevel)) return

      if (profile.health) {
        const current = candidate(profile.health.current.path)
        const bonus = this.healthBonus(profile.health.current.path)
        const maximumBase = candidate(profile.health.maximum.path)
        const beforeBase = this.read(profile.health.maximum.path)
        const maximum = maximumBase === undefined ? undefined : maximumBase + bonus
        const beforeMaximum = beforeBase === undefined ? undefined : beforeBase + bonus

        if (
          current === undefined ||
          maximum === undefined ||
          !Number.isSafeInteger(maximum) ||
          beforeMaximum === undefined ||
          maximum <= 0 ||
          current > maximum
        )
          return

        if (current > 0 && maximum > beforeMaximum && profile.health.policy !== 'preserve') {
          const next =
            profile.health.policy === 'restore' ? maximum : current + maximum - beforeMaximum

          if (!set(profile.health.current.path, next)) return
        }
      }

      receipts.set(
        profile.id,
        Object.freeze({ from: previous.level, to: nextLevel, gains: Object.freeze(gains) }),
      )
    }

    const prepared = this.state.prepare([...writes.values()])

    if (!prepared) return
    let committed = false

    return {
      isCurrent: () => !this.disposed && !committed && prepared.isCurrent(),
      commit: () => {
        if (this.disposed || committed || !prepared.isCurrent()) return
        prepared.commit()
        committed = true

        for (const [id, receipt] of receipts) this.receipts.set(id, receipt)
      },
    }
  }
  grantXp(id: string, amount: number): XpGrantResult {
    const profile = this.game.data.leveling?.get(id)
    const current = this.snapshot(id)

    if (!profile || !current?.available || !Number.isSafeInteger(amount) || amount < 0)
      return { status: 'rejected' }
    const next = current.xp + amount

    if (!Number.isSafeInteger(next)) return { status: 'rejected' }
    const prepared = this.prepare([{ path: profile.xp.path, expected: current.xp, value: next }])

    if (!prepared?.isCurrent()) return { status: 'rejected' }
    prepared.commit()
    this.invalidate()

    return { status: 'applied' }
  }
  text(id: string): string {
    const profile = this.game.data.leveling?.get(id)
    const snapshot = this.snapshot(id)

    if (!profile || !snapshot) return ''

    if (!snapshot.available) return profile.messages.unavailable
    const receipt = snapshot.receipt

    if (!receipt) return ''
    const lines: string[] = []

    for (let level = receipt.from + 1; level <= receipt.to; level++)
      lines.push(profile.messages.gained.replaceAll('{level}', String(level)))

    const stats = new Map<string, { label: string; amount: number }>()

    for (const gain of receipt.gains) {
      const definition = profile.levels[gain.level - 1]!.gains.find(
        (value) => value.id === gain.id,
      )!

      const key = JSON.stringify(definition.field.path)
      const previous = stats.get(key)
      stats.set(key, {
        label: previous?.label ?? definition.label,
        amount: (previous?.amount ?? 0) + gain.amount,
      })
    }

    for (const stat of stats.values())
      lines.push(
        profile.messages.stat
          .replaceAll('{label}', stat.label)
          .replaceAll('{amount}', String(stat.amount)),
      )
    const unlocks = new Set<string>()

    for (const combat of this.game.data.combat?.values() ?? [])
      if (combat.player.leveling === id)
        for (const [move, level] of Object.entries(combat.player.moveLevels ?? {}))
          if (level > receipt.from && level <= receipt.to)
            unlocks.add(profile.messages.unlocked.replaceAll('{move}', combat.moves[move]!.label))

    return [...lines, ...unlocks].join('\n')
  }
  subscribeChanges(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }
  private notify(): void {
    if (this.disposed || !this.game.data.leveling?.size) return
    const errors: unknown[] = []

    for (const listener of [...this.listeners])
      try {
        if (this.listeners.has(listener)) listener()
      } catch (error) {
        errors.push(error)
      }

    if (errors.length) throw new AggregateError(errors, 'Leveling observers failed after commit')
  }
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.listeners.clear()
    this.receipts.clear()
    this.versions.clear()
  }
}
