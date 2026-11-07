import {
  assetCatalogSchema,
  graphicAppearanceSchema,
  graphicComponentSchema,
  imageAssetSchema,
  partSchema,
  compositionSchema,
  type ImageAsset,
  type GraphicPart,
} from '@ancadeba/schemas'
import { inspectImageSource } from '@ancadeba/game-runtime'
import {
  BrowserGraphicResources,
  createGraphicPlatform,
  GraphicComponentRenderer,
  type RenderedGraphic,
  type RenderedComponent,
} from '@ancadeba/ui-components'
import type { EditorCommand } from '@ancadeba/editor-core'
import type { Translate } from '@ancadeba/utilities'
import type { ProjectEditorState } from './projectController.js'
import { EditorWorkspaceResources } from './workspaceResources.js'

export interface AssetPanelActions {
  save(command: EditorCommand): Promise<void>
  importAsset(id: string, format: ImageAsset['format'], file: File): Promise<void>
}

/** Asset drafts share the project's optimistic revision, but preview controls never save. */
export function bindAssetsPanel(
  root: HTMLElement,
  actions: AssetPanelActions,
  fetcher: typeof fetch,
  t: Translate,
  onSelectAsset?: (id: string) => void,
  /** Opens an explorer node by key, such as the image import form from an empty gallery. */
  onOpen?: (key: string) => void,
) {
  const panel = root.querySelector<HTMLElement>('#assets-panel')
  const dirty = new Set<string>()
  let submittedForm: string | undefined
  let controlLanguage = t('assets.defaults')
  let state: ProjectEditorState | undefined
  let resources: BrowserGraphicResources | undefined
  let resourceRevision = ''
  let selected = ''
  let navigationKey = ''
  let preview: RenderedGraphic | undefined
  let thumbnails: RenderedComponent[] = []
  let appearance = graphicAppearanceSchema.parse({})
  const abort = new AbortController()

  if (!panel)
    return {
      render: (_state: ProjectEditorState, _replace: boolean) => {},
      dispose: () => {},
      hasDrafts: () => false,
      navigate: (_kind: string, _id?: string, _sceneId?: string) => {},
    }
  const document = panel.ownerDocument
  panel.innerHTML = `
    <h3 data-i18n="assets.heading"></h3><p class="help" data-i18n="assets.help"></p>
    <div id="asset-gallery" class="asset-gallery"></div>
    <div id="asset-empty" class="asset-empty" hidden><p id="asset-empty-text"></p><button type="button" id="asset-empty-action"></button></div><div id="asset-workshop">
    <label for="asset-select" data-i18n="assets.visual"></label><select id="asset-select"></select>
    <div id="asset-preview" class="asset-preview"></div><div id="asset-preview-controls" class="asset-preview-controls"></div>
    <p class="help" data-i18n="assets.temporary"></p>
    <form id="asset-palettes"><h4 data-i18n="assets.colors"></h4><div id="asset-color-fields"></div>
      <label for="asset-preset-name" data-i18n="assets.presetName"></label><input id="asset-preset-name" pattern="[a-zA-Z0-9_-]+" />
      <div class="preview-actions"><button type="button" id="asset-save-defaults" data-i18n="assets.saveDefaults"></button><button type="submit" data-i18n="assets.savePreset"></button><button type="button" id="asset-remove-preset" data-i18n="assets.removePreset"></button></div>
    </form>
    </div><form id="asset-image"><h4 data-i18n="assets.import"></h4>
      <label for="asset-image-id" data-i18n="metadata.id"></label><input id="asset-image-id" required pattern="[a-zA-Z0-9_-]+" />
      <label for="asset-format" data-i18n="assets.format"></label><select id="asset-format"><option>svg</option><option>png</option><option>jpeg</option><option>webp</option></select>
      <label for="asset-file" data-i18n="assets.file"></label><input id="asset-file" type="file" accept=".svg,.png,.jpg,.jpeg,.webp" />
      <label for="asset-source" data-i18n="assets.source"></label><input id="asset-source" placeholder="assets/images/tunic.svg" />
      <button type="submit" data-i18n="assets.saveImage"></button>
    </form>
    <details><summary data-i18n="assets.definitions"></summary><form id="asset-definition">
      <label for="asset-kind" data-i18n="assets.kind"></label><select id="asset-kind"><option value="images" data-i18n="assets.image"></option><option value="parts" data-i18n="assets.part"></option><option value="compositions" data-i18n="assets.composition"></option></select>
      <label for="asset-definition-id" data-i18n="metadata.id"></label><input id="asset-definition-id" required pattern="[a-zA-Z0-9_-]+" />
      <label for="asset-json" data-i18n="assets.definitionJson"></label><textarea id="asset-json" rows="12" spellcheck="false"></textarea>
      <div class="preview-actions"><button type="submit" data-i18n="assets.saveDefinition"></button><button id="asset-remove" type="button" data-i18n="assets.remove"></button></div>
    </form></details>
    <form id="asset-graphic"><h4 data-i18n="assets.sceneGraphic"></h4>
      <label for="graphic-scene" data-i18n="scene.label"></label><select id="graphic-scene"></select>
      <label for="graphic-existing" data-i18n="assets.existing"></label><select id="graphic-existing"></select>
      <label for="graphic-id" data-i18n="metadata.id"></label><input id="graphic-id" required pattern="[a-zA-Z0-9_-]+" />
      <label for="graphic-visual" data-i18n="assets.visual"></label><select id="graphic-visual"></select>
      <label for="graphic-alt" data-i18n="assets.alt"></label><input id="graphic-alt" />
      <label for="graphic-alt-key" data-i18n="assets.altKey"></label><input id="graphic-alt-key" />
      <label for="graphic-fit" data-i18n="assets.fit"></label><select id="graphic-fit"><option value="contain" data-i18n="assets.contain"></option><option value="cover" data-i18n="assets.cover"></option></select>
      <div class="graphic-placement"><label><span data-i18n="assets.row"></span><input id="graphic-row" type="number" min="1" step="1" value="1" required /></label><label><span data-i18n="assets.column"></span><input id="graphic-column" type="number" min="1" step="1" value="1" required /></label><label><span data-i18n="assets.rowSpan"></span><input id="graphic-row-span" type="number" min="1" step="1" value="1" required /></label><label><span data-i18n="assets.columnSpan"></span><input id="graphic-column-span" type="number" min="1" step="1" value="1" required /></label></div>
      <label for="graphic-appearance" data-i18n="assets.appearanceJson"></label><textarea id="graphic-appearance" rows="6" spellcheck="false">{}</textarea>
      <div class="preview-actions"><button type="submit" data-i18n="assets.saveGraphic"></button><button type="button" id="graphic-remove" data-i18n="assets.removeGraphic"></button></div>
    </form><p id="asset-error" class="error" role="alert" hidden></p>`

  const find = <T extends HTMLElement>(id: string) => {
    const node = panel.querySelector<T>(`#${id}`)

    if (!node) throw new Error(`Missing asset control: ${id}`)

    return node
  }

  const value = (id: string) =>
    find<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id).value

  let browsingKind = ''

  // An empty gallery explains what belongs in it and offers the form that adds one.
  const showEmptyState = () => {
    const hasVisuals = [...panel.querySelectorAll<HTMLElement>('.asset-thumbnail')].some(
      (thumbnail) => !thumbnail.hidden,
    )

    const empty = find('asset-empty')
    empty.hidden = !browsingKind || hasVisuals

    if (empty.hidden) return
    const images = browsingKind === 'images' || browsingKind === 'section'
    find('asset-empty-text').textContent = t(`assets.empty.${browsingKind}`)
    const action = find<HTMLButtonElement>('asset-empty-action')
    action.textContent = t(images ? 'assets.import' : 'tree.addDefinition')
    action.dataset.target = images ? 'asset-import' : 'asset-new'
  }

  const set = (id: string, value: string | number) => {
    find<HTMLInputElement | HTMLTextAreaElement>(id).value = String(value)
  }

  const on = (id: string, event: string, action: (event: Event) => void | Promise<void>) => {
    find(id).addEventListener(
      event,
      (event) => {
        if (event.type === 'submit' || event.type === 'click')
          submittedForm = find(id).closest('form')?.id

        if (event.type === 'submit') event.preventDefault()
        const error = find('asset-error')
        error.hidden = true
        void Promise.resolve()
          .then(() => action(event))
          .catch((failure: unknown) => {
            error.textContent = failure instanceof Error ? failure.message : String(failure)
            error.hidden = false
          })
      },
      { signal: abort.signal },
    )
  }

  const option = (value: string, text = value) => {
    const node = document.createElement('option')
    node.value = value
    node.textContent = text

    return node
  }

  const selectOptions = (id: string, entries: [string, string][]) => {
    const control = find<HTMLSelectElement>(id)
    const previous = control.value
    control.replaceChildren(...entries.map(([id, label]) => option(id, label)))

    if (entries.some(([id]) => id === previous)) control.value = previous
  }

  const catalog = () =>
    state?.view?.assets ?? assetCatalogSchema.parse({ 'schema-version': '1.0.0' })

  const kindOf = (id: string) =>
    Object.hasOwn(catalog().images, id)
      ? 'images'
      : Object.hasOwn(catalog().parts, id)
        ? 'parts'
        : 'compositions'

  const paletteAsset = (): ImageAsset | GraphicPart | undefined =>
    catalog().images[selected] ?? catalog().parts[selected]

  const makeGraphic = (visual: string) =>
    graphicComponentSchema.parse({
      id: 'asset-preview',
      type: 'graphic',
      placement: { row: 1, column: 1 },
      visual,
      alt: visual,
    })

  const renderer = new GraphicComponentRenderer()
  const updatePreview = () => preview?.setAppearance(appearance)

  const renderColors = () => {
    const container = find('asset-color-fields')
    container.replaceChildren()
    const asset = paletteAsset()
    find('asset-palettes').hidden = !asset || !Object.keys(asset.colors).length

    if (!asset) return
    const preset = document.createElement('select')
    preset.setAttribute('aria-label', t('assets.presetName'))
    preset.append(
      option('', t('assets.defaults')),
      ...Object.keys(asset.palettes).map((id) => option(id)),
    )
    preset.value = appearance.palette ?? ''
    preset.addEventListener('change', () => {
      appearance = graphicAppearanceSchema.parse({
        ...appearance,
        palette: preset.value || undefined,
        colors: {},
      })
      set('asset-preset-name', preset.value)
      renderColors()
      updatePreview()
    })
    container.append(preset)

    for (const [slot, fallback] of Object.entries(asset.colors)) {
      const label = document.createElement('label')
      label.textContent = slot
      const input = document.createElement('input')
      input.type = 'color'
      input.dataset.slot = slot
      input.value =
        appearance.colors[slot] ?? asset.palettes[appearance.palette ?? '']?.[slot] ?? fallback
      input.addEventListener('input', () => {
        appearance.colors[slot] = input.value
        dirty.add('asset-palettes')
        updatePreview()
      })
      label.append(input)
      container.append(label)
    }
  }

  const renderSlotControls = () => {
    const container = find('asset-preview-controls')
    container.replaceChildren()
    const composition = catalog().compositions[selected]

    for (const [slot, definition] of Object.entries(composition?.slots ?? {})) {
      const selection = appearance.slots[slot] ?? { colors: {}, visible: true }
      const id = selection.part === undefined ? definition.default : selection.part
      const label = document.createElement('label')
      label.textContent = slot
      const choices = document.createElement('select')
      choices.append(option('', t('assets.none')), ...definition.parts.map((part) => option(part)))
      choices.value = id ?? ''
      choices.addEventListener('change', () => {
        appearance.slots[slot] = { part: choices.value || null, colors: {}, visible: true }
        renderSlotControls()
        updatePreview()
      })
      label.append(choices)
      container.append(label)
      const part = id ? catalog().parts[id] : undefined

      if (!part) continue
      const preset = document.createElement('select')
      preset.setAttribute('aria-label', `${slot} ${t('assets.presetName')}`)
      preset.append(
        option('', t('assets.defaults')),
        ...Object.keys(part.palettes).map((name) => option(name)),
      )
      preset.value = selection.palette ?? ''
      preset.addEventListener('change', () => {
        appearance.slots[slot] = { ...selection, palette: preset.value || undefined, colors: {} }
        renderSlotControls()
        updatePreview()
      })
      container.append(preset)

      for (const [colorSlot, fallback] of Object.entries(part.colors)) {
        const colorLabel = document.createElement('label')
        colorLabel.textContent = `${slot} · ${colorSlot}`
        const input = document.createElement('input')
        input.type = 'color'
        input.value =
          selection.colors[colorSlot] ??
          part.palettes[selection.palette ?? '']?.[colorSlot] ??
          fallback
        input.addEventListener('input', () => {
          selection.colors[colorSlot] = input.value
          appearance.slots[slot] = selection
          updatePreview()
        })
        colorLabel.append(input)
        container.append(colorLabel)
      }
    }
  }

  const fillSelection = (preserve: boolean) => {
    const definitions = catalog()

    if (selected && !preserve) {
      const kind = kindOf(selected)
      set('asset-kind', kind)

      if (!dirty.has('asset-definition')) {
        set('asset-definition-id', selected)
        set('asset-json', JSON.stringify(definitions[kind][selected], null, 2))
      }

      const image = definitions.images[selected]

      if (image && !dirty.has('asset-image')) {
        set('asset-image-id', selected)
        set('asset-source', image.source)
        set('asset-format', image.format)
      }
    }

    preview?.dispose()
    preview = undefined
    find('asset-preview').replaceChildren()

    if (selected && resources) {
      preview = renderer.render(makeGraphic(selected), {
        document,
        assets: definitions,
        graphics: resources,
        bindingMode: 'editor',
      })
      find('asset-preview').append(preview.element)
      updatePreview()
    }

    renderColors()
    renderSlotControls()
  }

  const fillGraphics = () => {
    if (dirty.has('asset-graphic')) return
    const scene = state?.view?.scenes.find((scene) => scene.id === value('graphic-scene'))
    const components = scene?.components.filter((component) => component.type === 'graphic') ?? []
    selectOptions('graphic-existing', [
      ['', t('assets.newGraphic')],
      ...components.map((component): [string, string] => [component.id, component.id]),
    ])
    const component = components.find((component) => component.id === value('graphic-existing'))
    set('graphic-id', component?.id ?? '')
    set('graphic-visual', component?.visual ?? selected)
    set('graphic-alt', component?.alt ?? '')
    set('graphic-alt-key', component?.altKey ?? '')
    set('graphic-fit', component?.fit ?? 'contain')
    set('graphic-row', component?.placement.row ?? 1)
    set('graphic-column', component?.placement.column ?? 1)
    set('graphic-row-span', component?.placement.rowSpan ?? 1)
    set('graphic-column-span', component?.placement.columnSpan ?? 1)
    set('graphic-appearance', JSON.stringify(component?.appearance ?? {}, null, 2))
  }

  const savePalette = async (mode: 'defaults' | 'preset' | 'remove') => {
    const asset = paletteAsset()

    if (!asset) return
    const colors: Record<string, string> = {}

    for (const input of panel.querySelectorAll<HTMLInputElement>(
      '#asset-color-fields input[type=color]',
    ))
      colors[input.dataset.slot!] = input.value
    const palettes = { ...asset.palettes }

    if (mode !== 'defaults') {
      const name = value('asset-preset-name')

      if (!name) throw new Error(t('assets.requirePreset'))

      if (mode === 'remove') delete palettes[name]
      else palettes[name] = colors
    }

    const next = { ...asset, colors: mode === 'defaults' ? colors : asset.colors, palettes }

    if (Object.hasOwn(catalog().images, selected))
      await actions.save({
        type: 'assets.upsertImage',
        id: selected,
        image: imageAssetSchema.parse(next),
      })
    else
      await actions.save({ type: 'assets.upsertPart', id: selected, part: partSchema.parse(next) })
  }

  on('asset-empty-action', 'click', () => {
    const target = find('asset-empty-action').dataset.target

    if (target) onOpen?.(target)
  })
  on('asset-select', 'change', () => {
    selected = value('asset-select')
    appearance = graphicAppearanceSchema.parse({})
    fillSelection(false)
  })
  on('asset-image', 'submit', async (event) => {
    event.preventDefault()
    const format = imageAssetSchema.shape.format.parse(value('asset-format'))
    const file = find<HTMLInputElement>('asset-file').files?.[0]

    if (file) {
      await actions.importAsset(value('asset-image-id'), format, file)

      return
    }

    if (!state?.view) return
    const source = value('asset-source')
    const id = value('asset-image-id')
    const path = state.path
    const revision = state.view.revision
    const bytes = await new EditorWorkspaceResources(path, fetcher).readBytes(source)

    if (state.path !== path || state.view?.revision !== revision)
      throw new Error(t('project.changed'))

    const info = inspectImageSource(
      format,
      bytes,
      format === 'svg' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : '',
    )

    const previous = catalog().images[id]
    const colors = { ...info.colors }

    for (const slot of Object.keys(colors))
      if (previous?.colors[slot]) colors[slot] = previous.colors[slot]!
    await actions.save({
      type: 'assets.upsertImage',
      id,
      image: {
        format,
        source,
        bounds: info.bounds,
        colors,
        palettes: previous?.palettes ?? {},
        ...(previous?.preview ? { preview: previous.preview } : {}),
      },
    })
  })
  on('asset-file', 'change', () => {
    const file = find<HTMLInputElement>('asset-file').files?.[0]

    if (!file) return
    const extension = file.name.split('.').at(-1)?.toLowerCase()

    if (extension) set('asset-format', extension === 'jpg' ? 'jpeg' : extension)

    if (!value('asset-image-id'))
      set('asset-image-id', file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-'))
  })
  on('asset-definition', 'submit', async (event) => {
    event.preventDefault()
    const definition: unknown = JSON.parse(value('asset-json'))
    const id = value('asset-definition-id')

    if (value('asset-kind') === 'images')
      await actions.save({
        type: 'assets.upsertImage',
        id,
        image: imageAssetSchema.parse(definition),
      })
    else if (value('asset-kind') === 'parts')
      await actions.save({ type: 'assets.upsertPart', id, part: partSchema.parse(definition) })
    else
      await actions.save({
        type: 'assets.upsertComposition',
        id,
        composition: compositionSchema.parse(definition),
      })
  })
  on('asset-remove', 'click', () =>
    actions.save({ type: 'assets.remove', kind: kindOf(selected), id: selected }),
  )
  on('asset-palettes', 'submit', (event) => {
    event.preventDefault()

    return savePalette('preset')
  })
  on('asset-save-defaults', 'click', () => savePalette('defaults'))
  on('asset-remove-preset', 'click', () => savePalette('remove'))
  on('graphic-scene', 'change', fillGraphics)
  on('graphic-existing', 'change', fillGraphics)
  on('asset-graphic', 'submit', (event) => {
    event.preventDefault()
    const appearance: unknown = JSON.parse(value('graphic-appearance'))

    const component = graphicComponentSchema.parse({
      id: value('graphic-id'),
      type: 'graphic',
      visual: value('graphic-visual'),
      alt: value('graphic-alt'),
      ...(value('graphic-alt-key') ? { altKey: value('graphic-alt-key') } : {}),
      fit: value('graphic-fit'),
      placement: {
        row: Number(value('graphic-row')),
        column: Number(value('graphic-column')),
        rowSpan: Number(value('graphic-row-span')),
        columnSpan: Number(value('graphic-column-span')),
      },
      appearance,
    })

    return actions.save({ type: 'scene.upsertGraphic', sceneId: value('graphic-scene'), component })
  })
  on('graphic-remove', 'click', () =>
    actions.save({
      type: 'scene.removeGraphic',
      sceneId: value('graphic-scene'),
      componentId: value('graphic-existing'),
    }),
  )

  for (const id of ['asset-image', 'asset-palettes', 'asset-definition', 'asset-graphic'])
    on(id, 'input', (event) => {
      if (
        event.target instanceof HTMLElement &&
        ['graphic-scene', 'graphic-existing'].includes(event.target.id)
      )
        return

      if (id === 'asset-palettes' && event.target instanceof HTMLSelectElement) return
      dirty.add(id)

      if (id === 'asset-graphic') {
        find<HTMLSelectElement>('graphic-scene').disabled = true
        find<HTMLSelectElement>('graphic-existing').disabled = true
      }

      if (id === 'asset-definition' || id === 'asset-palettes')
        find<HTMLSelectElement>('asset-select').disabled = true
    })

  for (const node of panel.querySelectorAll<HTMLElement>('[data-i18n]'))
    node.textContent = t(node.dataset.i18n!)

  for (const control of panel.querySelectorAll<
    HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement
  >('input, button, select, textarea'))
    control.disabled = true

  return {
    hasDrafts: () => dirty.size > 0,
    navigate(kind: string, id?: string, sceneId?: string) {
      const nextKey = `${kind}:${sceneId ?? ''}:${id ?? ''}`
      const changing = nextKey !== navigationKey
      navigationKey = nextKey
      const graphic = kind === 'component' || kind === 'new-graphic'
      const browsing = ['section', 'images', 'parts', 'compositions'].includes(kind)
      find('asset-gallery').hidden = !browsing
      browsingKind = browsing ? kind : ''

      for (const thumbnail of panel.querySelectorAll<HTMLElement>('.asset-thumbnail'))
        thumbnail.hidden = kind !== 'section' && thumbnail.dataset.assetKind !== kind
      showEmptyState()
      find('asset-workshop').hidden = kind !== 'asset'
      find('asset-image').hidden =
        kind !== 'import' && !(kind === 'asset' && id && catalog().images[id])
      const definition = find('asset-definition').parentElement!
      definition.hidden = kind !== 'asset' && kind !== 'new-asset'
      definition.toggleAttribute('open', kind === 'new-asset')
      find('asset-graphic').hidden = !graphic

      if (kind === 'asset' && id && (changing || selected !== id)) {
        selected = id
        set('asset-select', id)
        appearance = graphicAppearanceSchema.parse({})
        fillSelection(false)
      }

      if (changing && kind === 'import' && !dirty.has('asset-image'))
        find<HTMLFormElement>('asset-image').reset()

      if (changing && kind === 'new-asset' && !dirty.has('asset-definition')) {
        set('asset-definition-id', '')
        set('asset-json', '{}')
      }

      if (graphic && sceneId && !dirty.has('asset-graphic')) {
        set('graphic-scene', sceneId)
        fillGraphics()
        set('graphic-existing', kind === 'component' ? (id ?? '') : '')
        fillGraphics()
      }
    },
    render(next: ProjectEditorState, replace: boolean) {
      state = next

      if (controlLanguage !== t('assets.defaults')) {
        controlLanguage = t('assets.defaults')
        renderColors()
        renderSlotControls()
      }

      const requestedSelection =
        submittedForm === 'asset-image'
          ? value('asset-image-id')
          : submittedForm === 'asset-definition'
            ? value('asset-definition-id')
            : ''

      for (const node of panel.querySelectorAll<HTMLElement>('[data-i18n]'))
        node.textContent = t(node.dataset.i18n!)

      if (replace) {
        if (!next.preserveDrafts) dirty.clear()
        else if (
          submittedForm &&
          (next.lastCommand?.startsWith('assets.') ||
            next.lastCommand === 'scene.upsertGraphic' ||
            next.lastCommand === 'scene.removeGraphic')
        ) {
          dirty.delete(submittedForm)

          if (submittedForm === 'asset-image') set('asset-file', '')
          submittedForm = undefined
        }
      }

      for (const control of panel.querySelectorAll<
        HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement
      >('input, button, select, textarea'))
        control.disabled = next.busy || !next.view?.game
      find<HTMLSelectElement>('asset-select').disabled ||=
        dirty.has('asset-definition') || dirty.has('asset-palettes')
      find<HTMLSelectElement>('graphic-scene').disabled ||= dirty.has('asset-graphic')
      find<HTMLSelectElement>('graphic-existing').disabled ||= dirty.has('asset-graphic')

      if (!replace || !next.view) return
      const definitions = catalog()

      const visuals = [
        ...Object.keys(definitions.images),
        ...Object.keys(definitions.parts),
        ...Object.keys(definitions.compositions),
      ]

      const entries: [string, string][] = visuals.map((id) => [id, id])
      selectOptions('asset-select', entries)

      if (requestedSelection && visuals.includes(requestedSelection))
        set('asset-select', requestedSelection)
      selectOptions('graphic-visual', entries)
      selected = value('asset-select')
      selectOptions(
        'graphic-scene',
        next.view.scenes.map((scene) => [scene.id, scene.title]),
      )

      if (resourceRevision !== `${next.path}:${next.view.revision}`) {
        preview?.dispose()

        for (const thumbnail of thumbnails) thumbnail.dispose()
        thumbnails = []
        resources?.dispose()
        resources = new BrowserGraphicResources(
          new EditorWorkspaceResources(next.path, fetcher),
          createGraphicPlatform(document),
        )
        resourceRevision = `${next.path}:${next.view.revision}`
        const gallery = find('asset-gallery')
        gallery.replaceChildren()

        for (const id of visuals) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'asset-thumbnail'
          button.dataset.assetKind = kindOf(id)
          button.setAttribute('aria-label', id)

          const thumbnail = renderer.render(makeGraphic(id), {
            document,
            assets: definitions,
            graphics: resources,
            bindingMode: 'editor',
          })

          thumbnails.push(thumbnail)
          const caption = document.createElement('span')
          caption.textContent = id
          button.append(thumbnail.element, caption)
          button.addEventListener('click', () => {
            if (onSelectAsset) {
              onSelectAsset(id)

              return
            }

            if (dirty.has('asset-definition') || dirty.has('asset-palettes')) return
            selected = id
            set('asset-select', id)
            appearance = graphicAppearanceSchema.parse({})
            fillSelection(false)
          })
          gallery.append(button)
        }
      }

      if (!dirty.has('asset-palettes')) appearance = graphicAppearanceSchema.parse({})
      fillSelection(false)
      fillGraphics()
      showEmptyState()
    },
    dispose() {
      abort.abort()
      preview?.dispose()

      for (const thumbnail of thumbnails) thumbnail.dispose()
      resources?.dispose()
    },
  }
}
