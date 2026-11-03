// One queue per server also covers legacy file writes.
export class EditorCoordinator {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)

    return result
  }
}
