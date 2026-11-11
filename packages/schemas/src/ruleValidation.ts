import type { LanguageCatalog } from './languages.js'
import {
  getMapMovementCostMs,
  getMapPotentialMovementCostMs,
  resolveMapObject,
  isBlockingMapObject,
  type MapDefinition,
} from './map.js'
import type { InventoryDefinition } from './inventory.js'
import type { SceneDefinition } from './scene.js'
import { ruleValueType, type GameRulesDefinition, type RuleValue } from './rules.js'
import { sceneTransitionIssues } from './sceneTransition.js'

export interface RuleSource {
  file: string
  rules: GameRulesDefinition
}

export interface RuleIssue {
  file: string
  path: (string | number)[]
  message: string
}

interface MergedRules {
  rules: GameRulesDefinition
  issues: RuleIssue[]
}

export function mergeRuleSources(sources: readonly RuleSource[]): MergedRules {
  const issues: RuleIssue[] = []
  const state: GameRulesDefinition['state'] = []
  const actions = new Map<string, GameRulesDefinition['actions'][string]>()
  const declared = new Set<string>()
  let clock: GameRulesDefinition['clock']
  let log: GameRulesDefinition['log']

  const addPath = (file: string, path: string[], source: RuleIssue['path']) => {
    const key = path.join('.')

    if (
      [...declared].some(
        (other) => key === other || key.startsWith(other + '.') || other.startsWith(key + '.'),
      )
    )
      issues.push({
        file,
        path: source,
        message: 'State paths must be distinct and cannot contain one another',
      })
    declared.add(key)
  }

  for (const { file, rules } of sources) {
    rules.state.forEach((field, index) => {
      addPath(file, field.path, ['state', index, 'path'])
      state.push(field)
    })

    for (const [id, branches] of Object.entries(rules.actions)) {
      if (actions.has(id))
        issues.push({ file, path: ['actions', id], message: `Duplicate rule action: ${id}` })
      else actions.set(id, branches)
    }

    if (rules.clock) {
      addPath(file, rules.clock.path, ['clock', 'path'])

      if (clock)
        issues.push({
          file,
          path: ['clock'],
          message: 'Only one rule file may define the game clock',
        })
      else clock = rules.clock
    }

    if (rules.log) {
      addPath(file, rules.log.path, ['log', 'path'])

      if (log)
        issues.push({
          file,
          path: ['log'],
          message: 'Only one rule file may define the activity log',
        })
      else log = rules.log
    }
  }

  return { rules: { state, actions: Object.fromEntries(actions), clock, log }, issues }
}

