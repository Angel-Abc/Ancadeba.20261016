import {
  gameBindingSchema,
  gameRulesSchema,
  inventoryFile,
  ruleFile,
  mergeRuleSources,
  type GameDefinition,
  type GameRulesDefinition,
  type GameBindingDefinition,
  ruleValueType,
  statusPanelBindings,
  statusPanelComponentSchema,
} from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object, projectRuleSources } from './project.js'

type RuleCommand = Extract<
  EditorCommand,
  {
    type:
      | 'game.updateRules'
      | 'scene.upsertRuleButton'
      | 'inventory.setRuleInspection'
      | 'inventory.setItemActions'
  }
>

function checkBinding(
  rules: GameRulesDefinition,
  binding: GameBindingDefinition,
  booleanOnly: boolean,
): void {
  const matches = (path: string[]) =>
    path.length === binding.path.length &&
    path.every((segment, index) => segment === binding.path[index])

  const field = rules.state.find(({ path }) => matches(path))

  const derived =
    (rules.log && matches(rules.log.path)) || (rules.clock && matches(rules.clock.path))

  if (
    binding.source !== 'game.state' ||
    (booleanOnly ? !field || ruleValueType(field.value) !== 'boolean' : !field && !derived)
  )
    throw new EditorError(
      422,
      'invalid_rule_binding',
      booleanOnly ? 'Select a boolean rule state field' : 'Select an existing rule state field',
    )
}

