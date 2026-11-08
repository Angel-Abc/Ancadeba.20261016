import type { MapDefinition } from '@ancadeba/schemas'

export interface MapDraftState {
  map: MapDefinition
  id: string
}

interface Value {
  exists: boolean
  value?: unknown
}

interface Patch {
  path: string[]
  before: Value
  after: Value
}

interface Entry {
  patches: Patch[]
  layer: string
  bytes: number
}

type DraftObject = Record<string, unknown> | unknown[]

const object = (value: unknown): value is DraftObject => typeof value === 'object' && value !== null

const own = (value: DraftObject, key: string): Value => {
  const property = Object.getOwnPropertyDescriptor(value, key)

  return property ? { exists: true, value: property.value } : { exists: false }
}

/** Map draft values are plain records, arrays, and primitives, including undefined and NaN. */
function differences(before: Value, after: Value, path: string[], result: Patch[]): void {
  if (before.exists === after.exists && Object.is(before.value, after.value)) return

  if (
    before.exists &&
    after.exists &&
    object(before.value) &&
    object(after.value) &&
    Array.isArray(before.value) === Array.isArray(after.value) &&
    (!Array.isArray(before.value) ||
      before.value.length === (Array.isArray(after.value) ? after.value.length : -1))
  ) {
    const keys = new Set([...Object.keys(before.value), ...Object.keys(after.value)])

    for (const key of keys)
      differences(own(before.value, key), own(after.value, key), [...path, key], result)

    return
  }

  result.push({ path, before: structuredClone(before), after: structuredClone(after) })
}

function diff(before: MapDraftState, after: MapDraftState): Patch[] {
  const patches: Patch[] = []
  differences({ exists: true, value: before }, { exists: true, value: after }, [], patches)

  return patches
}

function equal(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true

  if (!object(before) || !object(after) || Array.isArray(before) !== Array.isArray(after))
    return false

  if (Array.isArray(before) && Array.isArray(after) && before.length !== after.length) return false
  const keys = Object.keys(before)

  return (
    keys.length === Object.keys(after).length &&
    keys.every(
      (key) => Object.hasOwn(after, key) && equal(own(before, key).value, own(after, key).value),
    )
  )
}

function restore(
  state: MapDraftState,
  patches: readonly Patch[],
  direction: 'before' | 'after',
): MapDraftState {
  let result: unknown = structuredClone(state)

  for (const patch of patches) {
    const value = patch[direction]

    if (!patch.path.length) {
      result = structuredClone(value.value)
      continue
    }

    let parent = result

    for (const key of patch.path.slice(0, -1)) {
      if (!object(parent)) throw new Error('Invalid map history path')
      parent = own(parent, key).value
    }

    if (!object(parent)) throw new Error('Invalid map history target')
    const key = patch.path.at(-1)!

    if (value.exists)
      Object.defineProperty(parent, key, {
        value: structuredClone(value.value),
        writable: true,
        configurable: true,
        enumerable: true,
      })
    else Reflect.deleteProperty(parent, key)
  }

  // SAFETY: patches are generated only from complete MapDraftState values and applied to their paired state.
  return result as MapDraftState
}

/** Bounded draft history stores changed paths, so ordinary brush strokes retain only edited cells. */
export class MapDraftHistory {
  private current: MapDraftState
  private baseline: MapDraftState
  private past: Entry[] = []
  private future: Entry[] = []
  private group: number | undefined
  private bytes = 0

  constructor(
    initial: MapDraftState,
    private readonly steps = 100,
    private readonly budget = 16 * 1024 * 1024,
  ) {
    this.current = structuredClone(initial)
    this.baseline = structuredClone(initial)
  }
  get canUndo() {
    return this.past.length > 0
  }
  get canRedo() {
    return this.future.length > 0
  }
  get active() {
    return this.canUndo || this.canRedo
  }
  get dirty() {
    return !equal(this.baseline, this.current)
  }

  breakGroup() {
    this.group = undefined
  }
  reset(state: MapDraftState) {
    this.current = structuredClone(state)
    this.baseline = structuredClone(state)
    this.past = []
    this.future = []
    this.group = undefined
    this.bytes = 0
  }
  setBaseline(state: MapDraftState) {
    this.baseline = structuredClone(state)
  }

  record(state: MapDraftState, layer = '', group?: number): boolean {
    let patches = diff(this.current, state)

    if (!patches.length) {
      if (group === undefined) this.breakGroup()

      return false
    }

    for (const entry of this.future) this.bytes -= entry.bytes
    this.future = []

    if (group !== undefined && group === this.group && this.past.length) {
      const previous = this.past.pop()!
      this.bytes -= previous.bytes
      patches = diff(restore(this.current, previous.patches, 'before'), state)
    }

    this.current = structuredClone(state)
    this.group = group

    if (patches.length) {
      const entry = { patches, layer, bytes: JSON.stringify(patches).length * 2 }
      this.past.push(entry)
      this.bytes += entry.bytes
    }

    // Always retain the most recent action, even when a single resize exceeds the budget.
    while (this.past.length > 1 && (this.past.length > this.steps || this.bytes > this.budget))
      this.bytes -= this.past.shift()!.bytes

    return true
  }

  undo() {
    const entry = this.past.pop()

    if (!entry) return undefined
    this.current = restore(this.current, entry.patches, 'before')
    this.future.push(entry)
    this.breakGroup()

    return { state: structuredClone(this.current), layer: entry.layer }
  }
  redo() {
    const entry = this.future.pop()

    if (!entry) return undefined
    this.current = restore(this.current, entry.patches, 'after')
    this.past.push(entry)
    this.breakGroup()

    return { state: structuredClone(this.current), layer: entry.layer }
  }
}
