import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import type { GameBindingDefinition, ButtonComponentDefinition } from '@ancadeba/schemas'
import {
  displayLabel,
  parseStatePath,
  placementFields,
  type RuleFormControls,
  statePath,
  translationChoices,
  ruleFormControls,
} from './ruleFormControls.js'
import { inventoryActionsForm } from './inventoryActionsForm.js'
import { nearbyForm } from './nearbyForm.js'

const binding = (path: string): GameBindingDefinition => ({
  source: 'game.state',
  path: parseStatePath(path),
})

export const ruleTriggerSections = ['buttons', 'inspection', 'actions', 'nearby'] as const

export type RuleTriggerSection = (typeof ruleTriggerSections)[number]

function submit(form: HTMLFormElement, title: string, action: () => void) {
  const button = form.ownerDocument.createElement('button')
  button.textContent = title
  button.type = 'submit'
  form.append(button)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    action()
  })
}

function buttonTriggers(
  owner: RuleFormControls,
  view: ProjectView,
  save: (command: EditorCommand) => void,
): HTMLElement {
  const buttons = owner.group('Scene buttons')
  let dirty = false

  const controls = ruleFormControls(buttons.ownerDocument, () => {
    dirty = true
    owner.markEdited()
  })

  const { create, input, select, translation } = controls
  const actions = Object.keys(view.rules?.actions ?? {})

  const enabledFields = (view.rules?.state ?? [])
    .filter(({ value }) => typeof value === 'boolean')
    .map(({ path }) => statePath(path))

  const scenes = view.scenes.filter(({ type }) => type === 'game')
  const noAction = ['', 'No action'] as const
  const error = create('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  buttons.append(error)

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

      const picker = select(
        'Button',
        target,
        [['', 'New button'], ...available.map(({ id }) => id)],
        (next) => {
          if (next === target) return

          if (dirty) {
            picker.querySelector('select')!.value = target
            error.textContent = 'Save or discard the trigger draft before switching buttons.'

            return
          }

          target = next
          error.textContent = ''
          render()
        },
        false,
      )

      form.append(
        picker,
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
        translation(
          'Label translation',
          labelKey,
          translationChoices(view, 'Use literal label'),
          (next) => {
            labelKey = next
          },
        ),
        ...placementFields.map(([key, label]) =>
          input(
            label,
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

    const scenePicker = select(
      'Game scene',
      scene.id,
      scenes.map(({ id }) => id),
      (next) => {
        if (next === scene.id) return

        if (dirty) {
          scenePicker.querySelector('select')!.value = scene.id
          error.textContent = 'Save or discard the trigger draft before switching scenes.'

          return
        }

        scene = scenes.find(({ id }) => id === next)!
        target = ''
        error.textContent = ''
        render()
      },
      false,
    )

    buttons.append(scenePicker, formArea)
    render()
  } else buttons.append('Add a game scene before linking a button.')

  return buttons
}

function inspectionTriggers(
  owner: RuleFormControls,
  view: ProjectView,
  save: (command: EditorCommand) => void,
): HTMLElement {
  const inspection = owner.group('Inventory inspection')
  let dirty = false

  const controls = ruleFormControls(inspection.ownerDocument, () => {
    dirty = true
    owner.markEdited()
  })

  const { create, select } = controls
  const itemTypes = Object.entries(view.inventory?.itemTypes ?? {})
  const actions = Object.keys(view.rules?.actions ?? {})
  const details = (view.rules?.state ?? []).map(({ path }) => statePath(path))

  if (view.rules?.clock) details.push(statePath(view.rules.clock.path))

  if (view.rules?.log) details.push(statePath(view.rules.log.path))
  const noAction = ['', 'No action'] as const
  const error = create('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  inspection.append(error)

  if (itemTypes.length) {
    let itemType = itemTypes[0]![0]
    const formArea = create('div')

    const render = () => {
      const previous = view.inventory!.itemTypes[itemType]?.inspection
      let action = previous?.action ?? ''
      let path = previous?.details.path.join('.') ?? ''
      let inline = previous?.inline !== false
      const form = create('form')
      form.append(
        select('Requested action', action, [noAction, ...actions], (next) => {
          action = next
        }),
        select('Inspection details', path, details, (next) => {
          path = next
        }),
        select(
          'Show inspection in inventory',
          inline ? 'yes' : 'no',
          [
            ['yes', 'Show inline Inspect button and result'],
            ['no', 'Hide inline inspection'],
          ],
          (next) => {
            inline = next === 'yes'
          },
        ),
      )
      form.append(
        'To show results in the main text, have the action set a text state field and bind that field in a text component. Hiding inline inspection keeps the action available to the action bar.',
      )
      submit(form, 'Save inspection', () =>
        save({
          type: 'inventory.setRuleInspection',
          itemType,
          inspection: action ? { action, details: binding(path), inline } : null,
        }),
      )
      formArea.replaceChildren(form)
    }

    const picker = select(
      'Item type',
      itemType,
      itemTypes.map(([id, type]) => [id, displayLabel(view, id, type)] as const),
      (next) => {
        if (next === itemType) return

        if (dirty) {
          picker.querySelector('select')!.value = itemType
          error.textContent = 'Save or discard the trigger draft before switching item types.'

          return
        }

        itemType = next
        error.textContent = ''
        render()
      },
      false,
    )

    inspection.append(picker, formArea)
    render()
  } else inspection.append('Add inventory item types before linking an inspection.')

  return inspection
}

/** Retain dirty sections independently when another trigger form saves or the project refreshes. */
export function ruleTriggerForms(
  controls: RuleFormControls,
  view: ProjectView,
  save: (command: EditorCommand) => void,
  options: {
    controls?: (section: RuleTriggerSection) => RuleFormControls
    retained?: ReadonlyMap<RuleTriggerSection, HTMLElement>
    discarded?: (section: RuleTriggerSection) => void
  } = {},
): HTMLElement[] {
  return ruleTriggerSections.map((section) => {
    const retained = options.retained?.get(section)

    if (retained) return retained
    const scoped = options.controls?.(section) ?? controls

    switch (section) {
      case 'buttons':
        return buttonTriggers(scoped, view, save)
      case 'inspection':
        return inspectionTriggers(scoped, view, save)
      case 'actions':
        return inventoryActionsForm(scoped, view, save, () => options.discarded?.(section))
      case 'nearby':
        return nearbyForm(scoped, view, save, undefined, {
          onDiscard: () => options.discarded?.(section),
        })
    }
  })
}