export function editRules(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: RuleCommand,
): string[] {
  const inventories = (game.inventory ?? []).map((id) => {
    const file = inventoryFile(id)
    const inventory = object(documents[file])

    return { file, inventory, itemTypes: object(inventory.itemTypes) }
  })

  const sceneComponents = (file: string): unknown[] => {
    const components = object(documents[file]).components

    return Array.isArray(components) ? components : []
  }

  const sources = projectRuleSources(game.rules, (file) => gameRulesSchema.parse(documents[file]))
  const { rules } = mergeRuleSources(sources)

  if (command.type === 'game.updateRules') {
    const { ruleId } = command
    const file = ruleFile(ruleId)
    const otherSources = sources.filter((source) => source.id !== ruleId)

    const next = mergeRuleSources([...otherSources, { file, rules: command.rules }]).rules

    const checkLink = (action: unknown, binding: unknown, booleanOnly: boolean) => {
      if (typeof action !== 'string' || !Object.hasOwn(rules.actions, action)) return

      if (!Object.hasOwn(next.actions, action))
        throw new EditorError(422, 'rule_in_use', `Unlink action "${action}" before deleting it`)

      if (binding) checkBinding(next, gameBindingSchema.parse(binding), booleanOnly)
    }

    for (const id of game.maps ?? []) {
      const triggers = object(documents[`maps/${id}.json`]).entryTriggers

      if (Array.isArray(triggers))
        for (const trigger of triggers) checkLink(object(trigger).action, undefined, false)
      const objects = object(documents[`maps/${id}.json`]).objects

      if (Array.isArray(objects))
        for (const entry of objects) checkLink(object(entry).action, undefined, false)
    }

    for (const id of game.scenes) {
      for (const component of sceneComponents(`scenes/${id}.json`)) {
        const button = object(component)
        const action = object(button.action)

        if (button.type === 'status-panel')
          for (const { binding, expected } of statusPanelBindings(
            statusPanelComponentSchema.parse(button),
          )) {
            if (binding.source !== 'game.state') continue

            const matches = (path: string[]) =>
              path.length === binding.path.length &&
              path.every((part, index) => part === binding.path[index])

            const declared = rules.state.find((field) => matches(field.path))

            const oldDerived =
              (rules.clock && matches(rules.clock.path)) || (rules.log && matches(rules.log.path))

            if (!declared && !oldDerived) continue
            const field = next.state.find((field) => matches(field.path))

            const nextDerived =
              (next.clock && matches(next.clock.path)) || (next.log && matches(next.log.path))

            const type = field ? ruleValueType(field.value) : nextDerived ? 'string' : undefined

            if (!type || (expected === 'value' ? type === 'boolean' : type !== expected))
              throw new EditorError(
                422,
                'status_binding_in_use',
                'Update status panel bindings before removing or changing their state fields',
              )
          }

        if (button.type === 'nearby')
          for (const value of Object.values(object(button.entries))) {
            const entry = object(value)

            if (entry.visibleWhen)
              checkBinding(next, gameBindingSchema.parse(entry.visibleWhen), true)

            for (const value of Object.values(object(entry.actions))) {
              const action = object(value)
              checkLink(action.action, action.enabledWhen, true)
            }
          }

        if (button.type === 'button' && action.type === 'request-action')
          checkLink(action.action, action.enabledWhen, true)

        if (button.type === 'action-bar')
          for (const slot of Object.values(object(button.slots))) {
            const slotAction = object(object(slot).action)

            if (slotAction.type === 'request-action')
              checkLink(slotAction.action, slotAction.enabledWhen, true)
          }
      }
    }

    for (const { itemTypes } of inventories) {
      for (const itemType of Object.values(itemTypes)) {
        const properties = object(itemType).properties

        for (const property of Array.isArray(properties) ? properties : []) {
          const value = object(property).value

          if (!value || typeof value !== 'object') continue
          const binding = gameBindingSchema.parse(value)

          if (binding.source !== 'game.state') continue

          const matches = (path: string[]) =>
            path.length === binding.path.length &&
            path.every((part, index) => part === binding.path[index])

          if (
            !rules.state.some((field) => matches(field.path)) &&
            !(rules.clock && matches(rules.clock.path)) &&
            !(rules.log && matches(rules.log.path))
          )
            continue
          checkBinding(next, binding, false)
          const field = next.state.find((field) => matches(field.path))

          if (field && ruleValueType(field.value) === 'boolean')
            throw new EditorError(
              422,
              'item_binding_in_use',
              'Item properties require text or numeric state fields',
            )
        }

        const inspection = object(object(itemType).inspection)
        checkLink(inspection.action, inspection.details, false)

        for (const entry of Object.values(object(object(itemType).actions))) {
          const action = object(entry)
          checkLink(action.action, action.enabledWhen, true)
        }
      }
    }

    documents[file] = command.rules

    const ids = game.rules ?? []

    if (ids.includes(ruleId)) return [file]

    documents['game.json'] = {
      ...object(documents['game.json']),
      rules: [...ids, ruleId],
    }

    return [file, 'game.json']
  }

  const requireAction = (id: string): GameRulesDefinition => {
    if (!Object.hasOwn(rules.actions, id))
      throw new EditorError(422, 'unknown_rule_action', `Unknown rule action "${id}"`)

    return rules
  }

  if (
    command.type === 'inventory.setRuleInspection' ||
    command.type === 'inventory.setItemActions'
  ) {
    const source = inventories.find(({ itemTypes }) => Object.hasOwn(itemTypes, command.itemType))

    if (!source)
      throw new EditorError(404, 'item_type_not_found', 'Inventory item type does not exist')
    const { file, inventory, itemTypes } = source
    const { inspection: previous, ...itemType } = object(itemTypes[command.itemType])

    if (command.type === 'inventory.setItemActions') {
      for (const action of Object.values(command.actions)) {
        requireAction(action.action)

        if (action.enabledWhen) checkBinding(rules, action.enabledWhen, true)
      }

      const previousActions = object(itemType.actions)
      itemType.actions = {
        ...Object.fromEntries(
          Object.entries(command.actions).map(([id, action]) => [
            id,
            {
              ...object(previousActions[id]),
              ...action,
              enabledWhen: action.enabledWhen,
            },
          ]),
        ),
      }

      // Item-action edits retain the separately authored inspection definition.
      if (previous) itemType.inspection = previous
    } else if (command.inspection) {
      const { action, details } = command.inspection
      checkBinding(requireAction(action), details, false)
      itemType.inspection = { ...object(previous), ...command.inspection }
    }

    documents[file] = {
      ...inventory,
      itemTypes: { ...itemTypes, [command.itemType]: itemType },
    }

    return [file]
  }

  const file = `scenes/${command.sceneId}.json`
  const scene = object(documents[file])

  if (!game.scenes.includes(command.sceneId) || scene.type !== 'game')
    throw new EditorError(422, 'invalid_rule_scene', 'Select an existing game scene')
  const components = sceneComponents(file)
  const button = command.component
  const index = components.findIndex((component) => object(component).id === button.id)
  const previous = object(components[index])
  const previousAction = object(previous.action)

  if (
    index >= 0 &&
    (previous.type !== 'button' || (previous.action && previousAction.type !== 'request-action'))
  )
    throw new EditorError(
      409,
      'component_exists',
      'This ID belongs to a different component or navigation button',
    )

  if (button.action) {
    const { action, enabledWhen } = button.action
    const definition = requireAction(action)

    if (enabledWhen) checkBinding(definition, enabledWhen, true)
  }

  const { action: _action, labelKey: _labelKey, ...existing } = previous

  const next = {
    ...existing,
    ...button,
    placement: { ...object(previous.placement), ...button.placement },
  }

  if (index < 0) documents[file] = { ...scene, components: [...components, next] }
  else
    documents[file] = {
      ...scene,
      components: components.map((component, position) => (position === index ? next : component)),
    }

  return [file]
}
