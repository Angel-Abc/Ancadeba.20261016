import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import type { GameBindingDefinition, ButtonComponentDefinition } from '@ancadeba/schemas'
import { parseStatePath, statePath, type RuleFormControls } from './ruleFormControls.js'

const binding = (path: string): GameBindingDefinition => ({
  source: 'game.state',
  path: parseStatePath(path),
})

export function ruleTriggerForms(
  controls: RuleFormControls,
  view: ProjectView,
  save: (command: EditorCommand) => void,
): HTMLElement[] {
  const { create, input, select, group } = controls
  const rules = view.rules
  const actions = Object.keys(rules?.actions ?? {})
  const state = rules?.state ?? []
  const details = state.map(({ path }) => statePath(path))

  if (rules?.clock) details.push(statePath(rules.clock.path))

  if (rules?.log) details.push(statePath(rules.log.path))

  const enabledFields = state
    .filter(({ value }) => typeof value === 'boolean')
    .map(({ path }) => statePath(path))

  const scenes = view.scenes.filter(({ type }) => type === 'game')
  const itemTypes = Object.entries(view.inventory?.itemTypes ?? {})
  const noAction = ['', 'No action'] as const

  const submit = (form: HTMLFormElement, title: string, action: () => void) => {
    const button = create('button')
    button.textContent = title
    button.type = 'submit'
    form.append(button)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      action()
    })
  }

  const buttons = group('Scene buttons')

  if (scenes.length) {
    let scene = scenes[0]!
    let target = ''
    const formArea = create('div')

    const render = () => {
      const available = scene.components.filter(
        (component): component is ButtonComponentDefinition =>
          component.type === 'button' &&
          (!component.action || component.action.type === 'request-action'),
      )

      const current = available.find(({ id }) => id === target)
      let id = current?.id ?? ''
      let label = current?.label ?? ''
      let labelKey = current?.labelKey ?? ''
      let action = current?.action?.type === 'request-action' ? current.action.action : ''

      let enabled =
        current?.action?.type === 'request-action'
          ? (current.action.enabledWhen?.path.join('.') ?? '')
          : ''

      const placement = current
        ? { ...current.placement }
        : { row: 1, column: 1, rowSpan: 1, columnSpan: 1 }

      const form = create('form')
      form.append(
        select(
          'Button',
          target,
          [['', 'New button'], ...available.map(({ id }) => id)],
          (next) => {
            target = next
            render()
          },
          false,
        ),
        ...(current
          ? []
          : [
              input('Button ID', id, (next) => {
                id = next.trim()
              }),
            ]),
        input('Label', label, (next) => {
          label = next
        }),
        select(
          'Label translation',
          labelKey,
          [['', 'Use literal label'], ...(view.translationKeys ?? [])],
          (next) => {
            labelKey = next
          },
        ),
        ...(['row', 'column', 'rowSpan', 'columnSpan'] as const).map((key) =>
          input(
            { row: 'Row', column: 'Column', rowSpan: 'Row span', columnSpan: 'Column span' }[key],
            String(placement[key]),
            (next) => {
              placement[key] = Number(next)
            },
            'number',
          ),
        ),
        select('Requested action', action, [noAction, ...actions], (next) => {
          action = next
        }),
        select('Enable when true', enabled, [['', 'Always'], ...enabledFields], (next) => {
          enabled = next
        }),
      )
      submit(form, 'Save button', () =>
        save({
          type: 'scene.upsertRuleButton',
          sceneId: scene.id,
          component: {
            id,
            type: 'button',
            label,
            placement,
            ...(labelKey ? { labelKey } : {}),
            ...(action
              ? {
                  action: {
                    type: 'request-action',
                    action,
                    ...(enabled ? { enabledWhen: binding(enabled) } : {}),
                  },
                }
              : {}),
          },
        }),
      )
      formArea.replaceChildren(form)
    }

    buttons.append(
      select(
        'Game scene',
        scene.id,
        scenes.map(({ id }) => id),
        (next) => {
          scene = scenes.find(({ id }) => id === next)!
          target = ''
          render()
        },
        false,
      ),
      formArea,
    )
    render()
  } else buttons.append('Add a game scene before linking a button.')

  const inspection = group('Inventory inspection')

  if (itemTypes.length) {
    let itemType = itemTypes[0]![0]
    const formArea = create('div')

    const render = () => {
      const previous = view.inventory!.itemTypes[itemType]?.inspection
      let action = previous?.action ?? ''
      let path = previous?.details.path.join('.') ?? ''
      const form = create('form')
      form.append(
        select('Requested action', action, [noAction, ...actions], (next) => {
          action = next
        }),
        select('Inspection details', path, details, (next) => {
          path = next
        }),
      )
      submit(form, 'Save inspection', () =>
        save({
          type: 'inventory.setRuleInspection',
          itemType,
          inspection: action ? { action, details: binding(path) } : null,
        }),
      )
      formArea.replaceChildren(form)
    }

    inspection.append(
      select(
        'Item type',
        itemType,
        itemTypes.map(([id, { label }]) => [id, label] as const),
        (next) => {
          itemType = next
          render()
        },
        false,
      ),
      formArea,
    )
    render()
  } else inspection.append('Add inventory item types before linking an inspection.')

  return [buttons, inspection]
}
