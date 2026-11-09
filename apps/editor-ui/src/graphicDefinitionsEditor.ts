import { commandSchema, type EditorCommand, type ProjectView } from '@ancadeba/editor-core'
import { assetCatalogSchema, graphicAppearanceSchema } from '@ancadeba/schemas'
import type { ProjectEditorState } from './projectController.js'
import { ruleFormControls, saveBar } from './ruleFormControls.js'
import { partDefinitionForm } from './partDefinitionForm.js'
import { compositionDefinitionForm } from './compositionDefinitionForm.js'
import { requireDefinitionId, type GraphicDefinitionPending } from './graphicDefinitionForms.js'
import {
  graphicDefinitionPreview,
  type GraphicDefinitionPreviewFactory,
} from './graphicDefinitionPreview.js'

type DefinitionKind = 'parts' | 'compositions'

type DefinitionCommand = Extract<EditorCommand, { type: 'assets.updateDefinitions' }>

/** All parts and compositions share a draft so their attachment references can change together. */
export function bindGraphicDefinitionsEditor(
  root: HTMLElement,
  save: (command: EditorCommand) => void,
  createPreview?: GraphicDefinitionPreviewFactory,
) {
  const document = root.ownerDocument
  const error = document.createElement('p')
  error.className = 'error'
  error.setAttribute('role', 'alert')
  const fields = document.createElement('fieldset')
  const previewRoot = document.createElement('div')
  previewRoot.className = 'definition-preview'
  const preview = graphicDefinitionPreview(previewRoot, createPreview)
  root.replaceChildren(error, fields)
  let view: ProjectView | undefined
  let path: string | undefined
  let catalog = assetCatalogSchema.parse({ 'schema-version': '1.0.0' })
  let kind: DefinitionKind = 'parts'
  let selected = ''
  let newId = ''
  let palette = ''
  let dirty = false
  let busy = false
  let submitted: DefinitionCommand | undefined

  const pending: GraphicDefinitionPending = {
    piece: '',
    layer: '',
    anchor: '',
    slot: '',
    color: '',
    palette: '',
  }

  const clearPending = () => {
    for (const key of Object.keys(pending)) Reflect.set(pending, key, '')
  }

  const hasPending = () => Object.values(pending).some(Boolean)

  const controls = ruleFormControls(document, () => {
    dirty = true
  })

  const updatePreview = () => {
    const parsed = assetCatalogSchema.safeParse(catalog)

    if (!selected) {
      preview.clear('Create or select a part or composition to preview it.')

      return
    }

    if (!parsed.success) {
      preview.clear(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'),
      )

      return
    }

    preview.render(
      parsed.data,
      selected,
      graphicAppearanceSchema.parse({ palette: palette || undefined }),
    )
  }

  const edited = () => {
    dirty = true
    updatePreview()
  }

  const change = (operation: () => void) => {
    try {
      operation()
      dirty = true
      error.textContent = ''
      render()
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const reset = () => {
    catalog = structuredClone(
      view?.assets ?? assetCatalogSchema.parse({ 'schema-version': '1.0.0' }),
    )

    if (!Object.hasOwn(catalog[kind], selected)) selected = ''
    newId = ''
    palette = ''
    clearPending()
    dirty = false
    error.textContent = ''
    render()
  }

  const switchEntry = (nextKind: DefinitionKind, id: string) => {
    if (nextKind === kind && id === selected) return true

    if (hasPending()) {
      error.textContent =
        'Add or clear the pending piece, layer, anchor, slot, color or palette before switching entries.'

      return false
    }

    kind = nextKind
    selected = id
    palette = ''
    render()

    return true
  }

  function render() {
    fields.replaceChildren()

    if (!view?.game) return
    const { input, select, button } = controls
    const form = document.createElement('form')
    form.className = 'graphic-definitions-form'
    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = 'Save parts and compositions'

    const type = select(
      'Definition kind',
      kind,
      [
        ['parts', 'Parts'],
        ['compositions', 'Compositions'],
      ],
      (value) => {
        if (!switchEntry(value, '')) type.querySelector('select')!.value = kind
      },
      false,
    )

    const picker = select(
      'Graphic definition',
      selected,
      [['', 'Choose a definition'], ...Object.keys(catalog[kind])],
      (value) => {
        if (!switchEntry(kind, value)) picker.querySelector('select')!.value = selected
      },
      false,
    )

    const newDefinition = input('New graphic definition ID', newId, (value) => {
      newId = value.trim()
    })

    const add = button(kind === 'parts' ? 'Add part' : 'Add composition', () =>
      change(() => {
        requireDefinitionId(newId, [
          ...Object.keys(catalog.images),
          ...Object.keys(catalog.parts),
          ...Object.keys(catalog.compositions),
        ])
        const bounds = { x: 0, y: 0, width: 100, height: 100 }

        if (kind === 'parts')
          catalog.parts[newId] = { bounds, pieces: [], colors: {}, palettes: {} }
        else
          catalog.compositions[newId] = {
            bounds,
            layers: ['body'],
            anchors: { origin: { x: 0, y: 0 } },
            slots: {},
          }
        selected = newId
        newId = ''
        palette = ''
      }),
    )

    // A definition chosen in the explorer needs no kind, definition or new-ID pickers.
    if (selected && Object.hasOwn(catalog[kind], selected))
      for (const control of [type, picker, newDefinition, add])
        control.setAttribute('data-explorer-chosen', '')
    const help = document.createElement('p')
    help.className = 'help'
    help.textContent =
      'Edit parts and compositions together, then save. Layers run back to front. Markers show source attachment points on parts and destination anchors on compositions. Invalid drafts stay editable.'
    form.append(
      saveBar(document, submit, button('Discard graphic definitions draft', reset)),
      help,
      type,
      picker,
      newDefinition,
      add,
    )
    const layout = document.createElement('div')
    layout.className = 'graphic-definitions-layout'
    const visual = document.createElement('section')
    visual.append(previewRoot)
    const part = kind === 'parts' ? catalog.parts[selected] : undefined

    if (palette && !Object.hasOwn(part?.palettes ?? {}, palette)) palette = ''

    if (part && Object.keys(part.palettes).length)
      visual.append(
        select(
          'Preview palette',
          palette,
          [['', 'Default colors'], ...Object.keys(part.palettes).map((id) => [id, id] as const)],
          (value) => {
            palette = value
            updatePreview()
          },
          false,
        ),
      )
    const definitions = document.createElement('div')
    const context = { controls, pending, change, edited }
    const composition = kind === 'compositions' ? catalog.compositions[selected] : undefined

    if (part) definitions.append(...partDefinitionForm(context, catalog, part))

    if (composition) definitions.append(...compositionDefinitionForm(context, catalog, composition))

    if (part || composition)
      definitions.append(
        button(kind === 'parts' ? 'Remove part' : 'Remove composition', () =>
          change(() => {
            Reflect.deleteProperty(catalog[kind], selected)
            selected = ''
            clearPending()
          }),
        ),
      )
    layout.append(visual, definitions)
    form.append(layout)
    form.addEventListener('submit', (event) => {
      event.preventDefault()

      if (busy) return

      if (newId || hasPending()) {
        error.textContent = 'Add or clear pending identifiers before saving.'

        return
      }

      const parsed = commandSchema.safeParse({
        type: 'assets.updateDefinitions',
        parts: catalog.parts,
        compositions: catalog.compositions,
      })

      const assets = assetCatalogSchema.safeParse(catalog)

      if (!parsed.success || !assets.success) {
        error.textContent = [
          ...(!parsed.success ? parsed.error.issues : []),
          ...(!assets.success ? assets.error.issues : []),
        ]
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('\n')

        return
      }

      if (parsed.data.type !== 'assets.updateDefinitions') return
      submitted = structuredClone(parsed.data)
      save(parsed.data)
    })
    fields.append(form)
    fields.disabled = busy || Boolean(view.diagnostics.length)
    updatePreview()
  }

  return {
    hasDrafts: () => dirty,
    navigate(nextKind: DefinitionKind = 'parts', id = '') {
      if (nextKind === kind && id === selected) return true

      if (dirty) {
        error.textContent = 'Save or discard the graphic definitions draft before changing assets.'

        return false
      }

      kind = nextKind
      selected = id
      reset()

      return true
    },
    render(state: ProjectEditorState, replaceFields: boolean) {
      const projectChanged = path !== state.path
      const changed = view !== state.view
      path = state.path
      view = state.view
      busy = state.busy

      const saved =
        submitted && replaceFields && !busy && !state.error && state.lastCommand === submitted.type

      if (!busy) submitted = undefined

      if (projectChanged) selected = ''

      if (
        projectChanged ||
        saved ||
        (replaceFields && !state.preserveDrafts) ||
        (changed && !dirty)
      )
        reset()
      else if (changed) render()
      fields.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    },
    dispose: () => preview.clear(),
  }
}
