import type { ProjectView } from '@ancadeba/editor-core'
import {
  combatStatNames,
  levelingBindingFields,
  type GameBindingDefinition,
  type TextComponentDefinition,
} from '@ancadeba/schemas'
import { resolveText, type IGameBindings } from '@ancadeba/game-runtime'
import { displayLabel } from './ruleFormControls.js'

export interface TextBindingChoice {
  id: string
  label: string
  binding: GameBindingDefinition
  initial?: string | number | boolean
}

export function textBindingId(binding: {
  source: GameBindingDefinition['source']
  path: readonly (string | number)[]
}) {
  return JSON.stringify([binding.source, binding.path])
}

/** Authorable scalar values; gold uses its declared game-state path like any other number. */
export function textBindingChoices(view: ProjectView): TextBindingChoice[] {
  const choice = (
    source: GameBindingDefinition['source'],
    path: (string | number)[],
    label: string,
    initial?: string | number | boolean,
  ): TextBindingChoice => ({
    id: textBindingId({ source, path }),
    binding: { source, path },
    label,
    ...(initial !== undefined ? { initial } : {}),
  })

  return [
    ...(view.rules?.state ?? []).map((field) =>
      choice(
        'game.state',
        field.path,
        `State · ${field.path.join('.')}`,
        typeof field.value === 'object' ? view.translations?.[field.value.textKey] : field.value,
      ),
    ),
    choice('game.progression', ['turn'], 'Game time · Turn', 0),
    choice('game.progression', ['worldTimeMs'], 'Game time · World time (ms)', 0),
    ...Object.entries(view.quests ?? {}).flatMap(([id, quest]) => [
      choice(
        'game.quests',
        [id, 'status'],
        `Quest · ${displayLabel(view, id, quest)} · Status`,
        'not-started',
      ),
      choice(
        'game.quests',
        [id, 'stage'],
        `Quest · ${displayLabel(view, id, quest)} · Current stage`,
        '',
      ),
      choice(
        'game.quests',
        [id, 'tracked'],
        `Quest · ${displayLabel(view, id, quest)} · Tracked`,
        false,
      ),
    ]),
    ...Object.entries(view.leveling ?? {}).flatMap(([id, profile]) =>
      Object.keys(levelingBindingFields).map((field) =>
        choice(
          'game.leveling',
          [id, field],
          `Character · ${displayLabel(view, id, profile)} · ${field}`,
        ),
      ),
    ),
    ...Object.entries(view.inventory?.owners ?? {})
      .filter(([, owner]) => owner.combatStats)
      .flatMap(([id, owner]) =>
        [...combatStatNames, 'health', 'available', 'locked'].map((field) =>
          choice('game.combatStats', [id, field], `Equipment · ${owner.label} · ${field}`),
        ),
      ),
  ]
}

/** A source-definition preview, before quest actions and runtime-derived systems have run. */
export function previewTextBindings(view: ProjectView, draft: TextComponentDefinition) {
  const choices = new Map(textBindingChoices(view).map((choice) => [choice.id, choice]))

  const source: IGameBindings = {
    read(binding) {
      const choice = choices.get(textBindingId(binding))

      if (choice?.initial !== undefined) return { status: 'resolved', value: choice.initial }

      return {
        status: 'unresolved',
        diagnostic: {
          source: binding.source,
          path: [...binding.path],
          reason: 'source-unavailable',
        },
      }
    },
    subscribeChanges: () => () => {},
  }

  const text = draft.textKey ? (view.translations?.[draft.textKey] ?? draft.text) : draft.text

  return resolveText({ text, bindings: draft.bindings }, source)
}
