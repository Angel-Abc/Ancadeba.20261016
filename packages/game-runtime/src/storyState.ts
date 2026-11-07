import type { PreparedTradeState } from './tradeState.js'

export interface StoryStateWrite {
  readonly path: readonly string[]
  readonly expected: string | boolean
  readonly value: string | boolean
}

/** Optional host capability. Preparation is pure; commit is synchronous and invokes no observers. */
export interface IStoryStateTransactions {
  prepare(
    writes: readonly StoryStateWrite[],
    log: readonly string[],
  ): PreparedTradeState | undefined
}

export interface StoryLogAdapter {
  prepare(entries: readonly string[]): PreparedTradeState | undefined
}

/** Writes only declared string/boolean fields in authored state; bindings remain read-only. */
export class MapStoryState implements IStoryStateTransactions {
  constructor(
    private readonly root: Map<string, unknown>,
    private readonly declared: readonly (readonly string[])[],
    private readonly log?: StoryLogAdapter,
  ) {}

  prepare(
    writes: readonly StoryStateWrite[],
    entries: readonly string[],
  ): PreparedTradeState | undefined {
    const destinations: { node: Map<string, unknown>; key: string; write: StoryStateWrite }[] = []

    const locate = (path: readonly string[]) => {
      let node = this.root

      for (const part of path.slice(0, -1)) {
        const child: unknown = Map.prototype.get.call(node, part)

        if (!(child instanceof Map)) return
        node = child
      }

      return node
    }

    for (const source of writes) {
      const write = { ...source, path: [...source.path] }
      const key = write.path.at(-1)
      const node = locate(write.path)

      if (
        !node ||
        !key ||
        typeof write.expected !== typeof write.value ||
        !this.declared.some((path) => JSON.stringify(path) === JSON.stringify(write.path)) ||
        destinations.some((entry) => entry.node === node && entry.key === key) ||
        Map.prototype.get.call(node, key) !== write.expected
      )
        return
      destinations.push({ node, key, write })
    }

    const log = entries.length ? this.log?.prepare(entries) : undefined

    if (entries.length && !log) return

    return {
      isCurrent: () =>
        destinations.every(
          ({ node, key, write }) =>
            locate(write.path) === node && Map.prototype.get.call(node, key) === write.expected,
        ) &&
        (log?.isCurrent() ?? true),
      commit: () => {
        for (const { node, key, write } of destinations)
          Map.prototype.set.call(node, key, write.value)
        log?.commit()
      },
    }
  }
}
