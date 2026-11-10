import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import {
  assetIdSchema,
  inventorySchema,
  inventoryItemTypeSchema,
  inventoryOwnerSchema,
  inventoryStartingItemSchema,
  mergeInventorySources,
  inventoryIssues,
} from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { displayLabel, ruleFormControls, saveBar, languageWatcher } from './ruleFormControls.js'
import {
  inventoryDefinitionForms,
  type InventoryEntrySelection,
} from './inventoryDefinitionForms.js'

/** Owns one inventory file draft, including all of its related definitions and placements. */
export function bindInventoryEditor(
  root: HTMLElement,
  save: (command: EditorCommand) => void,
  t: Translate = editorLocalization().t,
) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let selectedFile = ''
  let id = 'items'

  let draft = inventorySchema.parse({
    'schema-version': '1.0.0',
    itemTypes: {},
    owners: {},
    items: {},
  })

  let selected: InventoryEntrySelection = { kind: 'itemTypes', id: '' }
  let newId = ''
  const slot = { id: '', label: '' }
  let dirty = false
  let busy = false
  let submitted: Extract<EditorCommand, { type: 'game.upsertInventory' }> | undefined

  const languageChanged = languageWatcher(t)

  const controls = ruleFormControls(
    document,
    () => {
      dirty = true
    },
    t,
  )

  const report = (cause: unknown) => {
    error.textContent = cause instanceof Error ? cause.message : String(cause)
  }

  const context = () => {
    const sources = Object.entries(view?.inventoryFiles ?? {})
      .filter(([file]) => file !== selectedFile)
      .map(([file, inventory]) => ({ file, inventory }))

    const merged = mergeInventorySources([
      ...sources,
      { file: selectedFile || id, inventory: draft },
    ])

    return { inventory: merged.inventory ?? draft, issues: merged.issues }
  }

  const change = (operation: () => void) => {
    try {
      operation()
      dirty = true
      error.textContent = ''
      render()
    } catch (cause) {
      report(cause)
    }
  }

  const reset = () => {
    if (selectedFile && !view?.game?.inventory?.includes(selectedFile))
      selectedFile = view?.game?.inventory?.[0] ?? ''

    const source =
      view?.inventoryFiles?.[selectedFile] ??
      (view?.game?.inventory?.length === 1 && selectedFile ? view.inventory : undefined)

    draft = inventorySchema.parse(
      structuredClone(
        source ?? { 'schema-version': '1.0.0', itemTypes: {}, owners: {}, items: {} },
      ),
    )
    id = selectedFile || 'items'

    if (!selectedFile) {
      let suffix = 2

      while (view?.game?.inventory?.some((value) => value.toLowerCase() === id.toLowerCase()))
        id = `items-${suffix++}`
    }

    if (!Object.hasOwn(draft[selected.kind], selected.id)) selected.id = ''
    newId = ''
    slot.id = ''
    slot.label = ''
    dirty = false
    error.textContent = ''
    render()
  }

  const navigate = (file: string) => {
    if (file === selectedFile) return true

    if (dirty) {
      error.textContent = t('items.saveInventoryFirst')

      return false
    }

    selectedFile = file
    selected = { kind: 'itemTypes', id: '' }
    reset()

    return true
  }

  const canSwitchEntry = () => {
    if (!slot.id && !slot.label) return true
    error.textContent = t('items.pendingSlotSwitch')

    return false
  }

  function render() {
    fields.replaceChildren()

    if (!view?.game) return
    const current = view
    const form = document.createElement('form')
    form.className = 'inventory-editor-form'

    const picker = controls.select(
      t('items.inventoryFile'),
      selectedFile,
      [
        ['', t('items.newInventory')],
        ...(view.game.inventory ?? []).map((id) => [id, id] as const),
      ],
      (value) => {
        if (!navigate(value)) picker.querySelector('select')!.value = selectedFile
      },
      false,
    )

    const name = controls.input(t('items.inventoryId'), id, (value) => {
      id = value.trim()
    })

    name.querySelector('input')!.readOnly = Boolean(selectedFile)
    const saveButton = document.createElement('button')
    saveButton.type = 'submit'
    saveButton.textContent = t('items.saveInventory')
    const help = document.createElement('p')
    help.className = 'help'
    help.textContent = t('items.inventoryHelp')

    const kind = controls.select(
      t('items.entryKind'),
      selected.kind,
      [
        ['itemTypes', t('items.itemTypes')],
        ['owners', t('items.owners')],
        ['items', t('items.startingItems')],
      ],
      (value) => {
        if (value === selected.kind) return

        if (!canSwitchEntry()) {
          kind.querySelector('select')!.value = selected.kind

          return
        }

        selected = { kind: value, id: '' }
        render()
      },
      false,
    )

    const merged = context().inventory

    // Entries show their names; a starting item shows its instance ID and item type.
    const entryLabel = (entryId: string) => {
      if (selected.kind === 'items') {
        const itemType = draft.items[entryId]?.itemType ?? ''
        const type = merged.itemTypes[itemType]

        return `${entryId} · ${type ? displayLabel(current, itemType, type) : itemType}`
      }

      const definition = draft[selected.kind][entryId]
      const name = definition ? displayLabel(current, entryId, definition) : entryId

      return name === entryId ? entryId : `${name} (${entryId})`
    }

    const entry = controls.select(
      t('items.entry'),
      selected.id,
      [
        ['', t('items.chooseEntry')],
        ...Object.keys(draft[selected.kind]).map((id) => [id, entryLabel(id)] as const),
      ],
      (value) => {
        if (value === selected.id) return

        if (!canSwitchEntry()) {
          entry.querySelector('select')!.value = selected.id

          return
        }

        selected.id = value
        render()
      },
      false,
    )

    form.append(
      saveBar(document, saveButton, controls.button(t('items.discardInventory'), reset)),
      picker,
      name,
      help,
      kind,
      entry,
    )

    // Creating an entry comes after the selected entry, so the picker sits next to its form.
    const adding = controls.group(
      t(`items.new.${selected.kind}`),
      controls.input(t('items.newEntryId'), newId, (value) => {
        newId = value.trim()
      }),
      controls.button(
        t(`items.add.${selected.kind}`),
        () =>
          change(() => {
            if (
              !assetIdSchema.safeParse(newId).success ||
              Object.keys(merged[selected.kind]).some(
                (id) => id.toLowerCase() === newId.toLowerCase(),
              )
            )
              throw new Error(t('items.invalidEntryId'))

            if (selected.kind === 'itemTypes')
              draft.itemTypes[newId] = inventoryItemTypeSchema.parse({ label: newId })
            else if (selected.kind === 'owners')
              draft.owners[newId] = inventoryOwnerSchema.parse({ label: newId })
            else {
              const itemType = Object.keys(merged.itemTypes)[0]
              const owner = Object.keys(merged.owners)[0]

              if (!itemType || !owner) throw new Error(t('items.typeAndOwnerFirst'))
              draft.items[newId] = inventoryStartingItemSchema.parse({
                itemType,
                placement: { type: 'carried', owner },
              })
            }

            selected.id = newId
            newId = ''
          }),
        selected.kind === 'items' &&
          (!Object.keys(merged.itemTypes).length || !Object.keys(merged.owners).length),
      ),
    )

    if (selected.id && Object.hasOwn(draft[selected.kind], selected.id)) {
      const selectedId = controls.input(t('items.selectedEntryId'), selected.id, () => {})
      selectedId.querySelector('input')!.readOnly = true
      form.append(
        selectedId,
        ...inventoryDefinitionForms(
          controls,
          { ...current, inventory: merged },
          draft,
          selected,
          slot,
          change,
          render,
        ),
        controls.button(t(`items.remove.${selected.kind}`), () =>
          change(() => {
            const entries = draft[selected.kind]
            Reflect.deleteProperty(entries, selected.id)
            selected.id = ''
            slot.id = ''
            slot.label = ''
          }),
        ),
      )
    }

    form.append(adding)
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (busy) return

      if (newId || slot.id || slot.label) {
        error.textContent = t('items.pendingSave')

        return
      }

      const parsed = commandSchema.safeParse({
        type: 'game.upsertInventory',
        inventoryId: id,
        inventory: draft,
        createOnly: !selectedFile,
      })

      if (!parsed.success) {
        error.textContent = parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('\n')

        return
      }

      const merged = context()
      const issues = [...merged.issues, ...inventoryIssues(merged.inventory, current.assets)]

      if (issues.length) {
        error.textContent = issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('\n')

        return
      }

      if (parsed.data.type !== 'game.upsertInventory') return
      submitted = structuredClone(parsed.data)
      error.textContent = ''
      save(parsed.data)
    })
    fields.append(form)
    fields.disabled = busy || Boolean(view.diagnostics.length)
  }

  return {
    hasDrafts: () => dirty,
    navigate,
    render(state: ProjectEditorState, replaceFields: boolean) {
      const translated = languageChanged()
      const projectChanged = path !== state.path
      const changed = view !== state.view
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        submitted && !busy && replaceFields && !state.error && state.lastCommand === submitted.type
          ? submitted
          : undefined

      if (!busy) submitted = undefined

      if (projectChanged) {
        selectedFile = view?.game?.inventory?.[0] ?? ''
        selected = { kind: 'itemTypes', id: '' }
      }

      if (saved) selectedFile = saved.inventoryId

      if (
        projectChanged ||
        saved ||
        (replaceFields && !state.preserveDrafts) ||
        (changed && !dirty)
      )
        reset()
      else if (changed || translated) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
  }
}
