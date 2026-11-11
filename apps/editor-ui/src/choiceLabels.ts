import type { ProjectView } from '@ancadeba/editor-core'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import { sceneTreeLabel } from './projectTree.js'
import { displayLabel, humanizeCode } from './ruleFormControls.js'

/** Pairs stored codes with readable labels, falling back to a sentence-case form of the code. */
export function labelled<T extends string>(
  codes: readonly T[],
  labels: ReadonlyMap<string, string>,
  t: Translate = editorLocalization().t,
): (readonly [T, string])[] {
  return codes.map((code) => {
    const key = labels.get(code)

    return [code, key ? t(key) : humanizeCode(code)] as const
  })
}

/** Label maps below hold editor message keys, so pickers follow the editor language. */

export const conditionTypeLabels = new Map<string, string>([
  ['scene-is', 'choices.sceneIs'],
  ['state-is', 'choices.stateIs'],
  ['state-compare', 'choices.stateCompare'],
  ['quest-state', 'form.questStatus'],
  ['combat-outcome', 'choices.combatOutcome'],
  ['item-owned-by', 'choices.itemOwnedBy'],
  ['item-carried-by', 'choices.itemCarriedBy'],
  ['payload-is-item', 'choices.payloadIsItem'],
  ['payload-is-target', 'choices.payloadIsTarget'],
])

export const effectTypeLabels = new Map<string, string>([
  ['set-state', 'choices.setState'],
  ['move-item', 'choices.moveItem'],
  ['collect-items', 'choices.collectItems'],
  ['enter-scene', 'choices.enterGameScene'],
  ['append-log', 'choices.appendLog'],
  ['start-quest', 'choices.startQuest'],
  ['complete-quest', 'choices.completeQuest'],
])

export const comparisonLabels = new Map<string, string>([
  ['eq', 'choices.eq'],
  ['gte', 'choices.gte'],
  ['lte', 'choices.lte'],
  ['gt', 'choices.gt'],
  ['lt', 'choices.lt'],
])

export const questStatusLabels = new Map<string, string>([
  ['not-started', 'choices.notStarted'],
  ['active', 'choices.active'],
  ['ready', 'choices.ready'],
  ['completed', 'choices.completed'],
])

export const combatOutcomeLabels = new Map<string, string>([
  ['victory', 'choices.victory'],
  ['defeat', 'choices.defeat'],
  ['escaped', 'choices.escaped'],
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
