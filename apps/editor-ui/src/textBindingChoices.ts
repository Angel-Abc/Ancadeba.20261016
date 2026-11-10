import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import type { ProjectView } from '@ancadeba/editor-core'
import {
  combatStatNames,
  levelingBindingFields,
  type GameBindingDefinition,
  type TextComponentDefinition,
} from '@ancadeba/schemas'
import { resolveText, type IGameBindings } from '@ancadeba/game-runtime'
import { displayLabel, humanizeCode } from './ruleFormControls.js'

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

const valueNames = new Map<string, string>([
  ['xp', 'bindings.field.xp'],
  ['maximumLevel', 'bindings.field.maximumLevel'],
  ['nextLevelXp', 'bindings.field.nextLevelXp'],
  ['xpIntoLevel', 'bindings.field.xpIntoLevel'],
  ['xpToNextLevel', 'bindings.field.xpToNextLevel'],
  ['capped', 'bindings.field.capped'],
  ['maximumHealth', 'form.maxHealth'],
])

/** A readable name for a leveling field or combat stat, such as `xpToNextLevel`. */
export function bindingFieldLabel(field: string, t: Translate = editorLocalization().t): string {
  const key = valueNames.get(field)

  return key ? t(key) : humanizeCode(field)
}

/** A combat stat owner's name; the ID is added when another owner shares that name. */
export function combatOwnerLabel(view: ProjectView, id: string): string {
  const owners = Object.entries(view.inventory?.owners ?? {}).filter(
    ([, owner]) => owner.combatStats,
  )

  const name = (ownerId: string, owner: { label?: string; labelKey?: string | undefined }) =>
    displayLabel(view, ownerId, owner)

  const owner = view.inventory?.owners[id]
  const label = owner ? name(id, owner) : id
  const shared = owners.some(([other, entry]) => other !== id && name(other, entry) === label)

  return shared && label !== id ? `${label} (${id})` : label
}

/** Authorable scalar values; gold uses its declared game-state path like any other number. */
export function textBindingChoices(
  view: ProjectView,
  t: Translate = editorLocalization().t,
): TextBindingChoice[] {
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
        t('bindings.state', { path: field.path.join('.') }),
        typeof field.value === 'object' ? view.translations?.[field.value.textKey] : field.value,
      ),
    ),
    choice('game.progression', ['turn'], t('bindings.timeTurn'), 0),
    choice('game.progression', ['worldTimeMs'], t('bindings.timeWorld'), 0),
    ...Object.entries(view.quests ?? {}).flatMap(([id, quest]) => [
      choice(
        'game.quests',
        [id, 'status'],
        t('bindings.questStatus', { quest: displayLabel(view, id, quest) }),
        'not-started',
      ),
      choice(
        'game.quests',
        [id, 'stage'],
        t('bindings.questStage', { quest: displayLabel(view, id, quest) }),
        '',
      ),
      choice(
        'game.quests',
        [id, 'tracked'],
        t('bindings.questTracked', { quest: displayLabel(view, id, quest) }),
        false,
      ),
    ]),
    ...Object.entries(view.leveling ?? {}).flatMap(([id, profile]) =>
      Object.keys(levelingBindingFields).map((field) =>
        choice(
          'game.leveling',
          [id, field],
          t('bindings.character', {
            profile: displayLabel(view, id, profile),
            field: bindingFieldLabel(field, t),
          }),
        ),
      ),
    ),
    ...Object.entries(view.inventory?.owners ?? {})
      .filter(([, owner]) => owner.combatStats)
      .flatMap(([id]) =>
        [...combatStatNames, 'health', 'available', 'locked'].map((field) =>
          choice(
            'game.combatStats',
            [id, field],
            t('bindings.combatStat', {
              owner: combatOwnerLabel(view, id),
              field: bindingFieldLabel(field, t),
            }),
          ),
        ),
      ),
  ]
}

/** A source-definition preview, before quest actions and runtime-derived systems have run. */
export function startingGameBindings(view: ProjectView): IGameBindings {
  const choices = new Map(textBindingChoices(view).map((choice) => [choice.id, choice]))

  return {
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
}

export function previewTextBindings(view: ProjectView, draft: TextComponentDefinition) {
  const text = draft.textKey ? (view.translations?.[draft.textKey] ?? draft.text) : draft.text

  return resolveText({ text, bindings: draft.bindings }, startingGameBindings(view))
}
