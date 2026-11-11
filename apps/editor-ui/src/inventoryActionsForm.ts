import { registerEditorDraft } from './editorDraftState.js'
import { z } from 'zod'
import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import { gameBindingSchema, type GameBindingDefinition } from '@ancadeba/schemas'
import { displayLabel, statePath, type RuleFormControls } from './ruleFormControls.js'

/** Item action IDs are resolved by reserved inventory slots in the scene's bar. */
export function inventoryActionsForm(
  controls: RuleFormControls,
  view: ProjectView,
  save: (command: EditorCommand) => void,
  onDiscard: () => void = () => {},
): HTMLElement {
  const { create, select, input, button, group, t } = controls
  const root = group(t('items.selectedActions'))
  const types = Object.entries(view.inventory?.itemTypes ?? {})

  if (!types.length) {
    root.append(t('items.typesFirstActions'))

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
        const field = group(t('items.itemAction', { number: index + 1 }))
        const current = row.enabledWhen
        const options: (readonly [string, string])[] = [...conditions]

        if (current && !options.some(([value]) => value === JSON.stringify(current)))
          options.push([JSON.stringify(current), `${current.source} · ${current.path.join('.')}`])
        field.append(
          input(t('form.itemActionId'), row.id, (value) => {
            row.id = value.trim()
            dirty = true
          }),
          select(t('form.requestedAction'), row.action, actions, (value) => {
            row.action = value
            dirty = true
          }),
          select(
            t('form.enableWhenTrue'),
            current ? JSON.stringify(current) : '',
            [['', t('form.always')], ...options],
            (value) => {
              row.enabledWhen = value ? gameBindingSchema.parse(JSON.parse(value)) : undefined
              dirty = true
            },
          ),
          button(t('items.removeItemAction'), () => {
            rows.splice(index, 1)
            dirty = true
            controls.markEdited()
            render()
          }),
        )

        return field
      }),
      button(t('items.addItemAction'), () => {
        rows.push({ id: '', action: actions[0] ?? '' })
        dirty = true
        controls.markEdited()
        render()
      }),
    )
    const submit = create('button')
    submit.type = 'submit'
    submit.textContent = t('items.saveItemActions')
    form.append(
      submit,
      button(t('items.discardItemActions'), () => {
        reset()
        onDiscard()
      }),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (new Set(rows.map(({ id }) => id)).size !== rows.length) {
        error.textContent = t('items.uniqueActionIds')

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
    t('form.itemType'),
    selected,
    types.map(([id, type]) => [id, displayLabel(view, id, type)] as const),
    (value) => {
      if (dirty) {
        picker.querySelector('select')!.value = selected
        error.textContent = t('items.saveActionsFirst')

        return
      }

      selected = value
      reset()
    },
    false,
  )

  root.append(picker, error, area)
  reset()

  registerEditorDraft(
    root,
    'inventory-actions',
    z.object({
      selected: z.string(),
      rows: z.array(
        z.object({ id: z.string(), action: z.string(), enabledWhen: gameBindingSchema.optional() }),
      ),
    }),
    () => (dirty ? { selected, rows } : undefined),
    (saved) => {
      selected = saved.selected
      rows = saved.rows
      dirty = true
      controls.markEdited()
      render()
    },
  )

  return root
}
