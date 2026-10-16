import type { Factories, Resolver } from './index.js'

export class Container<S> implements Resolver<S> {
  private readonly factories: Factories<S>

  // Service instances we have already created.
  private readonly instances = new Map<keyof S, unknown>()

  // Services currently being created.
  private readonly resolving = new Set<keyof S>()

  constructor(factories: Factories<S>) {
    this.factories = factories
  }

  resolve<K extends keyof S>(key: K): S[K] {
    // Reuse an existing instance.
    if (this.instances.has(key)) {
      return this.instances.get(key) as S[K]
    }

    // A factory has requested a service already being created.
    if (this.resolving.has(key)) {
      throw new Error(`Circular dependency: ${String(key)}`)
    }

    if (!Object.hasOwn(this.factories, key)) {
      throw new Error(`Missing factory: ${String(key)}`)
    }

    const factory = this.factories[key]
    this.resolving.add(key)

    try {
      const instance = factory(this)
      this.instances.set(key, instance)
      return instance
    } finally {
      this.resolving.delete(key)
    }
  }
}
