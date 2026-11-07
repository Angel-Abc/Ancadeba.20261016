import { bindLevelingEditor } from './levelingEditor.js'
import type { ProjectView, EditorCommand, ProjectChoice } from '@ancadeba/editor-core'
import { HttpEditorClient } from './editorClient.js'
import { ProjectEditorController, type ProjectEditorListener } from './projectController.js'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import { bindAssetsPanel } from './assetsPanel.js'
import { bindProjectTree } from './projectTreeView.js'
import { bindRulesPanel } from './rulesPanel.js'
import { bindActionBarPanel } from './actionBarPanel.js'
import { bindStatusPanelEditor } from './statusPanelEditor.js'
import { bindItemEditor } from './itemEditor.js'
import { bindShopEditor } from './shopEditor.js'
import { bindCombatEditor } from './combatEditor.js'
import { bindSectionRail } from './sectionRail.js'
import { bindComponentEditor, editableComponentTypes } from './componentEditor.js'
import {
  buildProjectTree,
  dataFilesSection,
  flattenProjectTree,
  ruleFileNodes,
  sceneTitle,
  projectTreeSections,
  type ProjectTreeNode,
  type ProjectTreeSection,
} from './projectTree.js'

export interface ProjectWorkspaceSection extends ProjectTreeSection {
  canSelect?(node: ProjectTreeNode): boolean
  show(node: ProjectTreeNode, view: ProjectView | undefined): void
  hide(): void
}

