import {
  combatEffectDeliveries,
  combatInterceptionEffectTypes,
  type CombatScenarioRichAssertion,
  type CombatDefinition,
} from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import type { RuleFormControls } from './ruleFormControls.js'

export function newCombatScenarioAssertion(
  type: CombatScenarioRichAssertion['type'],
  definition: CombatDefinition,
): CombatScenarioRichAssertion {
  if (type === 'cooldown')
    return {
      type,
      actor: definition.player.id,
      move: definition.player.moves[0]!,
      operator: 'eq',
      value: 0,
    }

  if (type === 'trigger-cooldown')
    return {
      type,
      trigger: Object.keys(definition.mechanics?.triggers ?? {})[0] ?? 'trigger',
      operator: 'eq',
      value: 0,
    }

  return { type, operator: 'eq', value: 0 }
}

export function combatScenarioAssertionsForm(
  controls: RuleFormControls,
  entry: CombatScenarioRichAssertion,
  definition: CombatDefinition,
  view: ProjectView,
): HTMLElement[] {
  const { select, input, t } = controls
  const text = (key: string) => t(`combat.scenarios.assertions.${key}`)
  const nodes: HTMLElement[] = []
  const read = (key: string) => Object.getOwnPropertyDescriptor(entry, key)?.value ?? ''

  const write = (key: string, value: string | undefined) => {
    Object.defineProperty(entry, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }

  const optional = (key: string, values?: readonly string[]) =>
    nodes.push(
      values
        ? select(text(key), read(key), [['', text('any')], ...values], (value) => {
            write(key, value || undefined)
          })
        : input(text(key), read(key), (value) => {
            write(key, value.trim() || undefined)
          }),
    )

  const choice = <T extends string>(key: string, values: readonly T[], fallback: T) =>
    nodes.push(
      select(text(key), read(key) || fallback, values, (value) => {
        write(key, value)
      }),
    )

  const actors = [definition.player, ...definition.enemies].map((actor) => actor.id)

  if (entry.type !== 'cooldown' && entry.type !== 'trigger-cooldown')
    choice('scope', ['scenario', 'step'], 'scenario')

  if (entry.type === 'passive-activations' || entry.type === 'trigger-cooldown') {
    optional('actor', actors)
    optional('library', Object.keys(definition.passiveDefinitions ?? {}))
    optional('passive', [
      ...new Set(
        Object.values(definition.passiveDefinitions ?? {}).flatMap((entries) =>
          Object.keys(entries),
        ),
      ),
    ])
    optional('trigger', [
      ...new Set([
        ...Object.keys(definition.mechanics?.triggers ?? {}),
        ...Object.values(definition.passiveDefinitions ?? {}).flatMap((entries) =>
          Object.values(entries).flatMap((passive) => Object.keys(passive.triggers)),
        ),
      ]),
    ])
    optional('sourceKind', ['equipment', 'status'])
    optional('sourceId', [
      ...new Set([
        ...Object.keys(definition.statuses ?? {}),
        ...Object.keys(view.inventory?.items ?? {}),
      ]),
    ])

    if (entry.type === 'trigger-cooldown')
      choice('measure', ['remaining', 'readyRound'], 'remaining')
  } else if (
    entry.type === 'damage-total' ||
    entry.type === 'healing-total' ||
    entry.type === 'interception'
  ) {
    optional('source', actors)
    optional('target', actors)

    if (entry.type === 'interception') {
      optional('operation', combatInterceptionEffectTypes)
      optional('resource', Object.keys(definition.mechanics?.resources ?? {}))
      optional('trigger')
      choice('measure', ['count', 'amount', 'spent'], 'count')
    } else {
      optional('move', Object.keys(definition.moves))
      optional('delivery', combatEffectDeliveries)

      if (entry.type === 'damage-total') {
        optional('damageType')
        choice(
          'measure',
          ['amount', 'count', 'absorbed', 'prevented', 'redirectedAmount'],
          'amount',
        )
      } else choice('measure', ['amount', 'count', 'overheal'], 'amount')
    }
  } else if (entry.type === 'action-choices') {
    optional('actor', actors)
    optional('move', Object.keys(definition.moves))
    optional('target', actors)
    optional('rule', [
      ...new Set(
        definition.enemies.flatMap((actor) => actor.ai?.rules.map((rule) => rule.id) ?? []),
      ),
    ])
    choice('result', ['chosen', 'executed'], 'chosen')
  } else if (entry.type === 'cooldown') {
    nodes.push(
      select(text('actor'), entry.actor, actors, (value) => {
        entry.actor = value
      }),
      select(text('move'), entry.move, Object.keys(definition.moves), (value) => {
        entry.move = value
      }),
    )
    choice('measure', ['remaining', 'readyRound'], 'remaining')
  } else if (entry.type === 'item-consumption') {
    optional('item', Object.keys(view.inventory?.items ?? {}))
    optional('itemType', Object.keys(view.inventory?.itemTypes ?? {}))
  }

  return nodes
}
