import type { CombatEffectEventData, CombatPassiveSource } from '@ancadeba/schemas'
import type { CombatInterceptionChange } from './combatInterception.js'

export type CombatObservation =
  | { kind: 'passive-activations'; passive: CombatPassiveSource; trigger: string }
  | {
      kind: 'interception'
      source: string
      target: string
      trigger?: string | undefined
      change: CombatInterceptionChange
    }
  | {
      kind: 'damage-total' | 'healing-total'
      effect: CombatEffectEventData
      move?: string | undefined
    }
  | {
      kind: 'action-choices'
      actor: string
      move: string
      target: string
      result: 'chosen' | 'executed'
      rule?: string | undefined
    }
  | { kind: 'item-use'; item: string; itemType: string; consumed: boolean }

export type CombatObservationSink = (observation: CombatObservation) => void

export interface CombatMetricFilters {
  actor?: string | undefined
  source?: string | undefined
  target?: string | undefined
  move?: string | undefined
  library?: string | undefined
  passive?: string | undefined
  trigger?: string | undefined
  sourceKind?: string | undefined
  sourceId?: string | undefined
  operation?: string | undefined
  resource?: string | undefined
  delivery?: string | undefined
  damageType?: string | undefined
  result?: string | undefined
  rule?: string | undefined
  item?: string | undefined
  itemType?: string | undefined
  consumed?: boolean | undefined
}

export interface CombatMetricValues {
  count: number
  amount?: number | undefined
  spent?: number | undefined
  absorbed?: number | undefined
  prevented?: number | undefined
  redirectedAmount?: number | undefined
  overheal?: number | undefined
}

export interface CombatSimulationMetric {
  readonly kind: CombatObservation['kind']
  readonly filters: Readonly<CombatMetricFilters>
  readonly values: Readonly<CombatMetricValues>
}

function sum(left: number, right: number): number {
  const result = left + right

  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError('Combat metric overflow')

  return result
}

/** Bounded aggregate facts, independent of trace/log retention and committed only with a valid round. */
export class CombatMetricCollector {
  private readonly records = new Map<string, CombatSimulationMetric>()
  constructor(previous: readonly CombatSimulationMetric[] = []) {
    for (const entry of previous) this.records.set(this.key(entry), entry)
  }
  private key(entry: CombatSimulationMetric): string {
    return JSON.stringify([
      entry.kind,
      Object.entries(entry.filters).sort(([a], [b]) => a.localeCompare(b)),
    ])
  }
  record(observation: CombatObservation): void {
    let filters: CombatMetricFilters = {},
      values: CombatMetricValues = { count: 1 }

    if (observation.kind === 'passive-activations') {
      const source = observation.passive
      filters = {
        actor: source.actor,
        library: source.library,
        passive: source.passive,
        trigger: observation.trigger,
        sourceKind: source.kind,
        sourceId: source.id,
      }
    } else if (observation.kind === 'interception') {
      filters = {
        source: observation.source,
        target: observation.target,
        operation: observation.change.type,
        ...(observation.trigger ? { trigger: observation.trigger } : {}),
        ...(observation.change.resource ? { resource: observation.change.resource } : {}),
      }
      values = {
        count: 1,
        amount: Math.abs(observation.change.before - observation.change.after),
        spent: observation.change.spent ?? 0,
      }
    } else if (observation.kind === 'damage-total' || observation.kind === 'healing-total') {
      const data = observation.effect
      filters = {
        source: data.source,
        target: data.target,
        delivery: data.delivery,
        ...(data.damageType ? { damageType: data.damageType } : {}),
        ...(observation.move ? { move: observation.move } : {}),
      }
      values = {
        count: 1,
        amount: data.amount,
        absorbed: data.absorbed ?? 0,
        prevented: data.prevented ?? 0,
        redirectedAmount: data.redirectedAmount ?? 0,
        overheal: data.overheal ?? 0,
      }
    } else if (observation.kind === 'action-choices') {
      filters = {
        actor: observation.actor,
        move: observation.move,
        target: observation.target,
        result: observation.result,
        ...(observation.rule ? { rule: observation.rule } : {}),
      }
    } else if (observation.kind === 'item-use')
      filters = {
        item: observation.item,
        itemType: observation.itemType,
        consumed: observation.consumed,
      }
    const entry = { kind: observation.kind, filters, values }

    const key = this.key(entry),
      previous = this.records.get(key)

    if (!previous && this.records.size >= 100000)
      throw new Error('Combat metric record limit exceeded')
    const next = { ...values }

    for (const name of [
      'count',
      'amount',
      'spent',
      'absorbed',
      'prevented',
      'redirectedAmount',
      'overheal',
    ] as const) {
      const value = values[name]

      if (value !== undefined) next[name] = sum(previous?.values[name] ?? 0, value)
    }

    this.records.set(key, { ...entry, values: next })
  }
  snapshot(): CombatSimulationMetric[] {
    return [...this.records.values()].map((entry) => ({
      ...entry,
      filters: { ...entry.filters },
      values: { ...entry.values },
    }))
  }
}

export function combatMetricTotal(
  records: readonly CombatSimulationMetric[],
  kind: CombatSimulationMetric['kind'],
  filters: Readonly<CombatMetricFilters>,
  measure: keyof CombatMetricValues,
): number {
  return records
    .filter(
      (entry) =>
        entry.kind === kind &&
        Object.entries(filters).every(
          ([key, value]) =>
            value === undefined ||
            Object.getOwnPropertyDescriptor(entry.filters, key)?.value === value,
        ),
    )
    .reduce((total, entry) => sum(total, entry.values[measure] ?? 0), 0)
}
