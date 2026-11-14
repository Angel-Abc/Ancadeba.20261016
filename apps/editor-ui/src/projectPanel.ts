import { bindLevelingEditor } from './levelingEditor.js'
import { z } from 'zod'
import {
  registerEditorDraft,
  captureEditorDrafts,
  restoreEditorDrafts,
} from './editorDraftState.js'
import { EditorDraftStore, type EditorDraftStorage } from './editorDraftStore.js'
import { bindEditorDraftRecovery } from './editorDraftRecovery.js'
import { bindLocalizationEditor } from './localizationEditor.js'
import { bindMapEditor } from './mapEditor.js'
import { mapConfirmation } from './mapConfirmation.js'
import {
  BrowserGraphicResources,
  createGraphicPlatform,
  mountGameStylesheet,
} from '@ancadeba/ui-components'
import { EditorWorkspaceResources, normalizeGameFolder } from './workspaceResources.js'
import type { ProjectView, EditorCommand, ProjectChoice } from '@ancadeba/editor-core'
import { createProjectRequestSchema, duplicateProjectRequestSchema } from '@ancadeba/editor-core'
import { HttpEditorClient } from './editorClient.js'
import { ProjectEditorController, type ProjectEditorListener } from './projectController.js'
import type { Translate } from '@ancadeba/utilities'
import { editorLocalization } from './localization.js'
import { bindAssetsPanel } from './assetsPanel.js'
import { bindProjectTree } from './projectTreeView.js'
import { bindRulesPanel } from './rulesPanel.js'
import { bindStoryEditor } from './storyEditor.js'
import { bindActionBarPanel } from './actionBarPanel.js'
import { bindStatusPanelEditor } from './statusPanelEditor.js'
import { bindItemEditor } from './itemEditor.js'
import { bindShopEditor } from './shopEditor.js'
import { bindCombatEditor } from './combatEditor.js'
import { bindSectionRail } from './sectionRail.js'
import { bindComponentEditor, editableComponentTypes } from './componentEditor.js'
import { bindSceneControls } from './sceneControls.js'
import { bindComponentClipboard } from './componentClipboard.js'
import { bindEditorShortcuts } from './editorShortcuts.js'
import { bindMetadataTranslations } from './metadataTranslations.js'
import { bindStylesheetEditor } from './stylesheetEditor.js'
import { bindProjectRepair } from './projectRepair.js'
import {
  buildProjectTree,
  dataFileContent,
  dataFilesSection,
  flattenProjectTree,
  ruleFileNodes,
  mapFileNodes,
  sceneTitle,
  gameTitle,
  projectTreeSections,
  type ProjectTreeNode,
  type ProjectTreeSection,
} from './projectTree.js'

export interface ProjectWorkspaceSection extends ProjectTreeSection {
  canSelect?(node: ProjectTreeNode): boolean
  show(node: ProjectTreeNode, view: ProjectView | undefined): void
  hide(): void
}

