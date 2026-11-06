export interface TradeStateWrite {
  readonly path: readonly string[]
  readonly expected: number
  readonly value: number
}

/** Prepared commits must be synchronous, infallible, and invoke no observers. */
export interface PreparedTradeState {
  isCurrent(): boolean
  commit(): void
}

export interface ITradeState {
  /** Pure preparation: validate the entire batch without changing state or notifying observers. */
  prepare(writes: readonly TradeStateWrite[]): PreparedTradeState | undefined
}

/** Narrow adapter for authored rules' owned Map state; never creates fields or invokes accessors. */
export class MapTradeState implements ITradeState {
  constructor(
    private readonly root: Map<string, unknown>,
    private readonly declared: readonly (readonly string[])[],
  ) {}

  prepare(writes: readonly TradeStateWrite[]): PreparedTradeState | undefined {
    const destinations: { node: Map<string, unknown>; key: string; write: TradeStateWrite }[] = []

    const locate = (path: readonly string[]): Map<string, unknown> | undefined => {
      let node = this.root

      for (const part of path.slice(0, -1)) {
        const child = Map.prototype.get.call(node, part)

        if (!(child instanceof Map)) return
        node = child
      }

      return node
    }

    for (const source of writes) {
      const write = { ...source, path: [...source.path] }

      if (
        !this.declared.some((path) => JSON.stringify(path) === JSON.stringify(write.path)) ||
        !Number.isSafeInteger(write.expected) ||
        write.expected < 0 ||
        !Number.isSafeInteger(write.value) ||
        write.value < 0
      )
        return
      const node = locate(write.path)
      const key = write.path.at(-1)

      if (
        !node ||
        !key ||
        Map.prototype.get.call(node, key) !== write.expected ||
        destinations.some((entry) => entry.node === node && entry.key === key)
      )
        return
      destinations.push({ node, key, write })
    }

    return {
      isCurrent: () =>
        destinations.every(
          ({ node, key, write }) =>
            locate(write.path) === node && Map.prototype.get.call(node, key) === write.expected,
        ),
      commit: () => {
        for (const { node, key, write } of destinations)
          Map.prototype.set.call(node, key, write.value)
      },
    }
  }
}
