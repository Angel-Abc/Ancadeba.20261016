import { commandSchema, type ProjectView, type EditorCommand } from '@ancadeba/editor-core'
import {
  shopComponentSchema,
  inventoryComponentSchema,
  type ShopComponentDefinition,
  type InventoryComponentDefinition,
} from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar } from './ruleFormControls.js'
import { shopForm } from './shopForm.js'
import { sceneChoices } from './choiceLabels.js'

export function bindShopEditor(root: HTMLElement, save: (command: EditorCommand) => void) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let sceneId = ''
  let draft: ShopComponentDefinition | undefined
  let panels: InventoryComponentDefinition[] = []
  let dirty = false
  let busy = false

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const scene = () => view?.scenes.find((scene) => scene.id === sceneId)

  const reset = () => {
    const shop = scene()?.components.find((component) => component.type === 'shop')
    draft = shop?.type === 'shop' ? structuredClone(shop) : undefined
    panels = draft
      ? [draft.playerInventory, draft.merchantInventory].flatMap((id) => {
          const panel = scene()?.components.find((component) => component.id === id)

          return panel?.type === 'inventory' ? [structuredClone(panel)] : []
        })
      : []
    dirty = false
    error.textContent = ''
    render()
  }

  const navigate = (id?: string) => {
    if (!id || id === sceneId) return true

    if (dirty) {
      error.textContent = 'Save or discard the shop draft before switching scenes.'

      return false
    }

    sceneId = id
    reset()

    return true
  }

  const submit = (command: EditorCommand) => {
    if (busy) return
    const parsed = commandSchema.safeParse(command)
    error.textContent = parsed.success
      ? ''
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')

    if (parsed.success) save(parsed.data)
  }

  function render() {
    fields.replaceChildren()

    if (!view?.game) return

    const picker = controls.select(
      'Shop game scene',
      sceneId,
      sceneChoices(view, 'game'),
      (value) => {
        if (!navigate(value)) picker.querySelector('select')!.value = sceneId
      },
      false,
    )

    picker.className = 'context-picker'

    fields.append(picker)

    if (!scene()) return

    if (!draft) {
      fields.append(
        controls.button('Add shop', () => {
          const owners = Object.keys(view?.inventory?.owners ?? {})

          const unique = (base: string) => {
            let id = base
            let number = 1

            while (scene()?.components.some((component) => component.id === id))
              id = `${base}-${number++}`

            return id
          }

          panels = ['player-items', 'merchant-items'].map((id, index) =>
            inventoryComponentSchema.parse({
              id: unique(id),
              type: 'inventory',
              label: index === 0 ? 'Your inventory' : 'Merchant inventory',
              owners: [owners[index] ?? owners[0] ?? 'owner'],
              readOnly: true,
              placement: {
                row: 1,
                column: index === 0 ? 1 : Math.min(2, scene()!.screen.grid.columns),
              },
            }),
          )
          const field = view?.rules?.state.find((field) => typeof field.value === 'number')
          draft = shopComponentSchema.parse({
            id: unique('shop'),
            type: 'shop',
            placement: { row: 1, column: 1 },
            playerInventory: panels[0]!.id,
            merchantInventory: panels[1]!.id,
            playerBalance: { source: 'game.state', path: field?.path ?? ['gold'] },
            merchantFunds: { type: 'unlimited' },
            prices: {},
          })
          dirty = true
          render()
        }),
      )

      return
    }

    const form = document.createElement('form')
    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = 'Save shop'
    form.append(
      saveBar(document, saveButton),
      ...shopForm(controls, view, sceneId, draft, panels, render),
    )
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (draft) submit({ type: 'scene.upsertShop', sceneId, component: draft, panels })
    })
    fields.append(
      form,
      controls.button('Discard shop draft', reset),
      controls.button(
        'Remove shop',
        () => {
          if (draft) submit({ type: 'scene.removeShop', sceneId, componentId: draft.id })
        },
        !scene()?.components.some((component) => component.type === 'shop'),
      ),
    )
  }

  return {
    navigate,
    hasDrafts: () => dirty,
    render(state: ProjectEditorState, replaceFields: boolean) {
      const projectChanged = path !== state.path
      const changed = view !== state.view
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        replaceFields && ['scene.upsertShop', 'scene.removeShop'].includes(state.lastCommand ?? '')

      const replace = projectChanged || (replaceFields && !state.preserveDrafts)

      if (replace) sceneId = view?.scenes.find((scene) => scene.type === 'game')?.id ?? ''

      if (replace || saved || (changed && !dirty)) reset()
      else if (changed) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