export function validateRuleSources(
  sources: readonly RuleSource[],
  scenes: ReadonlyMap<string, SceneDefinition>,
  maps: ReadonlyMap<string, MapDefinition>,
  inventory: InventoryDefinition | undefined,
  translations: LanguageCatalog | undefined,
): MergedRules {
  const merged = mergeRuleSources(sources)

  for (const [id, map] of maps)
    map.objects?.forEach((object, index) => {
      if (!Object.hasOwn(merged.rules.actions, object.action))
        merged.issues.push({
          file: `maps/${id}.json`,
          path: ['objects', index, 'action'],
          message: `Unknown map object action: ${object.action}`,
        })
    })

  for (const [id, scene] of scenes)
    scene.components.forEach((component, index) => {
      const actions =
        component.type === 'button' && component.action
          ? [{ action: component.action, path: ['components', index, 'action'] }]
          : component.type === 'action-bar'
            ? Object.entries(component.slots).map(([slot, value]) => ({
                action: value.action,
                path: ['components', index, 'slots', slot, 'action'],
              }))
            : []

      for (const { action, path } of actions) {
        if (action.type !== 'interact-map' || !action.object) continue
        const view = scene.components.find((component) => component.id === action.mapView)
        const map = view?.type === 'map-view' ? maps.get(view.map) : undefined

        if (!map?.objects?.some((object) => object.id === action.object))
          merged.issues.push({
            file: `scenes/${id}.json`,
            path: [...path, 'object'],
            message: `Unknown map object: ${action.object}`,
          })
      }
    })

  for (const [id, map] of maps)
    map.entryTriggers?.forEach((trigger, index) => {
      if (!Object.hasOwn(merged.rules.actions, trigger.action))
        merged.issues.push({
          file: `maps/${id}.json`,
          path: ['entryTriggers', index, 'action'],
          message: `Unknown tile-entry action: ${trigger.action}`,
        })

      if (getMapPotentialMovementCostMs(map, trigger) === undefined)
        merged.issues.push({
          file: `maps/${id}.json`,
          path: ['entryTriggers', index],
          message: 'Tile-entry triggers require a walkable tile',
        })
    })

  const fields = new Map(
    merged.rules.state.map(({ path, value }) => [path.join('.'), ruleValueType(value)]),
  )

  const initial = (path: readonly string[]) =>
    merged.rules.state.find((field) => JSON.stringify(field.path) === JSON.stringify(path))?.value

  for (const [id, map] of maps)
    map.objects?.forEach((object, index) =>
      object.states?.forEach((state, stateIndex) => {
        if (typeof initial(state.when.path) !== 'boolean')
          merged.issues.push({
            file: `maps/${id}.json`,
            path: ['objects', index, 'states', stateIndex, 'when', 'path'],
            message: 'Object states require an existing boolean Rules state field',
          })
      }),
    )

  for (const [id, scene] of scenes)
    scene.components.forEach((component, index) => {
      if (component.type !== 'map-view' || !component.playerSpawn) return
      const map = maps.get(component.map)

      if (
        map &&
        getMapPotentialMovementCostMs(map, component.playerSpawn) !== undefined &&
        getMapMovementCostMs(map, component.playerSpawn, (object) =>
          isBlockingMapObject(resolveMapObject(object, initial)),
        ) === undefined
      )
        merged.issues.push({
          file: `scenes/${id}.json`,
          path: ['components', index, 'playerSpawn'],
          message: 'Player spawn is blocked by the initial object state',
        })
    })

  for (const { file, rules } of sources) {
    const report = (path: RuleIssue['path'], message: string) =>
      merged.issues.push({ file, path, message })

    const checkText = (value: RuleValue, source: (string | number)[]) => {
      if (
        typeof value === 'object' &&
        (!translations || !Object.hasOwn(translations, value.textKey))
      )
        report([...source, 'textKey'], `Missing default translation: ${value.textKey}`)
    }

    rules.state.forEach(({ value }, index) => checkText(value, ['state', index, 'value']))
    rules.log?.initial.forEach((value, index) => checkText(value, ['log', 'initial', index]))

    const checkField = (path: string[], value: RuleValue, source: (string | number)[]) => {
      const type = fields.get(path.join('.'))

      if (!type) report([...source, 'path'], 'Unknown state field')
      else if (type !== ruleValueType(value))
        report([...source, 'value'], `Expected a ${type} value`)
    }

    for (const [id, branches] of Object.entries(rules.actions)) {
      branches.forEach((branch, index) => {
        const root = ['actions', id, index]
        branch.when.forEach((condition, conditionIndex) => {
          const source = [...root, 'when', conditionIndex]

          if (condition.type === 'state-is') checkField(condition.path, condition.value, source)

          if (
            condition.type === 'payload-is-target' &&
            ![...maps.values()].some((map) =>
              map.objects?.some((object) => object.id === condition.target),
            ) &&
            ![...scenes.values()].some((scene) =>
              scene.components.some(
                (component) =>
                  component.type === 'nearby' && Object.hasOwn(component.entries, condition.target),
              ),
            )
          )
            report([...source, 'target'], 'Unknown nearby target')

          if (condition.type === 'scene-is' && !scenes.has(condition.scene))
            report([...source, 'scene'], 'Unknown scene')

          if (
            'item' in condition &&
            (!inventory || !Object.hasOwn(inventory.items, condition.item))
          )
            report([...source, 'item'], 'Unknown inventory item')

          if (
            'owner' in condition &&
            (!inventory || !Object.hasOwn(inventory.owners, condition.owner))
          )
            report([...source, 'owner'], 'Unknown inventory owner')
        })
        branch.effects.forEach((effect, effectIndex) => {
          const source = [...root, 'effects', effectIndex]

          switch (effect.type) {
            case 'set-state':
              checkField(effect.path, effect.value, source)
              checkText(effect.value, [...source, 'value'])
              break
            case 'move-item':
              if (!inventory || !Object.hasOwn(inventory.items, effect.item))
                report([...source, 'item'], 'Unknown inventory item')

              if (!inventory || !Object.hasOwn(inventory.owners, effect.owner))
                report([...source, 'owner'], 'Unknown inventory owner')
              break
            case 'collect-items':
              effect.items.forEach((item, index) => {
                if (!inventory || !Object.hasOwn(inventory.items, item))
                  report([...source, 'items', index], 'Unknown inventory item')
              })

              if (!inventory || !Object.hasOwn(inventory.owners, effect.owner))
                report([...source, 'owner'], 'Unknown inventory owner')
              break
            case 'enter-scene': {
              const scene = scenes.get(effect.scene)

              if (scene?.type !== 'game')
                report([...source, 'scene'], 'Expected an existing game scene')

              for (const issue of sceneTransitionIssues(effect, scenes, maps))
                report([...source, ...issue.path], issue.message)

              break
            }

            case 'append-log':
              if (!merged.rules.log)
                report(source, 'Configure an activity log before appending entries')
              checkText(effect.text, [...source, 'text'])
              break
          }
        })
      })
    }
  }

  return merged
}
