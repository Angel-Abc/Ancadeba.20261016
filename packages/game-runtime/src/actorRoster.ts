import type { ActorRosterSnapshot, RosterChanges } from './turns.js'

export function copyRosterChanges(value: unknown): RosterChanges {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Invalid roster changes')
  const copy = (ids: unknown): readonly string[] => {
    if (
      !Array.isArray(ids) ||
      Array.from(ids).some((id) => typeof id !== 'string' || !id.trim()) ||
      new Set(ids).size !== ids.length
    )
      throw new TypeError('Roster changes require unique nonempty IDs')
    return Object.freeze([...ids])
  }
  const add = 'add' in value && value.add !== undefined ? copy(value.add) : Object.freeze([])
  const remove =
    'remove' in value && value.remove !== undefined ? copy(value.remove) : Object.freeze([])
  if (add.some((id) => remove.includes(id)))
    throw new TypeError('Cannot add and remove the same actor in one action')
  return Object.freeze({ add, remove })
}

export interface PreparedRosterChange {
  readonly previous: ActorRosterSnapshot
  readonly current: ActorRosterSnapshot
  readonly generations: ReadonlyMap<string, number>
}

/** Persistent registration order and generation history, independent of round participation. */
export class ActorRoster {
  private snapshot: ActorRosterSnapshot
  private generations: ReadonlyMap<string, number>

  constructor(actors: readonly string[]) {
    this.generations = new Map(actors.map((id) => [id, 1]))
    this.snapshot = Object.freeze({
      revision: 0,
      actors: Object.freeze(
        actors.map((actorId) => Object.freeze({ actorId, generation: 1, eligibleFromRound: 1 })),
      ),
    })
  }

  get current(): ActorRosterSnapshot {
    return this.snapshot
  }

  prepare(
    changes: RosterChanges | undefined,
    eligibleFromRound: number,
  ): PreparedRosterChange | undefined {
    const add = changes?.add ?? []
    const remove = changes?.remove ?? []
    if (!add.length && !remove.length) return undefined
    const existing = new Set(this.snapshot.actors.map((actor) => actor.actorId))
    if (add.some((id) => existing.has(id))) throw new TypeError('Cannot add an existing actor')
    if (remove.some((id) => !existing.has(id)))
      throw new TypeError('Cannot remove an unknown actor')
    const revision = this.snapshot.revision + 1
    if (
      !Number.isSafeInteger(revision) ||
      (add.length > 0 && !Number.isSafeInteger(eligibleFromRound))
    )
      throw new RangeError('Roster state exceeds the safe counter range')
    const generations = new Map(this.generations)
    const actors = this.snapshot.actors.filter((actor) => !remove.includes(actor.actorId))
    for (const actorId of add) {
      const generation = (generations.get(actorId) ?? 0) + 1
      if (!Number.isSafeInteger(generation))
        throw new RangeError('Actor generation exceeds the safe counter range')
      generations.set(actorId, generation)
      actors.push(Object.freeze({ actorId, generation, eligibleFromRound }))
    }
    return {
      previous: this.snapshot,
      current: Object.freeze({ revision, actors: Object.freeze(actors) }),
      generations,
    }
  }

  commit(change: PreparedRosterChange): void {
    this.snapshot = change.current
    this.generations = change.generations
  }
}
