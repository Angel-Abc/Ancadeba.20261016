import { combatStatusApplicationIssues, type CombatStatusDefinition } from '@ancadeba/schemas'
import type { ActiveCombatStatus } from './combatEffects.js'

export interface StatusApplication {
  readonly duration?: number | undefined
  readonly stacks?: number | undefined
  readonly intensity?: number | undefined
}

export function validateActiveCombatStatus(
  status: CombatStatusDefinition,
  active: ActiveCombatStatus,
): void {
  if (
    !Number.isSafeInteger(active.remaining) ||
    active.remaining < 1 ||
    active.remaining > status.duration ||
    !Number.isInteger(active.stacks ?? 1) ||
    (active.stacks ?? 1) < 1 ||
    (active.stacks ?? 1) > (status.stacking?.maximum ?? 1) ||
    !Number.isInteger(active.intensity ?? 1) ||
    (active.intensity ?? 1) < 1 ||
    (active.intensity ?? 1) > (status.intensity?.maximum ?? 1)
  )
    throw new Error('Invalid saved combat status strength or duration')
}

/** One aggregate entry per status ID; stacks share its duration and intensity. */
export function applyCombatStatus(
  status: CombatStatusDefinition,
  id: string,
  source: string,
  previous: ActiveCombatStatus | undefined,
  application: StatusApplication = {},
) {
  if (
    combatStatusApplicationIssues({ type: 'apply-status', ...application }, status).length ||
    !Number.isInteger(application.stacks ?? 1) ||
    (application.stacks ?? 1) < 1 ||
    !Number.isInteger(application.intensity ?? 1) ||
    (application.intensity ?? 1) < 1
  )
    throw new Error('Invalid status application strength')

  const stacks = Math.min(
    status.stacking?.maximum ?? 1,
    (previous?.stacks ?? (previous ? 1 : 0)) + (application.stacks ?? 1),
  )

  const incoming = application.intensity ?? status.intensity?.initial ?? 1
  const oldIntensity = previous?.intensity ?? 1
  const mode = status.intensity?.reapply ?? 'replace'

  const intensity = Math.min(
    status.intensity?.maximum ?? 1,
    previous
      ? mode === 'add'
        ? oldIntensity + incoming
        : mode === 'maximum'
          ? Math.max(oldIntensity, incoming)
          : incoming
      : incoming,
  )

  const durationReset = !previous || status.stacking?.duration !== 'preserve'

  const next: ActiveCombatStatus = {
    id,
    source,
    remaining: durationReset
      ? Math.min(status.duration, application.duration ?? status.duration)
      : previous.remaining,
    ...(status.stacking ? { stacks } : {}),
    ...(status.intensity ? { intensity } : {}),
  }

  const changed =
    !previous ||
    durationReset ||
    previous.source !== source ||
    previous.remaining !== next.remaining ||
    (previous.stacks ?? 1) !== stacks ||
    (previous.intensity ?? 1) !== intensity

  return {
    active: changed ? next : (previous ?? next),
    changed,
    durationReset: changed && durationReset,
  }
}

export function removeCombatStatusStacks(
  previous: ActiveCombatStatus,
  stacks?: number,
): ActiveCombatStatus | undefined {
  if (stacks !== undefined && (!Number.isInteger(stacks) || stacks < 1 || stacks > 100))
    throw new Error('Invalid removed stack count')

  if (stacks === undefined || stacks >= (previous.stacks ?? 1)) return

  return { ...previous, stacks: (previous.stacks ?? 1) - stacks }
}
