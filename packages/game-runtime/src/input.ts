import type { InputData } from './gameData.js'

export interface VirtualInput {
  readonly context: string
  readonly input: string
  readonly phase: 'pressed' | 'released' | 'cancelled'
}

export interface IGameInput {
  readonly context: string
  setContext(id: string): void
  isKeyMapped(code: string): boolean
  pressKey(code: string): boolean
  releaseKey(code: string): boolean
  reset(): void
}

/** Session-owned input state. No host events or automatic bus delivery. */
export class InputController implements IGameInput {
  private readonly keyboard: Map<string, string>
  private readonly contexts: Map<string, Map<string, string>>
  private readonly held = new Map<string, string>()
  private readonly suppressed = new Set<string>()
  private virtualKeys = new Set<string>()
  private inputs = new Set<string>()
  private activeContext: string
  private disposed = false

  constructor(
    data: InputData,
    private readonly messages: { publish(topic: 'input.virtual', payload: VirtualInput): void },
  ) {
    this.keyboard = new Map(Object.entries(data.keyboard))
    this.contexts = new Map(
      Object.entries(data.contexts).map(([id, mappings]) => [
        id,
        new Map(Object.entries(mappings)),
      ]),
    )
    if (!this.contexts.has(data.initialContext)) throw new Error('Unknown initial input context')
    this.activeContext = data.initialContext
  }

  get context(): string {
    return this.activeContext
  }

  isKeyMapped(code: string): boolean {
    const key = this.keyboard.get(code)
    return !this.disposed && key !== undefined && this.contexts.get(this.context)?.has(key) === true
  }

  setContext(id: string): void {
    if (this.disposed) return
    if (!this.contexts.has(id)) throw new Error(`Unknown input context: ${id}`)
    if (id === this.context) return
    this.cancelInputs()
    for (const code of this.held.keys()) this.suppressed.add(code)
    this.activeContext = id
  }

  pressKey(code: string): boolean {
    if (this.disposed) return false
    const key = this.keyboard.get(code)
    if (key === undefined) return false
    if (!this.held.has(code)) {
      this.held.set(code, key)
      this.reconcile()
    }
    return this.isKeyMapped(code) && !this.suppressed.has(code)
  }

  releaseKey(code: string): boolean {
    if (this.disposed || !this.held.delete(code)) return false
    const accepted = this.isKeyMapped(code) && !this.suppressed.has(code)
    this.suppressed.delete(code)
    this.reconcile()
    return accepted
  }

  reset(): void {
    if (this.disposed) return
    this.cancelInputs()
    this.held.clear()
    this.suppressed.clear()
  }

  dispose(): void {
    this.disposed = true
    this.held.clear()
    this.suppressed.clear()
    this.virtualKeys.clear()
    this.inputs.clear()
  }

  private cancelInputs(): void {
    for (const input of this.inputs) this.publish(input, 'cancelled')
    this.inputs.clear()
    this.virtualKeys.clear()
  }

  private reconcile(): void {
    this.virtualKeys = new Set(
      [...this.held].filter(([code]) => !this.suppressed.has(code)).map(([, key]) => key),
    )
    const mappings = this.contexts.get(this.context)!
    const next = new Set<string>()
    for (const key of this.virtualKeys) {
      const input = mappings.get(key)
      if (input !== undefined) next.add(input)
    }
    for (const input of this.inputs) if (!next.has(input)) this.publish(input, 'released')
    for (const input of next) if (!this.inputs.has(input)) this.publish(input, 'pressed')
    this.inputs = next
  }

  private publish(input: string, phase: VirtualInput['phase']): void {
    this.messages.publish('input.virtual', { context: this.context, input, phase })
  }
}
