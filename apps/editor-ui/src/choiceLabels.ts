import type { ProjectView } from '@ancadeba/editor-core'
import { sceneTreeLabel } from './projectTree.js'
import { displayLabel, humanizeCode } from './ruleFormControls.js'

/** Pairs stored codes with readable labels, falling back to a sentence-case form of the code. */
export function labelled<T extends string>(
  codes: readonly T[],
  labels: ReadonlyMap<string, string>,
): (readonly [T, string])[] {
  return codes.map((code) => [code, labels.get(code) ?? humanizeCode(code)] as const)
}

export const conditionTypeLabels = new Map<string, string>([
  ['scene-is', 'Active scene'],
  ['state-is', 'State equals'],
  ['state-compare', 'Compare numeric state'],
  ['quest-state', 'Quest status'],
  ['combat-outcome', 'Recorded combat outcome'],
  ['item-owned-by', 'Item owned, including containers'],
  ['item-carried-by', 'Item carried by owner'],
  ['payload-is-item', 'Request is for item'],
  ['payload-is-target', 'Request is for nearby target'],
])

export const effectTypeLabels = new Map<string, string>([
  ['set-state', 'Set state'],
  ['move-item', 'Move carried item'],
  ['enter-scene', 'Enter game scene'],
  ['append-log', 'Append to activity log'],
  ['start-quest', 'Start quest'],
  ['complete-quest', 'Complete ready quest'],
])

export const comparisonLabels = new Map<string, string>([
  ['eq', 'Equal to'],
  ['gte', 'At least'],
  ['lte', 'At most'],
  ['gt', 'More than'],
  ['lt', 'Less than'],
])

export const questStatusLabels = new Map<string, string>([
  ['not-started', 'Not started'],
  ['active', 'Active'],
  ['ready', 'Ready to hand in'],
  ['completed', 'Completed'],
])

export const combatOutcomeLabels = new Map<string, string>([
  ['victory', 'Victory'],
  ['defeat', 'Defeat'],
  ['escaped', 'Escaped'],
])

/** Scene picker choices showing explorer names, optionally limited to one scene type. */
export function sceneChoices(
  view: ProjectView,
  type?: ProjectView['scenes'][number]['type'],
): (readonly [string, string])[] {
  return view.scenes
    .filter((scene) => !type || scene.type === type)
    .map((scene) => [scene.id, sceneTreeLabel(view, scene)] as const)
}

/** Quest picker choices showing each quest's name. */
export function questChoices(view: ProjectView): (readonly [string, string])[] {
  return Object.entries(view.quests ?? {}).map(
    ([id, quest]) => [id, displayLabel(view, id, quest)] as const,
  )
}