export interface ProjectPanelBinding {
  hasDrafts(): boolean
  dispose(): void
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
    confirmDiscardDrafts = () =>
      root.ownerDocument.defaultView?.confirm(t('project.discardDrafts')) ?? false,
    confirmDelete = (message: string) => root.ownerDocument.defaultView?.confirm(message) ?? false,
    draftStorage = () => root.ownerDocument.defaultView?.localStorage,
  }: {
    additionalSections?: readonly ProjectWorkspaceSection[]
    onProjectChange?: (path: string) => void
    /** Reports the scene of the explorer selection, or undefined outside the scenes section. */
    onSceneSelect?: (scene: { id: string; title: string } | undefined) => void
    confirmDiscardDrafts?: () => boolean
    confirmDelete?: (message: string) => boolean
    draftStorage?: () => EditorDraftStorage | undefined
  } = {},
): ProjectPanelBinding {
  const find = <T extends HTMLElement>(id: string): T => {
    const element = root.querySelector<T>(`#${id}`)

    if (!element) throw new Error(`Missing editor element: ${id}`)

    return element
  }

  const folder = find<HTMLSelectElement>('editor-folder')
  const load = find<HTMLButtonElement>('editor-load')
  const reload = find<HTMLButtonElement>('editor-reload')
  const undo = find<HTMLButtonElement>('editor-undo')
  const redo = find<HTMLButtonElement>('editor-redo')
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
  const newToggle = find<HTMLButtonElement>('project-new-toggle')
  const newForm = find<HTMLFormElement>('project-create-controls')
  const newFields = find<HTMLFieldSetElement>('project-create-fields')
  const newSubmit = find<HTMLButtonElement>('project-create-submit')
  const newCancel = find<HTMLButtonElement>('project-create-cancel')
  const newError = find<HTMLElement>('project-create-error')
  const duplicateToggle = find<HTMLButtonElement>('project-duplicate-toggle')
  const duplicateForm = find<HTMLFormElement>('project-duplicate-controls')
  const duplicateFields = find<HTMLFieldSetElement>('project-duplicate-fields')
  const duplicateSubmit = find<HTMLButtonElement>('project-duplicate-submit')
  const duplicateCancel = find<HTMLButtonElement>('project-duplicate-cancel')
  const duplicateError = find<HTMLElement>('project-duplicate-error')
  const recoverToggle = root.querySelector<HTMLButtonElement>('#project-recover-toggle')
  const recoverForm = root.querySelector<HTMLFormElement>('#project-recover-controls')
  const recoverFields = root.querySelector<HTMLFieldSetElement>('#project-recover-fields')
  const recoverFolder = root.querySelector<HTMLInputElement>('#project-recover-folder')
  const recoverCancel = root.querySelector<HTMLButtonElement>('#project-recover-cancel')
  const value = (id: string) => find<HTMLInputElement>(id).value

  const showOpenControls = (show: boolean) => {
    openControls.hidden = !show
    openToggle.setAttribute('aria-expanded', String(show))

    if (!show) {
      newForm.hidden = true
      newToggle.setAttribute('aria-expanded', 'false')
      duplicateForm.hidden = true
      duplicateToggle.setAttribute('aria-expanded', 'false')

      if (recoverForm) recoverForm.hidden = true
      recoverToggle?.setAttribute('aria-expanded', 'false')
    }
  }

  const set = (id: string, text: string | number) => {
    find<HTMLInputElement>(id).value = String(text)
  }

  let view: ProjectView | undefined
  const dirtyForms = new Set<string>()
  let loadedPath = ''
  let preferredScene: string | undefined
  let busy = false
  let historyBlocked = false
  let openingProject = false
  let creatingProject = false
  let duplicatingProject = false

  const projectTranslations = bindMetadataTranslations(root, 'editor', t, () => {
    dirtyForms.add(metadata.id)
  })

  const sceneTranslations = bindMetadataTranslations(root, 'scene', t, () => {
    dirtyForms.add(sceneMetadata.id)
    scenes.disabled = true
  })

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
    newToggle.disabled = busy
    duplicateToggle.disabled = busy || !view?.game || Boolean(view.diagnostics.length)
    duplicateFields.disabled = busy
    duplicateSubmit.disabled = duplicateToggle.disabled
    duplicateSubmit.textContent = t(
      duplicatingProject ? 'project.duplicating' : 'project.duplicate',
    )

    if (recoverToggle) recoverToggle.disabled = busy

    if (recoverFields) recoverFields.disabled = busy
    newFields.disabled = busy
    newSubmit.disabled = busy || Boolean(discovery)
    newSubmit.textContent = t(creatingProject ? 'project.creating' : 'project.create')

    let message = openError

    if (discovery) message = t('project.discovering')
    else if (openingProject) message = t('project.working')
    else if (discoveryError) message = t('project.listError', { message: discoveryError })
    else if (!projectChoices.length && !message) message = t('project.emptyList')

    openFeedback.textContent = message
    openFeedback.hidden = !message
  }

  const renderProjectChoices = (preferredPath: string) => {
    folder.replaceChildren(
      ...projectChoices.map(({ path, title, missingManifest }) => {
        const option = root.ownerDocument.createElement('option')
        const location = path || t('workspace.root')
        option.value = path
        option.textContent = title && title !== location ? `${title} (${location})` : location

        if (missingManifest) option.textContent = t('recovery.choice', { path: location })

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
  const storyElement = treeElement && root.querySelector<HTMLElement>('#story-editor')
  let storyEditor: ReturnType<typeof bindStoryEditor> | undefined
  const mapElement = treeElement && root.querySelector<HTMLElement>('#map-editor')
  const mapConfirm = mapElement ? mapConfirmation(root.ownerDocument, t) : undefined
  let mapEditor: ReturnType<typeof bindMapEditor> | undefined

  const mapHistory = () =>
    selection.section === 'maps' ||
    (selection.kind === 'data-file' && selection.parentId === 'maps')
      ? mapEditor?.draftHistory()
      : undefined

  const renderHistoryControls = () => {
    const local = mapHistory()
    undo.textContent = t('history.undo')
    redo.textContent = t('history.redo')

    if (local?.active) {
      undo.disabled = local.blocked || !local.canUndo
      redo.disabled = local.blocked || !local.canRedo
      undo.title = t('maps.undoDraft')
      redo.title = t('maps.redoDraft')
    } else {
      undo.disabled = busy || historyBlocked || !view?.history?.canUndo
      redo.disabled = busy || historyBlocked || !view?.history?.canRedo
      undo.title = view?.history?.undoLabel
        ? t('history.undoLabel', { change: view.history.undoLabel })
        : t('history.undo')
      redo.title = view?.history?.redoLabel
        ? t('history.redoLabel', { change: view.history.redoLabel })
        : t('history.redo')
    }
  }

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
  const localizationElement = treeElement && root.querySelector<HTMLElement>('#localization-editor')
  let localizationEditor: ReturnType<typeof bindLocalizationEditor> | undefined
  const stylesheetElement = treeElement && root.querySelector<HTMLElement>('#stylesheet-editor')
  let stylesheetEditor: ReturnType<typeof bindStylesheetEditor> | undefined
  const repairElement = treeElement && root.querySelector<HTMLElement>('#project-repair')
  let repairEditor: ReturnType<typeof bindProjectRepair> | undefined
  const combatElement = treeElement && root.querySelector<HTMLElement>('#combat-editor')
  let combatEditor: ReturnType<typeof bindCombatEditor> | undefined
  const componentElement = treeElement && root.querySelector<HTMLElement>('#component-editor')
  let componentEditor: ReturnType<typeof bindComponentEditor> | undefined
  const sceneControlsElement = treeElement && root.querySelector<HTMLElement>('#scene-controls')
  let sceneControls: ReturnType<typeof bindSceneControls> | undefined
  const clipboardElement = treeElement && root.querySelector<HTMLElement>('#component-clipboard')
  let componentClipboard: ReturnType<typeof bindComponentClipboard> | undefined
  const railElement = treeElement && root.querySelector<HTMLElement>('#section-rail')
  let rail: ReturnType<typeof bindSectionRail> | undefined

  const sections = [
    ...projectTreeSections,
    ...(mapElement ? [{ id: 'maps', labelKey: 'maps.heading', nodes: mapFileNodes }] : []),
    ...(storyElement ? [{ id: 'story', labelKey: 'story.heading', nodes: () => [] }] : []),
    ...(rulesElement ? [{ id: 'rules', labelKey: 'rules.heading', nodes: ruleFileNodes }] : []),
    ...(actionBarElement
      ? [{ id: 'controls', labelKey: 'controls.heading', nodes: () => [] }]
      : []),
    ...(statusPanelElement ? [{ id: 'status', labelKey: 'status.heading', nodes: () => [] }] : []),
    ...(itemElement ? [{ id: 'items', labelKey: 'items.heading', nodes: () => [] }] : []),
    ...(shopElement ? [{ id: 'shops', labelKey: 'shops.heading', nodes: () => [] }] : []),
    ...(levelingElement ? [{ id: 'leveling', labelKey: 'leveling.heading', nodes: () => [] }] : []),
    ...(localizationElement
      ? [{ id: 'localization', labelKey: 'localization.heading', nodes: () => [] }]
      : []),
    ...(stylesheetElement
      ? [
          {
            id: 'stylesheet',
            labelKey: 'stylesheets.heading',
            nodes: (view: ProjectView): ProjectTreeNode[] => [
              ...Object.keys(view.stylesheets ?? {}).map((file) => ({
                key: `stylesheet:${file}`,
                section: 'stylesheet',
                kind: 'stylesheet-file',
                id: file,
                label: file,
                ...(view.game?.stylesheet === file ? { detail: t('stylesheets.assigned') } : {}),
              })),
              {
                key: 'stylesheet-new',
                section: 'stylesheet',
                kind: 'new-stylesheet',
                label: t('stylesheets.new'),
              },
            ],
          },
        ]
      : []),
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

    const dataFile = view ? dataFileContent(view, node) : undefined
    const dataGroup = node.kind === 'data-group'
    const dataRoot = node.section === 'data' && node.kind === 'section'

    const usesMapEditor =
      node.section === 'maps' || (node.kind === 'data-file' && node.parentId === 'maps')

    if (mapElement) mapElement.hidden = !usesMapEditor

    if (usesMapEditor) mapEditor?.navigate(node.id, node.kind === 'new-map')

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
      componentElement &&
      (node.kind === 'new-component' ||
        (component && editableComponentTypes.includes(component.type))),
    )

    const structureTarget =
      node.section === 'scenes' && (node.kind === 'scene' || node.kind === 'component')

    if (sceneControlsElement) sceneControlsElement.hidden = !structureTarget

    if (clipboardElement) clipboardElement.hidden = !structureTarget
    componentClipboard?.navigate(
      structureTarget ? sceneId : undefined,
      node.kind === 'component' ? node.id : undefined,
    )
    sceneControls?.navigate(
      structureTarget ? sceneId : undefined,
      node.kind === 'component' ? node.id : undefined,
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

    if (storyElement) storyElement.hidden = node.section !== 'story'

    if (localizationElement) localizationElement.hidden = node.section !== 'localization'

    if (stylesheetElement) stylesheetElement.hidden = node.section !== 'stylesheet'

    if (rulesElement) rulesElement.hidden = node.section !== 'rules'

    if (actionBarElement) actionBarElement.hidden = node.section !== 'controls' && !actionBar

    if (statusPanelElement)
      statusPanelElement.hidden = node.section !== 'status' && !statusComponent

    if (levelingElement) levelingElement.hidden = node.section !== 'leveling' && !levelingComponent

    if (levelingComponent)
      levelingEditor?.navigate(
        sceneId,
        component?.type === 'character-progression' ? component.profile : undefined,
        component?.id,
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

    if (node.kind === 'data-file' && node.parentId === 'inventories' && node.id)
      itemEditor?.navigateInventory(node.id)

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

    if (editableComponent)
      componentEditor?.navigate(sceneId, component?.id, node.kind === 'new-component')
    find('component-details').hidden =
      usesMapEditor ||
      (!dataFile &&
        !dataGroup &&
        !dataRoot &&
        (node.section !== 'scenes' ||
          node.kind !== 'component' ||
          graphic ||
          actionBar ||
          statusComponent ||
          itemComponent ||
          shopComponent ||
          combatComponent ||
          levelingComponent ||
          editableComponent))
    const editSection = sections.find((section) => section.id === dataFile?.editSection)

    find('component-help').textContent = dataRoot
      ? t('tree.dataRoot')
      : dataGroup
        ? t('tree.dataGroup')
        : editSection
          ? t('tree.editFileIn', { section: t(editSection.labelKey) })
          : t(dataFile ? 'tree.readOnlyFile' : 'tree.readOnly')
    find('component-json').textContent = dataFile
      ? JSON.stringify(dataFile.content, null, 2)
      : component && !graphic
        ? JSON.stringify(component, null, 2)
        : ''

    const sectionLabel = t(
      sections.find((section) => section.id === node.section)?.labelKey ?? node.label,
    )

    // The eyebrow names where the selection lives; top-level sections belong to the project.
    const parentScene =
      node.section === 'scenes'
        ? view?.scenes.find((scene) => scene.id === node.parentId)
        : undefined

    const parentLabel =
      parentScene && view
        ? sceneTitle(view, parentScene)
        : node.kind === 'data-file'
          ? t(`tree.files.${node.parentId}`)
          : node.parentId

    find('editor-heading').textContent =
      node.kind === 'section'
        ? t('project.heading')
        : [sectionLabel, parentLabel].filter(Boolean).join(' › ')
    find('workspace-heading').textContent = node.kind === 'section' ? sectionLabel : node.label
    rail?.render(view ? node.section : undefined)
    renderHistoryControls()

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

    const selectedComponent =
      node.kind === 'component'
        ? view?.scenes
            .find((scene) => scene.id === sceneId)
            ?.components.find((component) => component.id === node.id)
        : undefined

    const componentType = selectedComponent?.type

    const usesAssets =
      node.section === 'assets' ||
      (node.section === 'scenes' && (node.kind === 'new-graphic' || componentType === 'graphic'))

    const usesActionBar = Boolean(
      actionBarElement && (node.section === 'controls' || componentType === 'action-bar'),
    )

    const usesStatusPanel = Boolean(
      statusPanelElement && (node.section === 'status' || componentType === 'status-panel'),
    )

    const usesMapEditor =
      node.section === 'maps' || (node.kind === 'data-file' && node.parentId === 'maps')

    if (
      (node.section === 'stylesheet' &&
        !stylesheetEditor?.navigate(node.id, node.kind === 'new-stylesheet')) ||
      (usesMapEditor && mapEditor && !mapEditor.navigate(node.id, node.kind === 'new-map')) ||
      (!usesMapEditor && mapEditor?.hasDrafts()) ||
      (sceneControls &&
        !sceneControls.canNavigate(
          node.section === 'scenes' && (node.kind === 'scene' || node.kind === 'component')
            ? sceneId
            : undefined,
          node.kind === 'component' ? node.id : undefined,
        )) ||
      (componentClipboard &&
        !componentClipboard.canNavigate(
          node.section === 'scenes' && (node.kind === 'scene' || node.kind === 'component')
            ? sceneId
            : undefined,
          node.kind === 'component' ? node.id : undefined,
        )) ||
      (sceneChanges && (dirtyForms.has(sceneMetadata.id) || dirtyForms.has(layout.id))) ||
      ((node.section === 'items' ||
        ['item-details', 'equipment', 'inventory'].includes(componentType ?? '')) &&
        !itemEditor?.navigate(sceneId, node.section === 'scenes' ? node.id : undefined)) ||
      ((node.section === 'shops' || componentType === 'shop') && !shopEditor?.navigate(sceneId)) ||
      ((node.section === 'leveling' || componentType === 'character-progression') &&
        !levelingEditor?.navigate(
          sceneId,
          selectedComponent?.type === 'character-progression'
            ? selectedComponent.profile
            : undefined,
          selectedComponent?.id,
        )) ||
      ((node.section === 'combat' || componentType === 'combat') &&
        !combatEditor?.navigate(sceneId)) ||
      (node.kind === 'rule-file' && !rulesPanel?.navigate(node.id ?? '')) ||
      (componentElement &&
        (node.kind === 'new-component' || editableComponentTypes.includes(componentType ?? '')) &&
        !componentEditor?.navigate(sceneId, node.id, node.kind === 'new-component')) ||
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

    const moved = selection.key !== node.key
    selection = node

    if (usesAssets) {
      assetTarget = node.key
      assetsPanel?.navigate(node.kind, node.id, sceneId)
    }

    showSelection()

    // A new selection opens at the top instead of inheriting the previous editor's scroll offset.
    const body = root.querySelector<HTMLElement>('.editor-pane-body')

    if (moved && body) body.scrollTop = 0

    return true
  }

  const fillScene = () => {
    const scene = view?.scenes.find((scene) => scene.id === scenes.value)
    sceneMetadata.hidden = !scene
    layout.hidden = !scene

    if (!scene) return

    sceneTranslations.render(view, scene, !dirtyForms.has(sceneMetadata.id))

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
    repairEditor?.render(state, replaceFields)
    componentClipboard?.render(state, replaceFields)
    sceneControls?.render(state, replaceFields)
    assetsPanel?.render(state, replaceFields)
    rulesPanel?.render(state, replaceFields)
    actionBarPanel?.render(state, replaceFields)
    statusPanel?.render(state, replaceFields)
    itemEditor?.render(state, replaceFields)
    shopEditor?.render(state, replaceFields)
    combatEditor?.render(state, replaceFields)
    levelingEditor?.render(state, replaceFields)
    localizationEditor?.render(state, replaceFields)
    stylesheetEditor?.render(state, replaceFields)
    componentEditor?.render(state, replaceFields)
    storyEditor?.render(state, replaceFields)
    mapEditor?.render(state, replaceFields)
    refreshLanguage = () => render(state, false)
    const projectChanged = state.view && (!view || state.path !== loadedPath)
    const previousRevision = view?.revision
    view = state.view
    loadedPath = state.path

    if (projectChanged) {
      duplicateForm.reset()
      duplicateForm.hidden = true
      duplicateToggle.setAttribute('aria-expanded', 'false')
    }

    // Revisions cover every authored resource, including changes made by other clients.
    const projectUpdated = replaceFields && view && view.revision !== previousRevision

    if (projectChanged || projectUpdated) onProjectChange?.(loadedPath)

    busy = state.busy
    historyBlocked = state.conflict || state.changedElsewhere
    renderHistoryControls()
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
                  ? gameTitle(view) || state.path || t('workspace.root')
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
      ? gameTitle(view) || state.path || t('workspace.root')
      : ''

    projectTranslations.render(view, view?.game ?? undefined, false)

    const shownScene = view?.scenes.find((scene) => scene.id === scenes.value)

    if (shownScene) sceneTranslations.render(view, shownScene, false)

    if (openingProject && !state.busy) {
      openingProject = false

      if (replaceFields) {
        if (creatingProject || duplicatingProject) {
          projectChoices = [
            ...projectChoices.filter(({ path }) => path !== loadedPath),
            { path: loadedPath, title: view?.game?.title ?? loadedPath },
          ].sort((a, b) => a.path.localeCompare(b.path))
          renderProjectChoices(loadedPath)
          newForm.reset()
          duplicateForm.reset()
        }

        showOpenControls(false)
        openToggle.focus()
      } else {
        if (duplicatingProject) {
          duplicateError.textContent = state.error
          duplicateError.hidden = !state.error
        } else if (creatingProject) {
          newError.textContent = state.error
          newError.hidden = !state.error
        } else openError = state.error
      }

      creatingProject = false
      duplicatingProject = false
    }

    renderOpenControls()

    const updateTree = () => {
      if (!tree) return

      if (selection.section === 'stylesheet' && !stylesheetEditor?.hasDrafts()) {
        if (
          replaceFields &&
          state.lastCommand === 'game.upsertStylesheet' &&
          view?.game?.stylesheet
        )
          selection = {
            key: `stylesheet:${view.game.stylesheet}`,
            section: 'stylesheet',
            kind: 'stylesheet-file',
            id: view.game.stylesheet,
            label: view.game.stylesheet,
          }
        else if (
          selection.kind === 'stylesheet-file' &&
          !Object.hasOwn(view?.stylesheets ?? {}, selection.id ?? '')
        )
          selection = {
            key: 'stylesheet',
            section: 'stylesheet',
            kind: 'section',
            label: t('stylesheets.heading'),
          }
      }

      if (
        selection.section === 'maps' &&
        selection.kind === 'map' &&
        !view?.game?.maps?.includes(selection.id ?? '') &&
        !mapEditor?.hasDrafts()
      ) {
        const id = view?.game?.maps?.[0]
        selection = id
          ? { key: `map:${id}`, section: 'maps', kind: 'map', id, label: id }
          : { key: 'map-new', section: 'maps', kind: 'new-map', label: t('maps.new') }
      }

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

    if (state.historyChange && selection.section === 'scenes') {
      const sceneId = selection.parentId ?? selection.id
      const current = view.scenes.find(({ id }) => id === sceneId)

      if (
        !current ||
        (selection.kind === 'component' &&
          !current.components.some(({ id }) => id === selection.id))
      ) {
        const scene = current ?? view.scenes[0]
        selection = scene
          ? {
              key: `scene:${scene.id}`,
              section: 'scenes',
              kind: 'scene',
              id: scene.id,
              label: scene.title || scene.id,
            }
          : { key: 'game', section: 'game', kind: 'section', label: t('project.properties') }
        preferredScene = scene?.id
      }
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
      projectTranslations.render(view, view.game, true)
    }

    const selected = preferredScene ?? scenes.value
    const currentView = view
    preferredScene = undefined
    scenes.replaceChildren(
      ...view.scenes.map((scene) => {
        const option = root.ownerDocument.createElement('option')
        option.value = scene.id
        option.textContent = `${sceneTitle(currentView, scene)} (${scene.id})`

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
      assetsPanel?.navigate(selection.kind, selection.id, selection.parentId, true)
    updateTree()
  }

  let draftRecovery: ReturnType<typeof bindEditorDraftRecovery> | undefined

  const controller = new ProjectEditorController(client, (state, replaceFields) => {
    draftRecovery?.beforeRender()
    render(state, replaceFields)
    draftRecovery?.afterRender(state)
  })

  if (repairElement)
    repairEditor = bindProjectRepair(
      repairElement,
      t,
      {
        check: (request) => controller.checkRepair(request),
        save: (request) => controller.repair(request),
      },
      (css) => {
        const host = root.ownerDocument.createElement('div')
        host.hidden = true
        repairElement.append(host)

        try {
          mountGameStylesheet(host, css)
        } finally {
          host.remove()
        }
      },
    )

  if (clipboardElement)
    componentClipboard = bindComponentClipboard(clipboardElement, t, {
      copy: (sceneId, componentId) => controller.copyComponent(sceneId, componentId),
      save: (command) => {
        void controller.save(command)
      },
      canChange: () => !hasDrafts(true, false),
      onSaved(command) {
        selection = {
          key: `component:${command.sceneId}:${command.newId}`,
          section: 'scenes',
          kind: 'component',
          parentId: command.sceneId,
          id: command.newId,
          label: command.newId,
        }
        preferredScene = command.sceneId
      },
    })

  if (sceneControlsElement)
    sceneControls = bindSceneControls(sceneControlsElement, t, {
      save: (command) => {
        void controller.save(command)
      },
      canChange: () => !hasDrafts(false),
      confirmDelete,
      onSaved(command, next) {
        if (command.type === 'scene.duplicateComponent' || command.type === 'scene.moveComponent') {
          const id =
            command.type === 'scene.duplicateComponent' ? command.newId : command.componentId

          selection = {
            key: `component:${command.sceneId}:${id}`,
            section: 'scenes',
            kind: 'component',
            parentId: command.sceneId,
            id,
            label: id,
          }
          preferredScene = command.sceneId

          return
        }

        const id =
          command.type === 'scene.rename' || command.type === 'scene.duplicate'
            ? command.newId
            : command.type === 'scene.remove'
              ? (command.replacementScene ?? next.scenes[0]?.id)
              : command.type === 'scene.removeComponent'
                ? command.sceneId
                : undefined

        if (id) {
          selection = { key: `scene:${id}`, section: 'scenes', kind: 'scene', id, label: id }
          preferredScene = id
        }
      },
    })

  if (rulesElement)
    rulesPanel = bindRulesPanel(
      rulesElement,
      (command) => {
        void controller.save(command)
      },
      t,
    )

  if (mapElement)
    mapEditor = bindMapEditor(
      mapElement,
      (command) => {
        void controller.save(command)
      },
      t,
      {
        confirm: (message) => mapConfirm!.ask(message),
        onHistoryChange: renderHistoryControls,
        createGraphics: (path) =>
          new BrowserGraphicResources(
            new EditorWorkspaceResources(path, fetcher),
            createGraphicPlatform(root.ownerDocument),
          ),
        onNavigate(id) {
          selection = id
            ? { key: `map:${id}`, section: 'maps', kind: 'map', id, label: id }
            : { key: 'map-new', section: 'maps', kind: 'new-map', label: t('maps.new') }
          showSelection()
          tree?.render(view, busy, selection.key)
        },
        onSaved(id) {
          selection = id
            ? { key: `map:${id}`, section: 'maps', kind: 'map', id, label: id }
            : { key: 'map-new', section: 'maps', kind: 'new-map', label: t('maps.new') }
        },
      },
    )

  if (actionBarElement)
    actionBarPanel = bindActionBarPanel(
      actionBarElement,
      (command) => {
        void controller.save(command)
      },
      t,
    )

  if (statusPanelElement)
    statusPanel = bindStatusPanelEditor(
      statusPanelElement,
      (command) => {
        void controller.save(command)
      },
      t,
    )

  if (levelingElement)
    levelingEditor = bindLevelingEditor(
      levelingElement,
      (command) => {
        void controller.save(command)
      },
      t,
    )

  if (localizationElement)
    localizationEditor = bindLocalizationEditor(
      localizationElement,
      (command) => {
        void controller.save(command)
      },
      t,
    )

  if (stylesheetElement)
    stylesheetEditor = bindStylesheetEditor(
      stylesheetElement,
      (command) => {
        void controller.save(command)
      },
      t,
      (css) => {
        const host = root.ownerDocument.createElement('div')
        host.hidden = true
        stylesheetElement.append(host)

        try {
          mountGameStylesheet(host, css)
        } finally {
          host.remove()
        }
      },
    )

  if (storyElement)
    storyEditor = bindStoryEditor(
      storyElement,
      (command) => {
        void controller.save(command)
      },
      t,
    )

  if (combatElement)
    combatEditor = bindCombatEditor(
      combatElement,
      (command) => {
        void controller.save(command)
      },
      t,
    )

  if (shopElement)
    shopEditor = bindShopEditor(
      shopElement,
      (command) => {
        void controller.save(command)
      },
      t,
    )

  if (itemElement)
    itemEditor = bindItemEditor(
      itemElement,
      (command) => {
        void controller.save(command)
      },
      t,
    )

  if (componentElement)
    componentEditor = bindComponentEditor(
      componentElement,
      (command) => {
        void controller.save(command)
      },
      {
        t,
        onCreated(sceneId, componentId) {
          selection = {
            key: `component:${sceneId}:${componentId}`,
            section: 'scenes',
            kind: 'component',
            parentId: sceneId,
            id: componentId,
            label: componentId,
          }
        },
        onCancel(sceneId) {
          tree?.select(`scene:${sceneId}`)
        },
      },
    )
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
    draftRecovery?.languageChanged()
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
  on(newToggle, 'click', () => {
    duplicateForm.hidden = true
    duplicateToggle.setAttribute('aria-expanded', 'false')

    if (recoverForm) recoverForm.hidden = true
    recoverToggle?.setAttribute('aria-expanded', 'false')
    newForm.hidden = !newForm.hidden
    newToggle.setAttribute('aria-expanded', String(!newForm.hidden))

    if (!newForm.hidden) find('project-new-title').focus()
  })
  on(newCancel, 'click', () => {
    newForm.hidden = true
    newToggle.setAttribute('aria-expanded', 'false')
    newError.hidden = true
    newToggle.focus()
  })
  on(newForm, 'submit', (event) => {
    event.preventDefault()

    if (busy || newSubmit.disabled) return

    const request = createProjectRequestSchema.safeParse({
      path: value('project-new-folder').trim(),
      title: value('project-new-title'),
      description: value('project-new-description'),
    })

    if (!request.success) {
      newError.textContent = t('project.invalidCreation')
      newError.hidden = false

      return
    }

    if (hasDrafts() && !confirmDiscardDrafts()) return
    openingProject = true
    creatingProject = true
    openError = ''
    newError.hidden = true
    void controller.create(request.data)
  })

  on(duplicateToggle, 'click', () => {
    if (duplicateToggle.disabled) return
    duplicateForm.hidden = !duplicateForm.hidden
    duplicateToggle.setAttribute('aria-expanded', String(!duplicateForm.hidden))
    newForm.hidden = true
    newToggle.setAttribute('aria-expanded', 'false')

    if (recoverForm) recoverForm.hidden = true
    recoverToggle?.setAttribute('aria-expanded', 'false')

    if (!duplicateForm.hidden) {
      if (!value('project-copy-title'))
        set(
          'project-copy-title',
          t('project.copyTitle', { title: view ? gameTitle(view) : '' }).slice(0, 200),
        )

      if (!value('project-copy-folder'))
        set('project-copy-folder', `${(view?.game?.id ?? 'game').slice(0, 59)}-copy`)
      find('project-copy-title').focus()
    }
  })
  on(duplicateCancel, 'click', () => {
    duplicateForm.hidden = true
    duplicateToggle.setAttribute('aria-expanded', 'false')
    duplicateError.hidden = true
    duplicateToggle.focus()
  })
  on(duplicateForm, 'submit', (event) => {
    event.preventDefault()

    if (busy || duplicateToggle.disabled || !view) return

    const request = duplicateProjectRequestSchema.safeParse({
      path: loadedPath,
      expectedRevision: view.revision,
      destination: value('project-copy-folder').trim(),
      title: value('project-copy-title'),
    })

    if (!request.success) {
      duplicateError.textContent = t('project.invalidCreation')
      duplicateError.hidden = false

      return
    }

    if (hasDrafts() && !confirmDiscardDrafts()) return
    openingProject = true
    duplicatingProject = true
    openError = ''
    duplicateError.hidden = true
    void controller.duplicate(request.data)
  })

  if (recoverToggle && recoverForm && recoverFolder && recoverCancel) {
    on(recoverToggle, 'click', () => {
      duplicateForm.hidden = true
      duplicateToggle.setAttribute('aria-expanded', 'false')
      recoverForm.hidden = !recoverForm.hidden
      recoverToggle.setAttribute('aria-expanded', String(!recoverForm.hidden))
      newForm.hidden = true
      newToggle.setAttribute('aria-expanded', 'false')

      if (!recoverForm.hidden) recoverFolder.focus()
    })
    on(recoverCancel, 'click', () => {
      recoverForm.hidden = true
      recoverToggle.setAttribute('aria-expanded', 'false')
      recoverToggle.focus()
    })
    on(recoverForm, 'submit', (event) => {
      event.preventDefault()

      if (busy) return
      let path: string

      try {
        path = normalizeGameFolder(recoverFolder.value)
      } catch (error) {
        openError = error instanceof Error ? error.message : String(error)
        renderOpenControls()

        return
      }

      if (hasDrafts() && !confirmDiscardDrafts()) return
      openingProject = true
      openError = ''
      void controller.load(path)
    })
  }

  on(folder, 'keydown', (event) => {
    if (!('key' in event) || event.key !== 'Enter') return

    event.preventDefault()
    openControls.requestSubmit()
  })
  on(openControls, 'submit', (event) => {
    event.preventDefault()

    if (load.disabled || !projectChoices.some(({ path }) => path === folder.value)) return

    if (hasDrafts() && !confirmDiscardDrafts()) return

    openingProject = true
    openError = ''
    void controller.load(folder.value)
  })

  const hasDrafts = (includeSceneControls = true, includeClipboard = true) =>
    dirtyForms.size > 0 ||
    Boolean(
      repairEditor?.hasDrafts() ||
      (includeSceneControls && sceneControls?.hasDrafts()) ||
      (includeClipboard && componentClipboard?.hasDrafts()) ||
      assetsPanel?.hasDrafts() ||
      rulesPanel?.hasDrafts() ||
      actionBarPanel?.hasDrafts() ||
      statusPanel?.hasDrafts() ||
      itemEditor?.hasDrafts() ||
      shopEditor?.hasDrafts() ||
      combatEditor?.hasDrafts() ||
      levelingEditor?.hasDrafts() ||
      localizationEditor?.hasDrafts() ||
      stylesheetEditor?.hasDrafts() ||
      componentEditor?.hasDrafts() ||
      storyEditor?.hasDrafts() ||
      mapEditor?.hasDrafts(),
    )

  const formFields = [
    'editor-title',
    'editor-description',
    'editor-version',
    'editor-title-key',
    'editor-description-key',
    'scene-title',
    'scene-description',
    'scene-title-key',
    'scene-description-key',
    'scene-rows',
    'scene-columns',
    'new-scene-id',
    'new-scene-title',
    'new-scene-type',
    'new-scene-rows',
    'new-scene-columns',
  ]

  registerEditorDraft(
    metadata,
    'project-forms',
    z.object({
      fields: z.record(z.string(), z.string()),
      dirty: z.array(z.string()),
      scene: z.string(),
    }),
    () =>
      dirtyForms.size
        ? {
            fields: Object.fromEntries(formFields.map((id) => [id, value(id)])),
            dirty: [...dirtyForms],
            scene: scenes.value,
          }
        : undefined,
    (saved) => {
      dirtyForms.clear()

      for (const id of saved.dirty)
        if ([metadata.id, sceneMetadata.id, layout.id, create.id].includes(id)) dirtyForms.add(id)
      scenes.value = saved.scene

      for (const id of formFields) if (Object.hasOwn(saved.fields, id)) set(id, saved.fields[id]!)
      scenes.disabled = dirtyForms.has(sceneMetadata.id) || dirtyForms.has(layout.id)
    },
  )
  draftRecovery = bindEditorDraftRecovery(
    root,
    new EditorDraftStore(draftStorage, crypto.randomUUID()),
    t,
    () =>
      view
        ? {
            version: 1,
            path: loadedPath,
            savedAt: Date.now(),
            base: view,
            selection: selection.key,
            drafts: captureEditorDrafts(root),
          }
        : undefined,
    hasDrafts,
    (draft) => {
      controller.recoverDrafts(draft.base)
      selection = flattenProjectTree(buildProjectTree(draft.base, t, sections)).find(
        (node) => node.key === draft.selection,
      ) ?? { key: 'game', section: 'game', kind: 'section', label: t('project.properties') }
      showSelection()
      tree?.render(view, busy, selection.key)
      const failed = restoreEditorDrafts(root, draft.drafts)
      projectTranslations.render(view, view?.game ?? undefined, false)
      const scene = view?.scenes.find((scene) => scene.id === scenes.value)

      if (scene) sceneTranslations.render(view, scene, false)
      renderHistoryControls()

      return failed
    },
  )

  const restoreHistory = (direction: 'undo' | 'redo') => {
    if (mapHistory()?.active) {
      mapEditor?.restoreDraft(direction)
      renderHistoryControls()

      return
    }

    if (busy || historyBlocked || !view?.history?.[direction === 'undo' ? 'canUndo' : 'canRedo'])
      return

    if (hasDrafts()) {
      error.textContent = t('history.saveDraftsFirst')
      error.hidden = false

      return
    }

    void controller.restore(direction)
  }

  on(undo, 'click', () => restoreHistory('undo'))
  on(redo, 'click', () => restoreHistory('redo'))

  if (root.ownerDocument.defaultView)
    listeners.push(
      bindEditorShortcuts(root.ownerDocument.defaultView, {
        blocked: () => busy || (historyBlocked && !mapHistory()?.active) || !view,
        copy: () => componentClipboard?.shortcut('copy') ?? false,
        paste: () => componentClipboard?.shortcut('paste') ?? false,
        duplicate: () => sceneControls?.shortcut('duplicate') ?? false,
        delete: () => sceneControls?.shortcut('delete') ?? false,
        undo: () => {
          if (!mapHistory()?.active && !view?.history?.canUndo) return false
          restoreHistory('undo')

          return true
        },
        redo: () => {
          if (!mapHistory()?.active && !view?.history?.canRedo) return false
          restoreHistory('redo')

          return true
        },
      }),
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
    if (busy) return

    const issue = projectTranslations.validate()

    if (issue) {
      error.textContent = issue
      error.hidden = false

      return
    }

    void controller.save({
      type: 'game.updateMetadata',
      title: value('editor-title'),
      description: value('editor-description'),
      version: value('editor-version'),
      ...projectTranslations.read(),
    })
  })
  submit(sceneMetadata, () => {
    if (busy) return

    const issue = sceneTranslations.validate()

    if (issue) {
      error.textContent = issue
      error.hidden = false

      return
    }

    void controller.save({
      type: 'scene.updateMetadata',
      sceneId: scenes.value,
      title: value('scene-title'),
      description: value('scene-description'),
      ...sceneTranslations.read(),
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

  return {
    hasDrafts,
    dispose() {
      draftRecovery?.dispose()
      repairEditor?.dispose()
      discovery?.abort()
      controller.dispose()
      assetsPanel?.dispose()
      mapEditor?.dispose()
      mapConfirm?.dispose()
      tree?.dispose()
      rail?.dispose()
      unsubscribeLanguage?.()
      projectTranslations.dispose()
      sceneTranslations.dispose()

      for (const remove of listeners) remove()
    },
  }
}
