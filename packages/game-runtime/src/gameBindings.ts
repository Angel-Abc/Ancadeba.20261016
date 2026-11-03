import type { GameBindingDefinition } from '@ancadeba/schemas'
import type { IMessageBus, Unsubscribe } from '@ancadeba/utilities'
import type { ProgressionSnapshot } from './actions.js'
import type { EngineMessages } from './messages.js'

export interface GameBinding {
  readonly source: GameBindingDefinition['source']
  readonly path: readonly (string | number)[]
  readonly fallback?: string | undefined
}

export type BindingValue = string | number | boolean

export type BindingFailure =
  | 'source-unavailable'
  | 'missing-path'
  | 'unreadable-path'
  | 'unsupported-value'

export interface BindingDiagnostic {
  readonly source: GameBinding['source']
  readonly path: readonly (string | number)[]
  readonly reason: BindingFailure
}

export type BindingResult =
  | { readonly status: 'resolved'; readonly value: BindingValue }
  | { readonly status: 'unresolved'; readonly diagnostic: BindingDiagnostic }

export interface IGameBindings {
  read(binding: GameBinding): BindingResult
  /** Invalidation only, with no initial replay. Read again to obtain the latest values. */
  subscribeChanges(handler: () => void): Unsubscribe
}

interface BindingRoots {
  readonly state: () => unknown
  readonly progression: () => ProgressionSnapshot
}

/** A read-only view of one playthrough, invalidated through its scoped message bus. */
export class GameBindings implements IGameBindings {
  private roots: BindingRoots | undefined
  private readonly subscribers = new Set<() => void>()
  private readonly unsubscribes: Unsubscribe[]

  constructor(roots: BindingRoots, messages: IMessageBus<EngineMessages>) {
    this.roots = roots
    this.unsubscribes = [
      messages.subscribe('action.applied', () => this.notify()),
      messages.subscribe('turn.advanced', () => this.notify()),
      messages.subscribe('world-time.advanced', () => this.notify()),
    ]
  }

  read(binding: GameBinding): BindingResult {
    const unresolved = (reason: BindingFailure): BindingResult => ({
      status: 'unresolved',
      diagnostic: { source: binding.source, path: [...binding.path], reason },
    })

    if (!this.roots) return unresolved('source-unavailable')

    try {
      let value: unknown =
        binding.source === 'game.state' ? this.roots.state() : this.roots.progression()

      if (value === undefined) return unresolved('source-unavailable')

      for (const segment of binding.path) {
        if (value instanceof Map) {
          if (typeof segment !== 'string' || !Map.prototype.has.call(value, segment))
            return unresolved('missing-path')
          value = Map.prototype.get.call(value, segment)
        } else {
          if (typeof value !== 'object' || value === null) return unresolved('missing-path')

          if (Array.isArray(value) && (!Number.isSafeInteger(segment) || Number(segment) < 0))
            return unresolved('missing-path')

          if (!Array.isArray(value) && typeof segment !== 'string')
            return unresolved('missing-path')
          const descriptor = Object.getOwnPropertyDescriptor(value, segment)

          if (!descriptor) return unresolved('missing-path')

          if (!Object.hasOwn(descriptor, 'value')) return unresolved('unreadable-path')
          value = descriptor.value
        }
      }

      if (
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      )
        return { status: 'resolved', value }

      return unresolved('unsupported-value')
    } catch {
      return unresolved('unreadable-path')
    }
  }

  subscribeChanges(handler: () => void): Unsubscribe {
    if (!this.roots) throw new Error('Game bindings are disposed')
    const subscription = () => handler()
    this.subscribers.add(subscription)

    return () => {
      this.subscribers.delete(subscription)
    }
  }

  dispose(): void {
    this.roots = undefined
    this.subscribers.clear()

    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
  }

  private notify(): void {
    const errors: unknown[] = []

    for (const subscriber of [...this.subscribers]) {
      if (!this.roots) break

      if (!this.subscribers.has(subscriber)) continue

      try {
        subscriber()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length) throw new AggregateError(errors, 'Game binding subscribers failed')
  }
}
