import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import { gameBindingSchema, type GameBindingDefinition } from '@ancadeba/schemas'
import { statePath, type RuleFormControls } from './ruleFormControls.js'

/** Item action IDs are resolved by reserved inventory slots in the scene's bar. */
export function inventoryActionsForm(
  controls: RuleFormControls,
  view: ProjectView,
  save: (command: EditorCommand) => void,
): HTMLElement {
  const { create, select, input, button, group } = controls
  const root = group('Selected-item actions')
  const types = Object.entries(view.inventory?.itemTypes ?? {})

  if (!types.length) {
    root.append('Add inventory item types before configuring their actions.')

    return root
  }

  let selected = types[0]![0]
  let dirty = false
  const area = create('div')
  const error = create('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  let rows: { id: string; action: string; enabledWhen?: GameBindingDefinition | undefined }[] = []
  const actions = Object.keys(view.rules?.actions ?? {})

  const conditions = (view.rules?.state ?? [])
    .filter(({ value }) => typeof value === 'boolean')
    .map(({ path }) => [JSON.stringify({ source: 'game.state', path }), statePath(path)] as const)

  const render = () => {
    const form = create('form')
    form.append(
      ...rows.map((row, index) => {
        const field = group(`Item action ${index + 1}`)
        const current = row.enabledWhen
        const options: (readonly [string, string])[] = [...conditions]

        if (current && !options.some(([value]) => value === JSON.stringify(current)))
          options.push([JSON.stringify(current), `${current.source} · ${current.path.join('.')}`])
        field.append(
          input('Item action ID', row.id, (value) => {
            row.id = value.trim()
            dirty = true
          }),
          select('Requested action', row.action, actions, (value) => {
            row.action = value
            dirty = true
          }),
          select(
            'Enable when true',
            current ? JSON.stringify(current) : '',
            [['', 'Always'], ...options],
            (value) => {
              row.enabledWhen = value ? gameBindingSchema.parse(JSON.parse(value)) : undefined
              dirty = true
            },
          ),
          button('Remove item action', () => {
            rows.splice(index, 1)
            dirty = true
            controls.markEdited()
            render()
          }),
        )

        return field
      }),
      button('Add item action', () => {
        rows.push({ id: '', action: actions[0] ?? '' })
        dirty = true
        controls.markEdited()
        render()
      }),
    )
    const submit = create('button')
    submit.type = 'submit'
    submit.textContent = 'Save item actions'
    form.append(submit, button('Discard item-action draft', reset))
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (new Set(rows.map(({ id }) => id)).size !== rows.length) {
        error.textContent = 'Item action IDs must be unique.'

        return
      }

      error.textContent = ''
      save({
        type: 'inventory.setItemActions',
        itemType: selected,
        actions: Object.fromEntries(
          rows.map(({ id, action, enabledWhen }) => [
            id,
            { action, ...(enabledWhen && { enabledWhen }) },
          ]),
        ),
      })
    })
    area.replaceChildren(form)
  }

  function reset() {
    rows = Object.entries(view.inventory!.itemTypes[selected]!.actions ?? {}).map(
      ([id, value]) => ({ id, ...structuredClone(value) }),
    )
    dirty = false
    error.textContent = ''
    render()
  }

  const picker = select(
    'Item type',
    selected,
    types.map(([id, type]) => [id, type.label] as const),
    (value) => {
      if (dirty) {
        picker.querySelector('select')!.value = selected
        error.textContent = 'Save or discard the item-action draft before switching item types.'

        return
      }

      selected = value
      reset()
    },
    false,
  )

  root.append(picker, error, area)
  reset()

  return root
}
