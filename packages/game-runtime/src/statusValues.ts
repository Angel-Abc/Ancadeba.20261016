import type { StatusValueDefinition } from '@ancadeba/schemas'
import type { IGameBindings } from './gameBindings.js'

export interface StatusValueResolution {
  readonly value: string | number | undefined
  readonly issue?: string
}

/** Numeric displays never coerce missing, text, or boolean values into a resource amount. */
export function resolveStatusValue(
  source: StatusValueDefinition,
  bindings: IGameBindings | undefined,
  numeric = false,
): StatusValueResolution {
  const result =
    typeof source === 'object'
      ? bindings?.read(source)
      : { status: 'resolved' as const, value: source }

  if (!result || result.status !== 'resolved')
    return {
      value: !numeric && typeof source === 'object' ? source.fallback : undefined,
      issue: result?.diagnostic.reason ?? 'source-unavailable',
    }
  const value = result.value

  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    (numeric && typeof value !== 'number') ||
    (typeof value === 'number' && !Number.isFinite(value))
  )
    return {
      value: undefined,
      issue: numeric ? 'Expected a finite number' : 'Expected text or a finite number',
    }

  return { value }
}

export function statusBarFill(current: unknown, maximum: unknown): number | undefined {
  if (
    typeof current !== 'number' ||
    !Number.isFinite(current) ||
    typeof maximum !== 'number' ||
    !Number.isFinite(maximum) ||
    maximum <= 0
  )
    return

  return Math.max(0, Math.min(100, (current / maximum) * 100))
}
