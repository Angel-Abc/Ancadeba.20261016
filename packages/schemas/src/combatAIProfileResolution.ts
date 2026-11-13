import type { CombatActorSource, CombatLibrary } from './combatLibraries.js'
import { applyCombatAIOverrides, bindCombatAIProfile } from './combatAIProfiles.js'

export function resolveCombatEnemyAI(
  enemy: CombatActorSource,
  actors: readonly { id: string }[],
  libraries: ReadonlyMap<string, CombatLibrary>,
) {
  const reference = enemy.aiProfile
  const issues: { path: (string | number)[]; message: string }[] = []

  if (!reference) return { ai: enemy.ai, base: undefined, issues }
  const profile = libraries.get(reference.library)?.aiProfiles?.[reference.id]

  if (!profile) {
    issues.push({
      path: ['aiProfile'],
      message: `Missing enemy AI profile: ${reference.library}/${reference.id}`,
    })

    return { ai: undefined, base: undefined, issues }
  }

  for (const role of profile.actors)
    if (!actors.some((actor) => actor.id === (reference.actors?.[role] ?? role)))
      issues.push({
        path: ['aiProfile', 'actors', role],
        message: `Bind AI actor role ${role} to an encounter actor`,
      })

  for (const role of Object.keys(reference.actors ?? {}))
    if (!profile.actors.includes(role))
      issues.push({
        path: ['aiProfile', 'actors', role],
        message: `Unknown AI actor role: ${role}`,
      })

  const base = bindCombatAIProfile(profile, enemy.id, reference.actors)

  try {
    return { ai: applyCombatAIOverrides(base, enemy.aiOverrides), base, issues }
  } catch (error) {
    issues.push({
      path: ['aiOverrides'],
      message: error instanceof Error ? error.message : String(error),
    })

    return { ai: undefined, base, issues }
  }
}