export function bindProjectPanel(
  root: HTMLElement,
  fetcher: typeof fetch,
  t: Translate = editorLocalization().t,
  subscribeLanguageChanges?: (listener: () => void) => () => void,
  {
    additionalSections = [],
    onProjectChange,
    onSceneSelect,
  }: {
    additionalSections?: readonly ProjectWorkspaceSection[]
    onProjectChange?: (path: string) => void
    /** Reports the scene of the explorer selection, or undefined outside the scenes section. */
    onSceneSelect?: (scene: { id: string; title: string } | undefined) => void
  } = {},
): () => void {
  const find = <T extends HTMLElement>(id: string): T => {
    const element = root.querySelector<T>(`#${id}`)

    if (!element) throw new Error(`Missing editor element: ${id}`)

    return element
  }

  const folder = find<HTMLSelectElement>('editor-folder')
  const load = find<HTMLButtonElement>('editor-load')
  const reload = find<HTMLButtonElement>('editor-reload')
  const metadata = find<HTMLFormElement>('editor-metadata')
  const layout = find<HTMLFormElement>('scene-layout')
  const sceneMetadata = find<HTMLFormElement>('scene-metadata')
  const create = find<HTMLFormElement>('scene-create')
  const scenes = find<HTMLSelectElement>('editor-scenes')
  const fields = find<HTMLFieldSetElement>('editor-fields')
  const status = find<HTMLElement>('editor-status')
  const error = find<HTMLElement>('editor-error')
  const header = find<HTMLElement>('editor-header')
  const workspace = find<HTMLElement>('editor-workspace')
  const openControls = find<HTMLFormElement>('project-open-controls')
  const openToggle = find<HTMLButtonElement>('project-open-toggle')
  const openFeedback = find<HTMLElement>('project-open-feedback')
  const value = (id: string) => find<HTMLInputElement>(id).value

  const showOpenControls = (show: boolean) => {
    openControls.hidden = !show
    openToggle.setAttribute('aria-expanded', String(show))
  }

  const set = (id: string, text: string | number) => {
    find<HTMLInputElement>(id).value = String(text)
  }

  let view: ProjectView | undefined
  const dirtyForms = new Set<string>()
  let loadedPath = ''
  let busy = false
  let openingProject = false
  let openError = ''
  let discoveryError: string | undefined
  let discovery: AbortController | undefined
  let projectChoices: ProjectChoice[] = []
  const client = new HttpEditorClient(fetcher)
  let assetsPanel: ReturnType<typeof bindAssetsPanel> | undefined
  let tree: ReturnType<typeof bindProjectTree> | undefined

  const renderOpenControls = () => {
    const disabled = busy || Boolean(discovery) || !projectChoices.length
    folder.disabled = disabled
    load.disabled = disabled

    let message = openError

    if (discovery) message = t('project.discovering')
    else if (openingProject) message = t('project.working')
    else if (discoveryError) message = t('project.listError', { message: discoveryError })
    else if (!projectChoices.length) message = t('project.emptyList')

    openFeedback.textContent = message
    openFeedback.hidden = !message
  }

  const renderProjectChoices = (preferredPath: string) => {
    folder.replaceChildren(
      ...projectChoices.map(({ path, title }) => {
        const option = root.ownerDocument.createElement('option')
        const location = path || t('workspace.root')
        option.value = path
        option.textContent = title && title !== location ? `${title} (${location})` : location

        return option
      }),
    )
    folder.value = projectChoices.some(({ path }) => path === preferredPath)
      ? preferredPath
      : (projectChoices[0]?.path ?? '')
  }

  const refreshProjects = async (focus = false) => {
    discovery?.abort()
    const request = new AbortController()
    discovery = request
    discoveryError = undefined
    openError = ''
    renderOpenControls()

    try {
      const choices = await client.listProjects(request.signal)

      if (!request.signal.aborted) projectChoices = choices
    } catch (error) {
      if (!request.signal.aborted) {
        discoveryError = error instanceof Error ? error.message : String(error)
      }
    }

    if (request.signal.aborted) return

    discovery = undefined
    renderProjectChoices(loadedPath)
    renderOpenControls()

    if (focus && !openControls.hidden && root.ownerDocument.activeElement === openToggle) {
      folder.focus()
    }
  }

  let selection: ProjectTreeNode = {
    key: 'game',
    section: 'game',
    kind: 'section',
    label: t('project.properties'),
  }

  let assetTarget = ''
  const treeElement = root.querySelector<HTMLElement>('#project-tree')
  const rulesElement = treeElement && root.querySelector<HTMLElement>('#rules-panel')
  const actionBarElement = treeElement && root.querySelector<HTMLElement>('#action-bar-panel')
  const statusPanelElement = treeElement && root.querySelector<HTMLElement>('#status-panel-editor')
  let rulesPanel: ReturnType<typeof bindRulesPanel> | undefined
  let actionBarPanel: ReturnType<typeof bindActionBarPanel> | undefined
  let statusPanel: ReturnType<typeof bindStatusPanelEditor> | undefined
  const itemElement = treeElement && root.querySelector<HTMLElement>('#item-editor')
  let itemEditor: ReturnType<typeof bindItemEditor> | undefined
  const shopElement = treeElement && root.querySelector<HTMLElement>('#shop-editor')
  let shopEditor: ReturnType<typeof bindShopEditor> | undefined
  const levelingElement = treeElement && root.querySelector<HTMLElement>('#leveling-editor')
  let levelingEditor: ReturnType<typeof bindLevelingEditor> | undefined
  const combatElement = treeElement && root.querySelector<HTMLElement>('#combat-editor')
  let combatEditor: ReturnType<typeof bindCombatEditor> | undefined
  const componentElement = treeElement && root.querySelector<HTMLElement>('#component-editor')
  let componentEditor: ReturnType<typeof bindComponentEditor> | undefined
  const railElement = treeElement && root.querySelector<HTMLElement>('#section-rail')
  let rail: ReturnType<typeof bindSectionRail> | undefined

  const sections = [
    ...projectTreeSections,
    ...(rulesElement ? [{ id: 'rules', labelKey: 'rules.heading', nodes: ruleFileNodes }] : []),
    ...(actionBarElement
      ? [{ id: 'controls', labelKey: 'controls.heading', nodes: () => [] }]
      : []),
    ...(statusPanelElement ? [{ id: 'status', labelKey: 'status.heading', nodes: () => [] }] : []),
    ...(itemElement ? [{ id: 'items', labelKey: 'items.heading', nodes: () => [] }] : []),
    ...(shopElement ? [{ id: 'shops', labelKey: 'shops.heading', nodes: () => [] }] : []),
    ...(levelingElement ? [{ id: 'leveling', labelKey: 'leveling.heading', nodes: () => [] }] : []),
    ...(combatElement ? [{ id: 'combat', labelKey: 'combat.heading', nodes: () => [] }] : []),
    ...(treeElement ? [dataFilesSection] : []),
    ...additionalSections,
  ]

  const showSelection = () => {
    if (!treeElement) return

    const node = selection

    const sceneId =
      node.section === 'scenes' ? (node.kind === 'scene' ? node.id : node.parentId) : undefined

    // Scenes and components can share an ID, so only component rows resolve a component.
    const component =
      node.kind === 'component'
        ? view?.scenes
            .find((scene) => scene.id === sceneId)
            ?.components.find((component) => component.id === node.id)
        : undefined

    const dataFile =
      node.kind === 'map'
        ? view?.maps?.[node.id ?? '']
        : node.kind === 'inventory-file'
          ? view?.inventoryFiles?.[node.id ?? '']
          : undefined

    const graphic =
      node.section === 'scenes' && (node.kind === 'new-graphic' || component?.type === 'graphic')

    const actionBar = Boolean(actionBarElement && component?.type === 'action-bar')

    const levelingComponent = Boolean(
      levelingElement && component?.type === 'character-progression',
    )

    const combatComponent = Boolean(combatElement && component?.type === 'combat')
    const shopComponent = Boolean(shopElement && component?.type === 'shop')
    const statusComponent = Boolean(statusPanelElement && component?.type === 'status-panel')

    const editableComponent = Boolean(
      componentElement && component && editableComponentTypes.includes(component.type),
    )

    const itemComponent = Boolean(
      itemElement &&
      component &&
      ['item-details', 'equipment', 'inventory'].includes(component.type),
    )

    metadata.hidden = node.section !== 'game'
    sceneMetadata.hidden =
      node.kind !== 'scene' || !view?.scenes.some((scene) => scene.id === sceneId)
    layout.hidden = sceneMetadata.hidden
    create.hidden = node.section !== 'scenes' || !['section', 'new-scene'].includes(node.kind)
    fields.hidden = metadata.hidden && sceneMetadata.hidden && create.hidden
    find('assets-panel').hidden = node.section !== 'assets' && !graphic

    if (rulesElement) rulesElement.hidden = node.section !== 'rules'

    if (actionBarElement) actionBarElement.hidden = node.section !== 'controls' && !actionBar

    if (statusPanelElement)
      statusPanelElement.hidden = node.section !== 'status' && !statusComponent

    if (levelingElement) levelingElement.hidden = node.section !== 'leveling' && !levelingComponent

    if (levelingComponent)
      levelingEditor?.navigate(
        sceneId,
        component?.type === 'character-progression' ? component.profile : undefined,
      )

    if (combatElement) combatElement.hidden = node.section !== 'combat' && !combatComponent

    if (combatComponent)
      combatEditor?.navigate(
        sceneId,
        component?.type === 'combat' ? component.encounter : undefined,
      )

    if (shopElement) shopElement.hidden = node.section !== 'shops' && !shopComponent

    if (shopComponent) shopEditor?.navigate(sceneId)

    if (itemElement) itemElement.hidden = node.section !== 'items' && !itemComponent

    if (itemComponent) itemEditor?.navigate(sceneId, component?.id)

    if (actionBar) actionBarPanel?.navigate(sceneId)

    if (statusComponent) statusPanel?.navigate(sceneId, component?.id)

    if (componentElement) componentElement.hidden = !editableComponent

    // Opened from a component, an editor's own scene and target pickers repeat the explorer.
    for (const element of [
      actionBarElement,
      statusPanelElement,
      itemElement,
      shopElement,
      combatElement,
      levelingElement,
    ])
      element?.setAttribute('data-scope', node.kind === 'component' ? 'component' : 'section')

    if (editableComponent) componentEditor?.navigate(sceneId, component?.id)
    find('component-details').hidden =
      !dataFile &&
      (node.section !== 'scenes' ||
        node.kind !== 'component' ||
        graphic ||
        actionBar ||
        statusComponent ||
        itemComponent ||
        shopComponent ||
        combatComponent ||
        levelingComponent ||
        editableComponent)
    find('component-help').textContent = t(dataFile ? 'tree.readOnlyFile' : 'tree.readOnly')
    find('component-json').textContent = dataFile
      ? JSON.stringify(dataFile, null, 2)
      : component && !graphic
        ? JSON.stringify(component, null, 2)
        : ''

    const sectionLabel = t(
      sections.find((section) => section.id === node.section)?.labelKey ?? node.label,
    )

    // The eyebrow names where the selection lives; top-level sections belong to the project.
    const parentScene = view?.scenes.find((scene) => scene.id === node.parentId)

    find('editor-heading').textContent =
      node.kind === 'section'
        ? t('project.heading')
        : [sectionLabel, parentScene && view ? sceneTitle(view, parentScene) : node.parentId]
            .filter(Boolean)
            .join(' › ')
    find('workspace-heading').textContent = node.kind === 'section' ? sectionLabel : node.label
    rail?.render(view ? node.section : undefined)

    const selectedScene = view?.scenes.find(
      (scene) => scene.id === (node.kind === 'scene' ? node.id : node.parentId),
    )

    onSceneSelect?.(
      selectedScene && view
        ? { id: selectedScene.id, title: sceneTitle(view, selectedScene) }
        : undefined,
    )

    for (const section of additionalSections) {
      if (section.id === node.section) section.show(node, view)
      else section.hide()
    }
  }

  const navigate = (node: ProjectTreeNode) => {
    const sceneId =
      node.section === 'scenes' ? (node.kind === 'scene' ? node.id : node.parentId) : undefined

    const sceneChanges = sceneId && sceneId !== scenes.value

    const componentType =
      node.kind === 'component'
        ? view?.scenes
            .find((scene) => scene.id === sceneId)
            ?.components.find((component) => component.id === node.id)?.type
        : undefined

    const usesAssets =
      node.section === 'assets' ||
      (node.section === 'scenes' && (node.kind === 'new-graphic' || componentType === 'graphic'))

    const usesActionBar = Boolean(
      actionBarElement && (node.section === 'controls' || componentType === 'action-bar'),
    )

    const usesStatusPanel = Boolean(
      statusPanelElement && (node.section === 'status' || componentType === 'status-panel'),
    )

    if (
      (sceneChanges && (dirtyForms.has(sceneMetadata.id) || dirtyForms.has(layout.id))) ||
      ((node.section === 'items' ||
        ['item-details', 'equipment', 'inventory'].includes(componentType ?? '')) &&
        !itemEditor?.navigate(sceneId, node.section === 'scenes' ? node.id : undefined)) ||
      ((node.section === 'shops' || componentType === 'shop') && !shopEditor?.navigate(sceneId)) ||
      ((node.section === 'leveling' || componentType === 'character-progression') &&
        !levelingEditor?.navigate(sceneId)) ||
      ((node.section === 'combat' || componentType === 'combat') &&
        !combatEditor?.navigate(sceneId)) ||
      (node.kind === 'rule-file' && !rulesPanel?.navigate(node.id ?? '')) ||
      (componentElement &&
        editableComponentTypes.includes(componentType ?? '') &&
        !componentEditor?.navigate(sceneId, node.id)) ||
      (usesAssets && assetTarget !== node.key && assetsPanel?.hasDrafts()) ||
      (usesActionBar && !actionBarPanel?.navigate(sceneId)) ||
      (usesStatusPanel &&
        !statusPanel?.navigate(sceneId, node.section === 'scenes' ? node.id : undefined)) ||
      additionalSections.find((section) => section.id === node.section)?.canSelect?.(node) === false
    ) {
      find('tree-message').textContent = t('tree.saveFirst')

      return false
    }

    find('tree-message').textContent = ''

    if (sceneId) {
      scenes.value = sceneId
      fillScene()
    }

    selection = node

    if (usesAssets) {
      assetTarget = node.key
      assetsPanel?.navigate(node.kind, node.id, sceneId)
    }

    showSelection()

    return true
  }

  /** A translated title makes the literal title an optional fallback, so an empty field is valid. */
  const showTitleSource = (id: string, titleKey: string | undefined) => {
    const input = find<HTMLInputElement>(id)
    input.required = !titleKey
    input.placeholder = titleKey ? t('metadata.titleFromKey', { key: titleKey }) : ''
  }

  const fillScene = () => {
    const scene = view?.scenes.find((scene) => scene.id === scenes.value)
    sceneMetadata.hidden = !scene
    layout.hidden = !scene

    if (!scene) return

    showTitleSource('scene-title', scene.titleKey)

    if (!dirtyForms.has(sceneMetadata.id)) {
      set('scene-title', scene.title)
      set('scene-description', scene.description)
    }

    if (!dirtyForms.has(layout.id)) {
      set('scene-rows', scene.screen.grid.rows)
      set('scene-columns', scene.screen.grid.columns)
    }
  }

  let refreshLanguage = () => {}

  const render: ProjectEditorListener = (state, replaceFields) => {
    assetsPanel?.render(state, replaceFields)
    rulesPanel?.render(state, replaceFields)
    actionBarPanel?.render(state, replaceFields)
    statusPanel?.render(state, replaceFields)
    itemEditor?.render(state, replaceFields)
    shopEditor?.render(state, replaceFields)
    combatEditor?.render(state, replaceFields)
    levelingEditor?.render(state, replaceFields)
    componentEditor?.render(state, replaceFields)
    refreshLanguage = () => render(state, false)
    const projectChanged = state.view && (!view || state.path !== loadedPath)
    view = state.view
    loadedPath = state.path

    const ruleChange =
      replaceFields &&
      (state.lastCommand === 'game.updateRules' ||
        state.lastCommand === 'scene.upsertRuleButton' ||
        state.lastCommand === 'inventory.setRuleInspection' ||
        state.lastCommand === 'inventory.setItemActions' ||
        state.lastCommand === 'scene.upsertNearby' ||
        state.lastCommand === 'game.upsertCombat' ||
        state.lastCommand === 'game.removeCombat' ||
        state.lastCommand === 'scene.setCombat' ||
        state.lastCommand === 'scene.upsertShop' ||
        state.lastCommand === 'scene.removeShop' ||
        state.lastCommand === 'inventory.setItemPresentation' ||
        state.lastCommand === 'inventory.setEquipmentSlots' ||
        state.lastCommand === 'scene.setInventoryDetails' ||
        state.lastCommand === 'scene.upsertItemView' ||
        state.lastCommand === 'scene.removeItemView' ||
        state.lastCommand === 'scene.upsertStatusPanel' ||
        state.lastCommand === 'scene.removeStatusPanel' ||
        state.lastCommand === 'scene.setActionBar' ||
        state.lastCommand === 'scene.upsertComponent' ||
        state.lastCommand === 'game.updateInput')

    if (projectChanged || ruleChange) onProjectChange?.(loadedPath)

    busy = state.busy
    reload.disabled = state.busy || !view
    reload.hidden = !view
    scenes.disabled = dirtyForms.has(sceneMetadata.id) || dirtyForms.has(layout.id)
    fields.disabled = state.busy || !view?.game || Boolean(view.diagnostics.length)
    status.textContent = state.busy
      ? t('project.working')
      : state.conflict
        ? t('project.conflict')
        : state.changedElsewhere
          ? t('project.changed')
          : view
            ? t('project.loaded', {
                title: view.game
                  ? view.game.title || state.path || t('workspace.root')
                  : t('project.withErrors'),
                path: state.path || t('workspace.root'),
              })
            : ''
    error.textContent =
      state.error ||
      view?.diagnostics
        .map(
          (diagnostic) => `${diagnostic.file} ${diagnostic.path.join('.')}: ${diagnostic.message}`,
        )
        .join('\n') ||
      ''
    error.hidden = !error.textContent
    header.hidden = !view
    workspace.hidden = !view
    find('project-title').textContent = view
      ? view.game?.title || state.path || t('workspace.root')
      : ''

    if (view?.game) showTitleSource('editor-title', view.game.titleKey)

    const shownScene = view?.scenes.find((scene) => scene.id === scenes.value)

    if (shownScene) showTitleSource('scene-title', shownScene.titleKey)

    if (openingProject && !state.busy) {
      openingProject = false

      if (replaceFields) {
        showOpenControls(false)
        openToggle.focus()
      } else {
        openError = state.error
      }
    }

    renderOpenControls()

    const updateTree = () => {
      if (!tree) return

      if (
        replaceFields &&
        state.lastCommand === 'scene.setActionBar' &&
        selection.section === 'scenes' &&
        selection.kind === 'component' &&
        !view?.scenes
          .find((scene) => scene.id === selection.parentId)
          ?.components.some((component) => component.id === selection.id)
      )
        selection = {
          key: 'controls',
          section: 'controls',
          kind: 'section',
          label: t('controls.heading'),
        }

      const updated =
        view &&
        flattenProjectTree(buildProjectTree(view, t, sections)).find(
          (node) => node.key === selection.key,
        )

      if (updated) selection = updated
      showSelection()
      tree.render(view, state.busy, selection.key)
    }

    if (!replaceFields || !view?.game) {
      updateTree()

      return
    }

    const formCommands: Partial<Record<EditorCommand['type'], string>> = {
      'game.updateMetadata': metadata.id,
      'scene.updateMetadata': sceneMetadata.id,
      'scene.updateLayout': layout.id,
      'scene.create': create.id,
    }

    const savedForm = state.lastCommand ? formCommands[state.lastCommand] : undefined

    if (savedForm) dirtyForms.delete(savedForm)
    else if (!state.preserveDrafts) dirtyForms.clear()

    if (treeElement && !dirtyForms.size && !assetsPanel?.hasDrafts())
      find('tree-message').textContent = ''

    if (!dirtyForms.has(create.id)) create.reset()
    scenes.disabled = dirtyForms.has(sceneMetadata.id) || dirtyForms.has(layout.id)

    if (!dirtyForms.has(metadata.id)) {
      set('editor-title', view.game.title)
      set('editor-description', view.game.description)
      set('editor-version', view.game.version)
    }

    const selected = scenes.value
    scenes.replaceChildren(
      ...view.scenes.map((scene) => {
        const option = root.ownerDocument.createElement('option')
        option.value = scene.id
        option.textContent = `${scene.title} (${scene.id})`

        return option
      }),
    )

    if (
      selected &&
      !view.scenes.some((scene) => scene.id === selected) &&
      (dirtyForms.has(sceneMetadata.id) || dirtyForms.has(layout.id))
    ) {
      // A reload must never attach a removed scene's draft to another scene.
      const missing = root.ownerDocument.createElement('option')
      missing.value = selected
      missing.textContent = t('project.unavailableScene', { id: selected })
      scenes.append(missing)
      scenes.value = selected
      status.textContent = t('project.missingScene')
    }

    if (view.scenes.some((scene) => scene.id === selected)) scenes.value = selected
    fillScene()

    if (treeElement && !state.preserveDrafts) {
      assetTarget = ''

      if (
        state.lastCommand === null &&
        !view.scenes.some(
          (scene) => scene.id === selection.id || scene.id === selection.parentId,
        ) &&
        selection.section === 'scenes'
      )
        selection = {
          key: 'game',
          section: 'game',
          kind: 'section',
          label: t('project.properties'),
        }
    }

    if (
      selection.section === 'assets' ||
      (selection.section === 'scenes' &&
        (selection.kind === 'component' || selection.kind === 'new-graphic'))
    )
      assetsPanel?.navigate(selection.kind, selection.id, selection.parentId)
    updateTree()
  }

  const controller = new ProjectEditorController(client, render)

  if (rulesElement)
    rulesPanel = bindRulesPanel(rulesElement, (command) => {
      void controller.save(command)
    })

  if (actionBarElement)
    actionBarPanel = bindActionBarPanel(actionBarElement, (command) => {
      void controller.save(command)
    })

  if (statusPanelElement)
    statusPanel = bindStatusPanelEditor(statusPanelElement, (command) => {
      void controller.save(command)
    })

  if (levelingElement)
    levelingEditor = bindLevelingEditor(levelingElement, (command) => {
      void controller.save(command)
    })

  if (combatElement)
    combatEditor = bindCombatEditor(combatElement, (command) => {
      void controller.save(command)
    })

  if (shopElement)
    shopEditor = bindShopEditor(shopElement, (command) => {
      void controller.save(command)
    })

  if (itemElement)
    itemEditor = bindItemEditor(itemElement, (command) => {
      void controller.save(command)
    })

  if (componentElement)
    componentEditor = bindComponentEditor(componentElement, (command) => {
      void controller.save(command)
    })
  assetsPanel = bindAssetsPanel(
    root,
    {
      save: (command) => controller.save(command),
      importAsset: (id, format, file) => controller.importAsset(id, format, file),
    },
    fetcher,
    t,
    (id) => tree?.select(`asset:${id}`),
    (key) => tree?.select(key),
  )

  if (treeElement) {
    tree = bindProjectTree(
      treeElement,
      find<HTMLInputElement>('project-search'),
      navigate,
      t,
      sections,
    )

    if (railElement)
      rail = bindSectionRail(railElement, sections, t, (sectionId) => tree?.select(sectionId))
    tree.render(undefined, false)
    showSelection()
  }

  const unsubscribeLanguage = subscribeLanguageChanges?.(() => {
    refreshLanguage()
    renderProjectChoices(folder.value)
    renderOpenControls()
  })

  const listeners: (() => void)[] = []

  const on = (element: EventTarget, event: string, listener: EventListener) => {
    element.addEventListener(event, listener)
    listeners.push(() => element.removeEventListener(event, listener))
  }

  on(openToggle, 'click', () => {
    const show = Boolean(openControls.hidden)
    showOpenControls(show)

    if (show) void refreshProjects(true)
  })
  on(folder, 'keydown', (event) => {
    if (!('key' in event) || event.key !== 'Enter') return

    event.preventDefault()
    openControls.requestSubmit()
  })
  on(openControls, 'submit', (event) => {
    event.preventDefault()

    if (load.disabled || !projectChoices.some(({ path }) => path === folder.value)) return

    openingProject = true
    openError = ''
    void controller.load(folder.value)
  })

  const hasDrafts = () =>
    dirtyForms.size > 0 ||
    Boolean(
      assetsPanel?.hasDrafts() ||
      rulesPanel?.hasDrafts() ||
      actionBarPanel?.hasDrafts() ||
      statusPanel?.hasDrafts() ||
      itemEditor?.hasDrafts() ||
      shopEditor?.hasDrafts() ||
      combatEditor?.hasDrafts() ||
      levelingEditor?.hasDrafts() ||
      componentEditor?.hasDrafts(),
    )

  on(reload, 'click', () => {
    void controller.load(loadedPath, hasDrafts())
  })

  for (const form of [metadata, sceneMetadata, layout, create]) {
    on(form, 'input', () => {
      dirtyForms.add(form.id)
      scenes.disabled = dirtyForms.has(sceneMetadata.id) || dirtyForms.has(layout.id)
    })
  }

  on(scenes, 'change', () => {
    fillScene()
  })

  const submit = (form: HTMLFormElement, action: () => void) =>
    on(form, 'submit', (event) => {
      event.preventDefault()
      action()
    })

  submit(metadata, () => {
    void controller.save({
      type: 'game.updateMetadata',
      title: value('editor-title'),
      description: value('editor-description'),
      version: value('editor-version'),
    })
  })
  submit(sceneMetadata, () => {
    void controller.save({
      type: 'scene.updateMetadata',
      sceneId: scenes.value,
      title: value('scene-title'),
      description: value('scene-description'),
    })
  })
  submit(layout, () => {
    void controller.save({
      type: 'scene.updateLayout',
      sceneId: scenes.value,
      rows: Number(value('scene-rows')),
      columns: Number(value('scene-columns')),
    })
  })
  submit(create, () => {
    void controller.save({
      type: 'scene.create',
      scene: {
        'schema-version': '1.0.0',
        id: value('new-scene-id'),
        title: value('new-scene-title'),
        description: '',
        type: find<HTMLSelectElement>('new-scene-type').value === 'game' ? 'game' : 'stand-alone',
        screen: {
          type: 'grid',
          grid: {
            rows: Number(value('new-scene-rows')),
            columns: Number(value('new-scene-columns')),
          },
        },
        components: [],
      },
    })
  })
  on(root.ownerDocument.defaultView!, 'focus', () => {
    void controller.refresh(hasDrafts)
  })

  void refreshProjects()

  return () => {
    discovery?.abort()
    controller.dispose()
    assetsPanel?.dispose()
    tree?.dispose()
    rail?.dispose()
    unsubscribeLanguage?.()

    for (const remove of listeners) remove()
  }
}
