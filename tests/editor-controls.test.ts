import { bindStoryEditor } from '../apps/editor-ui/src/storyEditor.js'
import { bindLevelingEditor } from '../apps/editor-ui/src/levelingEditor.js'
/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vite-plus/test'
import {
  applyCommand,
  commandSchema,
  inspectProject,
  object,
  projectViewSchema,
  componentClipboardSchema,
  type EditorCommand,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'
import {
  actionBarComponentSchema,
  inputSchema,
  inventorySchema,
  combatLibrarySchema,
  sceneComponentSchema,
  textComponentSchema,
  questSchema,
} from '@ancadeba/schemas'
import { bindActionBarPanel } from '../apps/editor-ui/src/actionBarPanel.js'
import { createInputDraft, readInputDraft } from '../apps/editor-ui/src/inputDefinitionForm.js'
import type {
  ProjectEditorState,
  ProjectEditorListener,
} from '../apps/editor-ui/src/projectController.js'
import { inventoryActionsForm } from '../apps/editor-ui/src/inventoryActionsForm.js'
import { displayLabel, ruleFormControls } from '../apps/editor-ui/src/ruleFormControls.js'
import { ruleTriggerForms } from '../apps/editor-ui/src/ruleTriggerForms.js'
import { nearbyForm } from '../apps/editor-ui/src/nearbyForm.js'
import { bindComponentEditor } from '../apps/editor-ui/src/componentEditor.js'
import { bindSceneControls } from '../apps/editor-ui/src/sceneControls.js'
import { bindComponentClipboard } from '../apps/editor-ui/src/componentClipboard.js'
import { editorLocalization } from '../apps/editor-ui/src/localization.js'
import { bindStatusPanelEditor } from '../apps/editor-ui/src/statusPanelEditor.js'
import { bindItemEditor } from '../apps/editor-ui/src/itemEditor.js'
import { bindCombatEditor } from '../apps/editor-ui/src/combatEditor.js'
import { bindShopEditor } from '../apps/editor-ui/src/shopEditor.js'
import { bindRulesPanel } from '../apps/editor-ui/src/rulesPanel.js'
import { ProjectEditorController } from '../apps/editor-ui/src/projectController.js'
import { EditorClientError } from '../apps/editor-ui/src/editorClient.js'
import { bindInventoryEditor } from '../apps/editor-ui/src/inventoryEditor.js'
import { bindLocalizationEditor } from '../apps/editor-ui/src/localizationEditor.js'
import { bindGraphicDefinitionsEditor } from '../apps/editor-ui/src/graphicDefinitionsEditor.js'
import { textBindingId } from '../apps/editor-ui/src/textBindingChoices.js'
import { bindSceneGraphicEditor } from '../apps/editor-ui/src/sceneGraphicEditor.js'
import { bindStylesheetEditor } from '../apps/editor-ui/src/stylesheetEditor.js'
import { startingGameBindings } from '../apps/editor-ui/src/textBindingChoices.js'
import { resolveGraphic } from '@ancadeba/game-runtime'

const input = inputSchema.parse({
  'schema-version': '1.0.0',
  'virtual-keys': ['primary', 'secondary'],
  keyboard: { KeyQ: 'primary', Digit1: 'primary' },
  contexts: { gameplay: { primary: 'slot-1', secondary: 'slot-2' } },
  'initial-context': 'gameplay',
})

const bar = actionBarComponentSchema.parse({
  id: 'actions',
  type: 'action-bar',
  placement: { row: 2, column: 1, rowSpan: 3, columnSpan: 5 },
  slots: {
    '1': {
      label: 'Act',
      action: { type: 'request-action', action: 'act' },
      inputBinding: { context: 'gameplay', input: 'slot-1' },
    },
  },
})

function project(withInput = true): ProjectSnapshot {
  return {
    revision: 'one',
    documents: {
      'game.json': {
        'schema-version': '1.0.0',
        id: 'test',
        title: 'Test',
        version: '1',
        scenes: ['shop', 'other'],
        ...(withInput && { input: 'keys' }),
      },
      ...(withInput && { 'input/keys.json': { ...input, extension: 'keep' } }),
      ...Object.fromEntries(
        ['shop', 'other'].map((id) => [
          `scenes/${id}.json`,
          {
            'schema-version': '1.0.0',
            id,
            title: id,
            type: 'game',
            screen: { type: 'grid', grid: { rows: 6, columns: 5 } },
            components: [
              { id: 'description', type: 'text', text: 'Hello', placement: { row: 1, column: 1 } },
            ],
            extension: 'keep',
          },
        ]),
      ),
    },
  }
}

describe('editor control commands', () => {
  it('creates and inspects input, updates its referenced file, and preserves project metadata', () => {
    const original = project(false)
    const before = JSON.stringify(original)
    const created = applyCommand(original, { type: 'game.updateInput', inputId: 'keys', input })
    expect(created.changedFiles).toEqual(['input/keys.json', 'game.json'])
    expect(JSON.stringify(original)).toBe(before)
    const view = projectViewSchema.parse(inspectProject(created.project))
    expect(view.game?.input).toBe('keys')
    expect(view.input).toEqual(input)

    const changed = applyCommand(project(), {
      type: 'game.updateInput',
      inputId: 'keys',
      input: { ...input, keyboard: { KeyJ: 'primary' } },
    })

    expect(changed.changedFiles).toEqual(['input/keys.json'])
    expect(changed.project.documents['input/keys.json']).toHaveProperty('extension', 'keep')
    expect(() =>
      applyCommand(project(), { type: 'game.updateInput', inputId: 'different', input }),
    ).toThrow('referenced by this game')
  })

  it('creates, updates, clears slots, and removes a bar while preserving other scene content', () => {
    const original = project()

    const created = applyCommand(original, {
      type: 'scene.setActionBar',
      sceneId: 'shop',
      component: bar,
    })

    const scene = object(created.project.documents['scenes/shop.json'])
    expect(created.changedFiles).toEqual(['scenes/shop.json'])
    expect(scene.extension).toBe('keep')

    const rawBar = {
      ...bar,
      extension: 'bar',
      slots: { '1': { ...bar.slots['1']!, extension: 'slot' } },
    }

    const extended = {
      ...created.project,
      documents: {
        ...created.project.documents,
        'scenes/shop.json': {
          ...scene,
          components: [inspectProject(original).scenes[0]!.components[0], rawBar],
        },
      },
    }

    const updated = applyCommand(extended, {
      type: 'scene.setActionBar',
      sceneId: 'shop',
      component: {
        ...bar,
        slots: { '1': { label: 'New label', action: { type: 'enter-scene', scene: 'other' } } },
      },
    })

    const savedComponents = object(updated.project.documents['scenes/shop.json']).components

    if (!Array.isArray(savedComponents)) throw new Error('Expected scene components')
    const savedBar = object(savedComponents[1])
    expect(savedBar).toHaveProperty('extension', 'bar')
    expect(object(object(savedBar.slots)['1'])).toMatchObject({
      label: 'New label',
      extension: 'slot',
      inputBinding: undefined,
    })

    const removed = applyCommand(updated.project, {
      type: 'scene.setActionBar',
      sceneId: 'shop',
      component: null,
    })

    expect(inspectProject(removed.project).scenes[0]!.components.map(({ id }) => id)).toEqual([
      'description',
    ])
    expect(inspectProject(original).scenes[0]!.components).toHaveLength(1)
  })

  it('rejects conflicting IDs, invalid bindings, clipped placement, and input edits that orphan slots', () => {
    expect(() =>
      applyCommand(project(), {
        type: 'scene.setActionBar',
        sceneId: 'shop',
        component: { ...bar, id: 'description' },
      }),
    ).toThrow('another component')
    expect(() =>
      applyCommand(project(), { type: 'scene.setActionBar', sceneId: 'missing', component: bar }),
    ).toThrow('game scene')
    expect(() =>
      applyCommand(project(), {
        type: 'scene.setActionBar',
        sceneId: 'shop',
        component: { ...bar, placement: { ...bar.placement, row: 6 } },
      }),
    ).toThrow('invalid project')

    const created = applyCommand(project(), {
      type: 'scene.setActionBar',
      sceneId: 'shop',
      component: bar,
    })

    expect(() =>
      applyCommand(created.project, {
        type: 'game.updateInput',
        inputId: 'keys',
        input: { ...input, contexts: { gameplay: { primary: 'different' } } },
      }),
    ).toThrow('invalid project')
  })

  it('keeps duplicate physical and context mappings available for correction instead of overwriting them', () => {
    const draft = createInputDraft(input)
    draft.keyboard.push({ code: 'KeyQ', key: 'secondary' })
    expect(() => readInputDraft(draft)).toThrow('Keyboard contains duplicate keys')
    draft.keyboard.pop()
    draft.contexts.gameplay!.push({ key: 'primary', input: 'other' })
    expect(() => readInputDraft(draft)).toThrow('Context gameplay contains duplicate keys')
    expect(input.keyboard.KeyQ).toBe('primary')
  })
})

class Control extends EventTarget {
  readonly children: Control[] = []
  readonly attributes = new Map<string, string>()
  parent?: Control
  ownText = ''
  value = ''
  id = ''
  type = ''
  className = ''
  disabled = false
  readOnly = false
  hidden = false
  constructor(
    readonly ownerDocument: ControlDocument,
    readonly tagName: string,
  ) {
    super()
  }
  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('')
  }
  set textContent(value: string) {
    this.ownText = value
    this.children.length = 0
  }
  append(...items: (Control | string)[]) {
    for (const item of items) {
      if (typeof item === 'string') this.ownText += item
      else {
        item.parent = this
        this.children.push(item)
      }
    }
  }
  replaceChildren(...items: (Control | string)[]) {
    this.ownText = ''
    this.children.length = 0
    this.append(...items)
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  all(): Control[] {
    return [this, ...this.children.flatMap((child) => child.all())]
  }
  querySelector(selector: string): Control | null {
    return this.all().find((child) => child.tagName === selector) ?? null
  }
  asElement(): HTMLElement {
    // @ts-expect-error -- Partial DOM harness supplies the panel's element operations.
    return this
  }
}

class ControlDocument {
  asDocument(): Document {
    // @ts-expect-error -- Partial DOM fixture supplies the form's document operations.
    return this
  }
  createElement(tag: string): Control {
    return new Control(this, tag)
  }
}

function panel(withInput = true) {
  const document = new ControlDocument()
  const root = document.createElement('section')
  const commands: EditorCommand[] = []

  const controls = bindActionBarPanel(root.asElement(), (command) => {
    commands.push(command)
  })

  const current = withInput
    ? applyCommand(project(), { type: 'scene.setActionBar', sceneId: 'shop', component: bar })
        .project
    : project(false)

  const initial: ProjectEditorState = {
    path: 'demo',
    view: inspectProject(current),
    busy: false,
    conflict: false,
    error: '',
    changedElsewhere: false,
    lastCommand: null,
    preserveDrafts: false,
  }

  controls.render(initial, true)

  const button = (title: string) => {
    const control = root
      .all()
      .find((node) => node.tagName === 'button' && node.textContent === title)

    if (!control) throw new Error(`Missing button: ${title}`)

    return control
  }

  // Grouped fields drop their group's prefix, so a legend can narrow the search.
  const field = (title: string, group?: string) => {
    const scope = group
      ? root
          .all()
          .find(
            (node) =>
              node.tagName === 'fieldset' &&
              node.children.some((child) => child.tagName === 'legend' && child.ownText === group),
          )
      : root

    const label = scope?.all().find((node) => node.tagName === 'label' && node.ownText === title)

    if (!label) throw new Error(`Missing field: ${group ? `${group} › ` : ''}${title}`)

    return label.children[0]!
  }

  const edit = (title: string, value: string, group?: string) => {
    const control = field(title, group)
    control.value = value
    control.dispatchEvent(new Event(control.tagName === 'select' ? 'change' : 'input'))
  }

  const click = (title: string) => button(title).dispatchEvent(new Event('click'))

  const submit = (title: string) => {
    let form: Control | undefined = button(title)

    while (form && form.tagName !== 'form') form = form.parent

    if (!form) throw new Error(`Missing form: ${title}`)
    form.dispatchEvent(new Event('submit', { cancelable: true }))
  }

  return { controls, commands, root, initial, field, edit, click, submit }
}

describe('translation key fields', () => {
  it('names definitions by literal label, then translated label, then ID', () => {
    const view = projectViewSchema.parse({
      revision: 'one',
      game: null,
      scenes: [],
      diagnostics: [],
      translations: { 'shop.postcard': 'Postcard' },
    })

    expect(displayLabel(view, 'letter', { label: 'Folded letter' })).toBe('Folded letter')
    expect(displayLabel(view, 'postcard', { label: '', labelKey: 'shop.postcard' })).toBe(
      'Postcard',
    )
    expect(displayLabel(view, 'token', { label: ' ', labelKey: 'missing' })).toBe('token')
  })

  it('previews the chosen key and only accepts listed keys or the empty choice', () => {
    const document = new ControlDocument()
    const updates: string[] = []
    let edits = 0

    const controls = ruleFormControls(document.asDocument(), () => {
      edits++
    })

    const choices = [
      ['', 'Use literal text'],
      ['shop.title', 'Museum shop'],
      ['shop.empty', ''],
    ] as const

    const form = document.createElement('form')
    form.asElement().append(
      controls.translation('Title translation', 'shop.title', choices, (value) => {
        updates.push(value)
      }),
      controls.translation('Other', '', choices, () => {}),
    )
    const field = form.children[0]!
    const second = form.children[1]!

    const control = field.children[0]!
    const preview = field.children.find((child) => child.className === 'translation-preview')!
    const list = field.children.find((child) => child.tagName === 'datalist')!

    const type = (value: string) => {
      control.value = value
      control.dispatchEvent(new Event('input'))
    }

    expect(preview.textContent).toBe('Museum shop')
    expect(list.children.map((option) => option.value)).toEqual(['shop.title', 'shop.empty'])
    type('shop.unknown')
    expect(control.attributes.get('aria-invalid')).toBe('true')
    expect(preview.textContent).toBe('Unknown translation key')
    type('shop.empty')
    expect(preview.textContent).toBe('(empty text)')
    type('')
    expect(control.attributes.get('aria-invalid')).toBe('false')
    expect(updates).toEqual(['shop.empty', ''])
    expect(edits).toBe(2)

    expect(second.children.some((child) => child.tagName === 'datalist')).toBe(true)
    expect(second.children[0]!.attributes.get('list')).not.toBe(control.attributes.get('list'))
  })
})

function nearbyComponentPanel() {
  const fixture = panel()
  const { root, initial, commands } = fixture
  const view = structuredClone(initial.view!)
  view.translationKeys = ['nearby.title']
  view.translations = { 'nearby.title': 'Nearby characters' }
  view.scenes[0]!.components.push(
    sceneComponentSchema.parse({
      id: 'other-description',
      type: 'text',
      text: 'Other description',
      placement: { row: 1, column: 2 },
    }),
    ...['first', 'second'].map((id) =>
      sceneComponentSchema.parse({
        id,
        type: 'nearby',
        label: id,
        descriptionTarget: id === 'first' ? 'description' : 'other-description',
        placement: { row: 2, column: id === 'first' ? 1 : 2 },
        entries: {},
      }),
    ),
  )
  const editor = bindComponentEditor(root.asElement(), (command) => commands.push(command))
  editor.render({ ...initial, view }, true)
  editor.navigate('shop', 'second')

  return { ...fixture, editor, view }
}

function addingComponentPanel(withResources = true) {
  const fixture = panel()
  const source = project()

  let snapshot: ProjectSnapshot = {
    ...source,
    documents: {
      ...source.documents,
      'game.json': {
        ...object(source.documents['game.json']),
        ...(withResources
          ? { maps: ['coast'], languages: { default: 'en', available: ['en', 'nl'] } }
          : {}),
      },
      'scenes/other.json': {
        ...object(source.documents['scenes/other.json']),
        type: 'stand-alone',
      },
      ...(withResources
        ? {
            'maps/coast.json': {
              'schema-version': '1.0.0',
              type: 'square-grid',
              width: 3,
              height: 2,
              terrain: { grass: { color: '#00ff00' } },
              tiles: [
                ['grass', 'grass', 'grass'],
                ['grass', 'grass', 'grass'],
              ],
            },
            'languages/en/messages.json': { 'language.name': 'English' },
            'languages/nl/messages.json': { 'language.name': 'Nederlands' },
          }
        : {}),
    },
  }

  const created: string[] = []
  const cancelled: string[] = []

  const editor = bindComponentEditor(
    fixture.root.asElement(),
    (command) => fixture.commands.push(command),
    {
      onCreated: (sceneId, componentId) => created.push(`${sceneId}:${componentId}`),
      onCancel: (sceneId) => cancelled.push(sceneId),
    },
  )

  const state = () => ({ ...fixture.initial, view: inspectProject(snapshot) })
  editor.render(state(), true)
  editor.navigate('shop', undefined, true)

  return {
    ...fixture,
    editor,
    created,
    cancelled,
    state,
    persist: () => {
      const command = fixture.commands.at(-1)

      if (!command) throw new Error('Expected a component save')
      snapshot = applyCommand(snapshot, command).project
      editor.render({ ...state(), preserveDrafts: true, lastCommand: command.type }, true)

      return inspectProject(snapshot)
    },
  }
}

function clipboardPanel() {
  const fixture = panel()
  let snapshot = project()
  let allowChanges = true
  let copyFailure = false
  const copied: string[] = []
  const saved: string[] = []

  const controls = bindComponentClipboard(fixture.root.asElement(), editorLocalization().t, {
    copy: async (sceneId, componentId) => {
      copied.push(componentId)

      if (copyFailure) return undefined
      const scene = object(snapshot.documents[`scenes/${sceneId}.json`])

      const component = (Array.isArray(scene.components) ? scene.components : []).find(
        (entry) => object(entry).id === componentId,
      )

      return componentClipboardSchema.parse({ revision: snapshot.revision, component })
    },
    save: (command) => fixture.commands.push(command),
    canChange: () => allowChanges,
    onSaved: (command) => saved.push(command.newId),
  })

  const state = () => ({ ...fixture.initial, view: inspectProject(snapshot) })
  controls.render(state(), true)
  controls.navigate('shop', 'description')

  return {
    ...fixture,
    controls,
    copied,
    saved,
    state,
    allow: (value: boolean) => {
      allowChanges = value
    },
    failCopy: () => {
      copyFailure = true
    },
    persist: () => {
      const command = fixture.commands.at(-1)

      if (!command) throw new Error('Expected paste command')
      snapshot = applyCommand(snapshot, command).project
      controls.render({ ...state(), preserveDrafts: true, lastCommand: command.type }, true)

      return inspectProject(snapshot)
    },
  }
}

describe('component clipboard controls', () => {
  it('uses the copy and paste save paths for shortcuts, with destination checks and draft protection', async () => {
    const { controls, field, commands, allow, persist } = clipboardPanel()
    expect(controls.shortcut('paste')).toBe(false)
    allow(false)
    expect(controls.shortcut('copy')).toBe(true)
    expect(commands).toEqual([])
    allow(true)
    expect(controls.shortcut('copy')).toBe(true)
    await vi.waitFor(() => expect(field('Pasted component ID').value).toBe('description-copy'))
    controls.navigate('other')
    expect(controls.shortcut('copy')).toBe(false)
    allow(false)
    expect(controls.shortcut('paste')).toBe(true)
    expect(commands).toEqual([])
    allow(true)
    expect(controls.shortcut('paste')).toBe(true)
    expect(persist().scenes[1]!.components.at(-1)?.id).toBe('description-copy')
    expect(controls.shortcut('paste')).toBe(true)
    expect(persist().scenes[1]!.components.at(-1)?.id).toBe('description-copy-2')
    controls.navigate()
    expect(controls.shortcut('paste')).toBe(false)
  })

  it('copies without saving, pastes between scenes, selects the new component, and suggests fresh IDs for repeat pastes', async () => {
    const { controls, click, field, edit, submit, commands, saved, persist } = clipboardPanel()
    click('Copy component')
    await vi.waitFor(() => expect(field('Pasted component ID').value).toBe('description-copy'))
    expect(commands).toEqual([])
    controls.navigate('other')
    edit('Pasted component ID', 'greeting')
    submit('Paste component')
    expect(commands[0]).toMatchObject({
      type: 'scene.pasteComponent',
      sceneId: 'other',
      newId: 'greeting',
      component: { id: 'description', type: 'text', text: 'Hello' },
    })
    expect(persist().scenes[1]!.components.map(({ id }) => id)).toEqual(['description', 'greeting'])
    expect(saved).toEqual(['greeting'])
    expect(field('Pasted component ID').value).toBe('description-copy')
    submit('Paste component')
    persist()
    expect(field('Pasted component ID').value).toBe('description-copy-2')
  })

  it('protects unrelated edits, retains paste drafts on failures, and clears the clipboard on project changes', async () => {
    const { controls, click, field, edit, submit, commands, state, allow, root, copied } =
      clipboardPanel()

    allow(false)
    click('Copy component')
    expect(copied).toEqual([])
    allow(true)
    click('Copy component')
    await vi.waitFor(() => expect(field('Pasted component ID').value).toBe('description-copy'))
    edit('Pasted component ID', 'my-copy')
    allow(false)
    submit('Paste component')
    expect(commands).toEqual([])
    expect(controls.canNavigate('other')).toBe(false)
    controls.render({ ...state(), error: 'Conflict', conflict: true, preserveDrafts: true }, false)
    expect(field('Pasted component ID').value).toBe('my-copy')
    allow(true)
    click('Copy component')
    expect(copied).toHaveLength(1)
    click('Discard paste draft')
    expect(controls.canNavigate('other')).toBe(true)
    controls.render({ ...state(), path: 'different' }, true)
    expect(root.textContent).not.toContain('Paste component')
    expect(controls.hasDrafts()).toBe(false)
  })

  it('keeps the previous clipboard after a failed copy, validates inputs, and supports explicit clearing', async () => {
    const { click, field, edit, submit, commands, failCopy, root } = clipboardPanel()
    click('Copy component')
    await vi.waitFor(() => expect(field('Pasted component ID').value).toBe('description-copy'))
    failCopy()
    click('Copy component')
    await vi.waitFor(() =>
      expect(root.all().find((node) => node.tagName === 'fieldset')?.disabled).toBe(false),
    )
    expect(field('Pasted component ID').value).toBe('description-copy')
    edit('Paste row', '0')
    submit('Paste component')
    expect(commands).toEqual([])
    expect(field('Paste row').value).toBe('0')
    click('Clear component clipboard')
    expect(root.textContent).not.toContain('Paste component')
  })

  it('suggests placement that fits a smaller target grid', async () => {
    const { state } = clipboardPanel()
    const current = state()
    current.view.scenes[0]!.components[0]!.placement = {
      row: 5,
      column: 4,
      rowSpan: 2,
      columnSpan: 2,
    }
    current.view.scenes[1]!.screen.grid = { rows: 2, columns: 2 }
    // The copied snapshot is injected separately from the destination's projected view.
    const source = current.view.scenes[0]!.components[0]!
    const fixture = panel()

    const clipboard = bindComponentClipboard(fixture.root.asElement(), editorLocalization().t, {
      copy: async () => componentClipboardSchema.parse({ revision: 'one', component: source }),
      save: () => {},
      canChange: () => true,
      onSaved: () => {},
    })

    clipboard.render(current, true)
    clipboard.navigate('shop', 'description')
    fixture.click('Copy component')
    await vi.waitFor(() =>
      expect(fixture.field('Pasted component ID').value).toBe('description-copy'),
    )
    clipboard.navigate('other')
    expect(fixture.field('Paste row').value).toBe('2')
    expect(fixture.field('Paste column').value).toBe('2')
    expect(fixture.field('Paste row span').value).toBe('1')
    expect(fixture.field('Paste column span').value).toBe('1')
  })
})

function sceneControlsPanel() {
  const fixture = panel()
  let snapshot = project()
  let allowChanges = true
  let confirm = false
  const confirmations: string[] = []
  const saved: string[] = []

  const controls = bindSceneControls(fixture.root.asElement(), editorLocalization().t, {
    save: (command) => fixture.commands.push(command),
    canChange: () => allowChanges,
    confirmDelete: (message) => {
      confirmations.push(message)

      return confirm
    },
    onSaved: (command) => saved.push(command.type),
  })

  const state = () => ({ ...fixture.initial, view: inspectProject(snapshot) })
  controls.render(state(), true)
  controls.navigate('shop')

  return {
    ...fixture,
    controls,
    confirmations,
    saved,
    state,
    allow: (value: boolean) => {
      allowChanges = value
    },
    confirm: (value: boolean) => {
      confirm = value
    },
    persist: () => {
      const command = fixture.commands.at(-1)

      if (!command) throw new Error('Expected a scene command')
      snapshot = applyCommand(snapshot, command).project
      controls.render({ ...state(), preserveDrafts: true, lastCommand: command.type }, true)

      return inspectProject(snapshot)
    },
  }
}

describe('scene controls', () => {
  it('duplicates and confirms component deletion through shortcuts, protecting unrelated and local drafts', () => {
    const { controls, commands, allow, confirm, persist, edit, click } = sceneControlsPanel()
    expect(controls.shortcut('delete')).toBe(false)
    controls.navigate('shop', 'description')
    allow(false)
    expect(controls.shortcut('duplicate')).toBe(true)
    expect(commands).toEqual([])
    allow(true)
    edit('Duplicate component ID', 'Unsaved')
    expect(controls.shortcut('duplicate')).toBe(true)
    expect(controls.shortcut('delete')).toBe(true)
    expect(commands).toEqual([])
    click('Discard component-control draft')
    expect(controls.shortcut('duplicate')).toBe(true)
    expect(persist().scenes[0]!.components.map(({ id }) => id)).toEqual([
      'description',
      'description-copy',
    ])
    expect(controls.shortcut('delete')).toBe(true)
    expect(commands).toHaveLength(1)
    confirm(true)
    expect(controls.shortcut('delete')).toBe(true)
    expect(persist().scenes[0]!.components.map(({ id }) => id)).toEqual(['description'])
  })

  it('consumes singleton duplication shortcuts without writing and ignores shortcuts during saves', () => {
    const { controls, state, commands, root } = sceneControlsPanel()
    const current = state()
    current.view.scenes[0]!.components.push(bar)
    controls.render(current, true)
    controls.navigate('shop', 'actions')
    expect(controls.shortcut('duplicate')).toBe(true)
    expect(commands).toEqual([])
    expect(root.textContent).toContain('cannot be duplicated')
    controls.render({ ...current, busy: true }, false)
    expect(controls.shortcut('delete')).toBe(false)
    expect(commands).toEqual([])
  })

  it('explains singleton restrictions while retaining move controls', () => {
    const { controls, state, root, click, commands } = sceneControlsPanel()
    const current = state()
    current.view.scenes[0]!.components.push(bar)
    controls.render(current, true)
    controls.navigate('shop', 'actions')
    expect(root.textContent).toContain('cannot be duplicated')
    expect(root.textContent).not.toContain('Duplicate component')
    click('Move component up')
    expect(commands[0]).toEqual({
      type: 'scene.moveComponent',
      sceneId: 'shop',
      componentId: 'actions',
      index: 0,
    })
  })

  it('duplicates the selected component, suggests unused IDs, and keeps the copy selected when moving', () => {
    const { controls, field, submit, commands, persist, click, root } = sceneControlsPanel()
    controls.navigate('shop', 'description')
    expect(field('Duplicate component ID').value).toBe('description-copy')

    const button = (label: string) =>
      root.all().find((node) => node.tagName === 'button' && node.textContent === label)!

    expect(button('Move component up').disabled).toBe(true)
    expect(button('Move component down').disabled).toBe(true)
    submit('Duplicate component')
    expect(commands[0]).toEqual({
      type: 'scene.duplicateComponent',
      sceneId: 'shop',
      componentId: 'description',
      newId: 'description-copy',
    })
    expect(persist().scenes[0]!.components.map(({ id }) => id)).toEqual([
      'description',
      'description-copy',
    ])
    expect(field('Duplicate component ID').value).toBe('description-copy-copy')
    click('Move component up')
    expect(commands[1]).toEqual({
      type: 'scene.moveComponent',
      sceneId: 'shop',
      componentId: 'description-copy',
      index: 0,
    })
    expect(persist().scenes[0]!.components.map(({ id }) => id)).toEqual([
      'description-copy',
      'description',
    ])
    expect(button('Move component up').disabled).toBe(true)
    click('Move component down')
    expect(persist().scenes[0]!.components.map(({ id }) => id)).toEqual([
      'description',
      'description-copy',
    ])
    controls.navigate('shop', 'description')
    expect(field('Duplicate component ID').value).toBe('description-copy-2')
  })

  it('guards component drafts, preserves copy entries on conflicts and moves, and discards explicitly', () => {
    const { controls, field, edit, submit, commands, allow, state, click, persist } =
      sceneControlsPanel()

    controls.navigate('shop', 'description')
    edit('Duplicate component ID', 'copy')
    allow(false)
    submit('Duplicate component')
    expect(commands).toEqual([])
    allow(true)
    submit('Duplicate component')
    controls.render({ ...state(), conflict: true, error: 'Conflict', preserveDrafts: true }, false)
    expect(field('Duplicate component ID').value).toBe('copy')
    expect(controls.canNavigate('other')).toBe(false)
    submit('Duplicate component')
    persist()
    edit('Duplicate component ID', 'unsaved')
    click('Move component up')
    persist()
    expect(field('Duplicate component ID').value).toBe('unsaved')
    click('Discard component-control draft')
    expect(controls.hasDrafts()).toBe(false)
    expect(controls.canNavigate('other')).toBe(true)
  })

  it('renames and duplicates scenes, keeping the new target selected and drafts clean', () => {
    const { edit, submit, commands, controls, field, persist, saved } = sceneControlsPanel()
    edit('New scene ID', 'market')
    submit('Rename scene ID')
    expect(commands[0]).toEqual({ type: 'scene.rename', sceneId: 'shop', newId: 'market' })
    expect(persist().game?.scenes).toEqual(['market', 'other'])
    expect(field('New scene ID').value).toBe('market')
    expect(controls.hasDrafts()).toBe(false)
    edit('Duplicate scene ID', 'market-copy')
    edit('Duplicate scene title', 'Another market')
    submit('Duplicate scene')
    expect(commands[1]).toEqual({
      type: 'scene.duplicate',
      sceneId: 'market',
      newId: 'market-copy',
      title: 'Another market',
    })
    expect(persist().game?.scenes).toEqual(['market', 'other', 'market-copy'])
    expect(field('New scene ID').value).toBe('market-copy')
    expect(saved).toEqual(['scene.rename', 'scene.duplicate'])
  })

  it('sets the startup scene and confirms deletion with an optional replacement', () => {
    const { controls, click, edit, commands, confirm, persist, confirmations } =
      sceneControlsPanel()

    controls.navigate('other')
    click('Use as startup scene')
    expect(persist().game?.['initial-scene']).toBe('other')
    edit('Redirect links to', 'shop')
    click('Delete scene')
    expect(commands).toHaveLength(1)
    expect(confirmations[0]).toContain('other')
    confirm(true)
    click('Delete scene')
    expect(commands[1]).toEqual({
      type: 'scene.remove',
      sceneId: 'other',
      replacementScene: 'shop',
    })
    expect(persist().game?.['initial-scene']).toBe('shop')
  })

  it('offers generic component deletion and makes no write when confirmation is cancelled', () => {
    const { controls, click, commands, confirm, persist } = sceneControlsPanel()
    controls.navigate('shop', 'description')
    click('Delete component')
    expect(commands).toEqual([])
    confirm(true)
    click('Delete component')
    expect(commands[0]).toEqual({
      type: 'scene.removeComponent',
      sceneId: 'shop',
      componentId: 'description',
    })
    expect(persist().scenes[0]!.components).toEqual([])
  })

  it('guards unrelated drafts and preserves scene-control entries across validation and save failures', () => {
    const { controls, allow, edit, submit, root, commands, state, field, click } =
      sceneControlsPanel()

    edit('New scene ID', 'market')
    allow(false)
    submit('Rename scene ID')
    expect(commands).toEqual([])
    expect(root.textContent).toContain('pending edits')
    expect(controls.canNavigate('other')).toBe(false)
    controls.render({ ...state(), error: 'Conflict', conflict: true }, false)
    expect(field('New scene ID').value).toBe('market')
    allow(true)
    edit('New scene ID', 'invalid id')
    submit('Rename scene ID')
    expect(commands).toEqual([])
    expect(field('New scene ID').value).toBe('invalid id')
    click('Discard scene-control draft')
    expect(controls.hasDrafts()).toBe(false)
    expect(controls.canNavigate('other')).toBe(true)
  })

  it('discards scene-control entries on an explicitly confirmed project reopen', () => {
    const { controls, edit, field, state } = sceneControlsPanel()
    edit('New scene ID', 'unsaved')
    controls.render({ ...state(), preserveDrafts: false }, true)
    expect(field('New scene ID').value).toBe('shop')
    expect(controls.hasDrafts()).toBe(false)
  })
})

describe('adding scene components', () => {
  it('suggests unused IDs and placements that fit even a small scene', () => {
    const { editor, submit, persist, field } = addingComponentPanel()
    expect(field('Component ID').value).toBe('text')
    submit('Create component')
    expect(persist().diagnostics).toEqual([])
    editor.navigate('shop', undefined, true)
    expect(field('Component ID').value).toBe('text-2')
    expect(Number(field('Column span').value)).toBeLessThanOrEqual(5)
    expect(Number(field('Row span').value)).toBeLessThanOrEqual(6)
  })

  it('creates a text component, selects it after saving, and edits it without creating a duplicate', () => {
    const { editor, edit, submit, commands, persist, created, root } = addingComponentPanel()
    edit('Component ID', 'greeting')
    edit('Text', 'Hello, adventurer!')
    edit('Style', 'heading')
    edit('Alignment', 'center')
    edit('Row', '2')
    submit('Create component')
    expect(commands[0]).toMatchObject({
      type: 'scene.upsertComponent',
      sceneId: 'shop',
      createOnly: true,
      component: {
        id: 'greeting',
        type: 'text',
        text: 'Hello, adventurer!',
        presentation: { variant: 'heading', align: 'center' },
      },
    })
    expect(persist().scenes[0]!.components.map(({ id }) => id)).toEqual(['description', 'greeting'])
    expect(created).toEqual(['shop:greeting'])
    expect(editor.hasDrafts()).toBe(false)
    expect(root.textContent).toContain('Save component')
    edit('Text', 'Welcome back!')
    submit('Save component')
    expect(commands[1]).not.toHaveProperty('createOnly')
    expect(persist().scenes[0]!.components).toHaveLength(2)
  })

  it.each(['button', 'map-view', 'language-select', 'quest-log'])(
    'creates a valid %s with its configured settings',
    (type) => {
      const { edit, submit, commands, persist, field } = addingComponentPanel()
      edit('Component type', type)
      edit('Component ID', 'new-component')
      edit('Label', 'New component')

      if (type === 'button') {
        edit('Action', 'new-game')
        expect(field('Target scene').children.map(({ value }) => value)).toEqual(['shop'])
      }

      if (type === 'map-view') {
        expect(field('Columns', 'Visible area').value).toBe('3')
        expect(field('Rows', 'Visible area').value).toBe('2')
        edit('Show player', 'true')
        edit('Player column', '1')
        edit('Player row', '1')
      }

      submit('Create component')
      expect(commands[0]).toMatchObject({
        createOnly: true,
        component: { id: 'new-component', type },
      })
      expect(persist().diagnostics).toEqual([])
    },
  )

  it('rejects duplicate and invalid IDs and preserves drafts on conflicts and unrelated saves', () => {
    const { editor, state, edit, submit, commands, field, click, root } = addingComponentPanel()
    edit('Component ID', 'description')
    submit('Create component')
    expect(commands).toEqual([])
    expect(root.textContent).toContain('unique component ID')
    edit('Component ID', 'invalid id')
    submit('Create component')
    expect(commands).toEqual([])
    edit('Component ID', 'greeting')
    edit('Text', 'Preserve my draft')
    editor.render({ ...state(), conflict: true, error: 'Conflict' }, false)
    expect(field('Text').value).toBe('Preserve my draft')
    editor.render({ ...state(), lastCommand: 'scene.upsertNearby', preserveDrafts: true }, true)
    expect(field('Text').value).toBe('Preserve my draft')
    expect(editor.navigate('other', undefined, true)).toBe(false)
    edit('Component type', 'button')
    expect(field('Component type').value).toBe('text')
    click('Discard component draft')
    expect(editor.hasDrafts()).toBe(false)
    expect(editor.navigate('other', undefined, true)).toBe(true)
  })

  it('explains missing map and language resources and cancels without writing', () => {
    const { editor, root, edit, click, commands, cancelled } = addingComponentPanel(false)
    edit('Component type', 'map-view')
    expect(root.textContent).toContain('Create one in the Maps workspace')
    expect(
      root
        .all()
        .find((node) => node.tagName === 'button' && node.textContent === 'Create component')
        ?.disabled,
    ).toBe(true)
    edit('Component type', 'language-select')
    expect(root.textContent).toContain('selector will be disabled')
    edit('Label', 'Select a language')
    click('Cancel')
    expect(commands).toEqual([])
    expect(editor.hasDrafts()).toBe(false)
    expect(cancelled).toEqual(['shop'])
  })

  it('keeps invalid map dimensions and player positions available for correction', () => {
    const { edit, submit, commands, field, root } = addingComponentPanel()
    edit('Component type', 'map-view')
    edit('Columns', '4', 'Visible area')
    submit('Create component')
    expect(commands).toEqual([])
    expect(root.textContent).toContain('Viewport exceeds')
    expect(field('Columns', 'Visible area').value).toBe('4')
    edit('Columns', '3', 'Visible area')
    edit('Show player', 'true')
    edit('Player column', '3')
    submit('Create component')
    expect(commands).toEqual([])
    expect(root.textContent).toContain('Player spawn is outside')
  })
})

describe('nearby component editing', () => {
  it('edits and saves the selected panel when a scene contains multiple nearby panels', () => {
    const { editor, view, field, edit, submit, commands } = nearbyComponentPanel()
    expect(field('Nearby title').value).toBe('second')
    edit('Nearby title', 'Updated second panel')
    submit('Save nearby targets')
    expect(commands).toEqual([
      expect.objectContaining({
        type: 'scene.upsertNearby',
        sceneId: 'shop',
        component: expect.objectContaining({
          id: 'second',
          label: 'Updated second panel',
          descriptionTarget: 'other-description',
        }),
      }),
    ])
    editor.render(
      {
        path: 'demo',
        view,
        busy: false,
        error: 'Conflict',
        conflict: true,
        changedElsewhere: false,
        lastCommand: null,
        preserveDrafts: false,
      },
      false,
    )
    expect(field('Nearby title').value).toBe('Updated second panel')
    expect(editor.hasDrafts()).toBe(true)
    expect(view.scenes[0]!.components.find(({ id }) => id === 'first')).toMatchObject({
      label: 'first',
    })
  })

  it('clears the surrounding draft guard when nearby edits are discarded', () => {
    const { editor, field, edit, click, root, commands } = nearbyComponentPanel()
    edit('Nearby title', 'Unsaved second panel')
    expect(editor.hasDrafts()).toBe(true)
    expect(editor.navigate('shop', 'description')).toBe(false)
    click('Discard nearby draft')
    expect(field('Nearby title').value).toBe('second')
    expect(editor.hasDrafts()).toBe(false)
    expect(root.textContent).not.toContain('Save or discard the component draft first.')
    expect(editor.navigate('shop', 'description')).toBe(true)
    expect(commands).toEqual([])
  })

  it('keeps translation suggestions attached after nearby forms are rebuilt', () => {
    const { root, edit, click } = nearbyComponentPanel()

    const assertSuggestions = () => {
      const inputs = root
        .all()
        .filter((node) => node.tagName === 'input' && node.attributes.has('list'))

      expect(inputs.length).toBeGreaterThan(0)

      for (const input of inputs) {
        const list = root
          .all()
          .find((node) => node.tagName === 'datalist' && node.id === input.attributes.get('list'))

        expect(list?.children.map((option) => option.value)).toEqual(['nearby.title'])
      }
    }

    assertSuggestions()
    edit('New nearby target ID', 'guide')
    click('Add nearby target')
    assertSuggestions()
    edit('New nearby target ID', 'guard')
    click('Add nearby target')
    assertSuggestions()
    click('Remove nearby target')
    assertSuggestions()
    click('Discard nearby draft')
    assertSuggestions()
  })
})

describe('action bar editor controls', () => {
  it('configures usable items, preserves conflicting drafts, and binds Use through existing input controls', () => {
    const { initial, root, edit, submit, commands, field } = panel()
    const view = structuredClone(initial.view!)
    view.inventory = inventorySchema.parse({
      'schema-version': '1.0.0',
      itemTypes: { potion: { label: 'Potion' } },
      owners: { player: { label: 'Player' } },
      items: {},
    })
    view.combatLibraries = {
      items: combatLibrarySchema.parse({
        'schema-version': '1.0.0',
        id: 'items',
        moves: {
          heal: {
            type: 'ability',
            label: 'Recover',
            apCost: 1,
            cooldown: 2,
            target: 'self',
            effects: [{ id: 'heal', type: 'heal', amount: 10 }],
          },
        },
      }),
    }
    view.scenes[0]!.components.push(
      sceneComponentSchema.parse({
        id: 'items',
        type: 'inventory',
        owners: ['player'],
        placement: { row: 1, column: 1 },
      }),
    )
    const editor = bindItemEditor(root.asElement(), (command) => commands.push(command))
    editor.render({ ...initial, view }, true)
    edit('Item editing target', 'item:potion')
    edit('Built-in item use', 'enabled')
    edit('Item shared ability', 'items/heal')
    edit('Item consumption', 'keep')
    edit('Item availability', 'combat,outside-combat')
    edit('Item use noEffect text', 'Nothing to restore.')
    editor.render(
      { ...initial, view: { ...view, revision: 'conflict' }, conflict: true, preserveDrafts: true },
      false,
    )
    expect(field('Item consumption').value).toBe('keep')
    expect(field('Item use noEffect text').value).toBe('Nothing to restore.')
    submit('Save items and equipment')
    expect(commands[0]).toMatchObject({
      type: 'inventory.setItemPresentation',
      use: {
        ability: { library: 'items', id: 'heal' },
        consumption: 'keep',
        contexts: ['combat', 'outside-combat'],
        messages: { noEffect: 'Nothing to restore.' },
      },
    })
    bindActionBarPanel(root.asElement(), (command) => commands.push(command)).render(
      { ...initial, view },
      true,
    )
    edit('Action type', 'item-use')
    edit('Slot label', 'Use')
    edit('Item-use inventory', 'items')
    edit('Input context', 'gameplay')
    edit('Virtual input', 'slot-1')
    submit('Save action bar')
    expect(commands[1]).toMatchObject({
      type: 'scene.setActionBar',
      component: {
        slots: {
          '1': {
            action: { type: 'item-use', inventory: 'items' },
            inputBinding: { context: 'gameplay', input: 'slot-1' },
          },
        },
      },
    })
  })
  it('edits shared libraries without flattening imports and preserves both conflicting drafts', () => {
    const { initial, root, edit, click, submit, commands, field } = panel()
    initial.view!.rules = {
      state: [
        { path: ['health'], value: 40 },
        { path: ['enemyHealth'], value: 20 },
      ],
      actions: {},
    }
    const editor = bindCombatEditor(root.asElement(), (command) => commands.push(command))
    editor.render(initial, true)
    click('Add combat library')
    edit('New status ID', 'poison')
    click('Add status')
    edit('New move ID', 'poison-strike')
    click('Add ability move')
    edit('Ability target', 'enemy', 'Move: poison-strike')
    edit('Effect type', 'apply-status', 'Effect 1')
    edit('Status', 'poison', 'Effect 1')
    edit('Duration (affected turns)', '5', 'Status: poison')
    click('Add encounter')
    edit('Encounter name', 'Local encounter draft')
    editor.render(
      {
        ...initial,
        view: { ...initial.view!, revision: 'conflicting' },
        preserveDrafts: true,
        conflict: true,
      },
      false,
    )
    expect(field('Encounter name').value).toBe('Local encounter draft')
    expect(field('Duration (affected turns)', 'Status: poison').value).toBe('5')
    click('Discard combat draft')
    expect(field('Duration (affected turns)', 'Status: poison').value).toBe('5')
    submit('Save combat library')
    const command = commands[0]!
    expect(command).toMatchObject({
      type: 'game.upsertCombatLibrary',
      library: { id: 'common', moves: { 'poison-strike': { effects: [{ status: 'poison' }] } } },
    })

    if (command.type !== 'game.upsertCombatLibrary') throw new Error('Expected library save')
    const view = { ...initial.view!, combatLibraries: { common: command.library } }
    editor.render({ ...initial, view, lastCommand: command.type, preserveDrafts: true }, true)
    expect(editor.hasDrafts()).toBe(false)
    click('Add encounter')
    edit('Shared moves to import', 'common/poison-strike')
    click('Import shared moves')
    expect(root.textContent).toContain('automatic ability dependency')
    expect(field('Available moves (IDs)', 'Player').value).toBe('attack, guard')
    submit('Save combat encounter')
    expect(commands[1]).toMatchObject({
      type: 'game.upsertCombat',
      encounter: { sharedMoves: [{ library: 'common', id: 'poison-strike' }] },
    })
    expect(object(commands[1]).encounter).not.toHaveProperty('statuses')
    expect(object(object(commands[1]).encounter).moves).not.toHaveProperty('poison-strike')
    click('Edit library common')
    edit('Duration (affected turns)', '7', 'Status: poison')
    click('Edit library common')
    expect(field('Duration (affected turns)', 'Status: poison').value).toBe('7')
    click('Discard combat draft')
    expect(editor.hasDrafts()).toBe(true)
    click('Discard library draft')
    expect(editor.hasDrafts()).toBe(false)
  })
  it('authors level tables, gains, health policies and progression views without losing drafts', () => {
    const { initial, root, edit, click, submit, commands, field } = panel()
    const view = structuredClone(initial.view!)
    view.rules = {
      state: [
        { path: ['experience'], value: 0 },
        { path: ['level'], value: 1 },
        { path: ['health'], value: 20 },
        { path: ['maximumHealth'], value: 30 },
      ],
      actions: {},
    }
    const editor = bindLevelingEditor(root.asElement(), (command) => commands.push(command))
    editor.render({ ...initial, view }, true)
    click('Add leveling profile')
    edit('Profile label', 'Progression draft')
    edit('Total XP needed', '5', 'Level 2')
    click('Add level 2 stat gain')
    edit('Amount added', '6', 'Level 2 · stat gain 1')
    edit('Health on level-up', 'yes')
    edit('Current health after a level-up', 'increase')
    edit('Show level-up messages in', 'description')
    expect(root.textContent).toContain('Level 2 · 5 XP · Maximum health +6')
    edit('Leveling game scene', 'other')
    expect(field('Leveling game scene').value).toBe('shop')
    editor.render(
      { ...initial, view: { ...view, revision: 'conflict' }, conflict: true, preserveDrafts: true },
      false,
    )
    editor.render(
      {
        ...initial,
        view: { ...view, revision: 'unrelated' },
        lastCommand: 'game.updateRules',
        preserveDrafts: true,
      },
      true,
    )
    expect(field('Amount added', 'Level 2 · stat gain 1').value).toBe('6')
    submit('Save character levels')
    const saved = commands[0]!
    expect(saved).toMatchObject({
      type: 'game.upsertLeveling',
      profile: {
        label: 'Progression draft',
        xp: { path: ['experience'] },
        level: { path: ['level'] },
        levels: [{ xp: 0 }, { xp: 5, gains: [{ amount: 6, field: { path: ['maximumHealth'] } }] }],
        health: { policy: 'increase' },
      },
      scene: {
        id: 'shop',
        component: { type: 'character-progression', textTarget: 'description' },
      },
    })

    if (saved.type !== 'game.upsertLeveling' || !saved.scene)
      throw new Error('Expected progression')
    view.leveling = { [saved.profile.id]: saved.profile }
    view.scenes[0]!.components.push(saved.scene.component)
    editor.render(
      {
        ...initial,
        view: { ...view, revision: 'saved' },
        lastCommand: saved.type,
        preserveDrafts: true,
      },
      true,
    )
    expect(editor.hasDrafts()).toBe(false)
  })
  it('authors combat definitions and input commands while retaining conflicting and unrelated drafts', () => {
    const { initial, root, edit, click, submit, commands, field } = panel()
    const view = structuredClone(initial.view!)
    view.rules = {
      state: [
        { path: ['health'], value: 40 },
        { path: ['enemyHealth'], value: 20 },
        { path: ['gold'], value: 0 },
      ],
      actions: {},
    }
    view.inventory = inventorySchema.parse({
      'schema-version': '1.0.0',
      itemTypes: { token: { label: 'Token' } },
      owners: { player: { label: 'Player' }, loot: { label: 'Loot' } },
      items: {},
    })
    view.scenes[0]!.components.push(
      sceneComponentSchema.parse({
        id: 'loot',
        type: 'inventory',
        owners: ['loot'],
        readOnly: true,
        placement: { row: 1, column: 2 },
      }),
    )
    const editor = bindCombatEditor(root.asElement(), (command) => commands.push(command))
    editor.render({ ...initial, view }, true)
    click('Add encounter')
    edit('Encounter name', '<b>Training</b>')
    edit('AP', '4', 'Player')
    edit('Rotation (IDs)', 'guard, attack', 'Enemy 1')
    edit('Available moves (IDs)', 'attack, guard', 'Enemy 1')
    edit('Maximum damage', '7', 'Move: attack')
    edit('New status ID', 'poison')
    click('Add status')
    edit('Duration (affected turns)', '3', 'Status: poison')
    edit('Amount', '2', 'Status: poison')
    click('Add ability move')
    edit('Cooldown (subsequent rounds)', '2', 'Move: ability')
    edit('Ability target', 'enemy', 'Move: ability')
    edit('Effect type', 'apply-status', 'Effect 1')
    edit('Status', 'poison', 'Effect 1')
    edit('Allow escape', 'true')
    edit('Victory destination', 'other')
    edit('Enable victory rewards', 'yes')
    edit('Reward recipient owner', 'player')
    edit('Reward loot owner', 'loot')
    click('Add numeric reward')
    edit('Reward 1 field', JSON.stringify({ source: 'game.state', path: ['gold'] }))
    edit('Reward 1 amount', '8')
    click('Add loot drop')
    edit('Drop 1 chance (0–10000)', '5000')
    edit('Combat loot inventory', 'loot')
    expect(editor.hasDrafts()).toBe(true)
    edit('Combat game scene', 'other')
    expect(field('Combat game scene').value).toBe('shop')
    editor.render(
      { ...initial, view: { ...view, revision: 'conflict' }, conflict: true, preserveDrafts: true },
      false,
    )
    expect(field('Encounter name').value).toBe('<b>Training</b>')
    editor.render(
      {
        ...initial,
        view: { ...view, revision: 'unrelated' },
        lastCommand: 'game.updateRules',
        preserveDrafts: true,
      },
      true,
    )
    expect(field('Maximum damage', 'Move: attack').value).toBe('7')
    expect(field('Reward 1 amount').value).toBe('8')
    expect(field('Cooldown (subsequent rounds)', 'Move: ability').value).toBe('2')
    submit('Save combat encounter')
    const saved = commands[0]!
    expect(saved).toMatchObject({
      type: 'game.upsertCombat',
      encounter: {
        label: '<b>Training</b>',
        player: { ap: 4 },
        enemies: [{ rotation: ['guard', 'attack'] }],
        moves: {
          attack: { damage: { max: 7 } },
          ability: {
            type: 'ability',
            cooldown: 2,
            target: 'enemy',
            effects: [{ type: 'apply-status', status: 'poison' }],
          },
        },
        statuses: { poison: { type: 'damage', duration: 3, amount: 2 } },
        allowEscape: true,
        outcomes: { victory: 'other' },
        rewards: {
          recipient: 'player',
          lootOwner: 'loot',
          numeric: [{ amount: 8, field: { path: ['gold'] } }],
          drops: [{ itemType: 'token', chance: 5000 }],
        },
      },
    })

    if (saved.type !== 'game.upsertCombat' || !saved.scene) throw new Error('Expected encounter')
    view.combat = { [saved.encounter.id]: saved.encounter }
    view.combatSources = { [saved.encounter.id]: saved.encounter }
    view.scenes[0]!.components.push(saved.scene.component)
    editor.render(
      {
        ...initial,
        view: { ...view, revision: 'saved' },
        lastCommand: saved.type,
        preserveDrafts: true,
      },
      true,
    )
    expect(editor.hasDrafts()).toBe(false)
    bindActionBarPanel(root.asElement(), (command) => commands.push(command)).render(
      { ...initial, view },
      true,
    )
    edit('Action type', 'combat-action')
    edit('Slot label', 'Strike')
    edit('Combat view', saved.scene.component.id)
    edit('Combat command', 'take-loot')
    submit('Save action bar')
    expect(commands[1]).toMatchObject({
      type: 'scene.setActionBar',
      component: {
        slots: {
          '1': {
            action: {
              type: 'combat-action',
              combat: saved.scene.component.id,
              command: { type: 'take-loot' },
            },
            inputBinding: { context: 'gameplay', input: 'slot-1' },
          },
        },
      },
    })
  })
  it('follows the editor language in section editors and keeps the draft when it changes', () => {
    const { initial, root, edit, click, field } = panel()
    const view = structuredClone(initial.view!)
    view.inventory = inventorySchema.parse({
      'schema-version': '1.0.0',
      itemTypes: {},
      owners: { player: { label: 'Player' }, merchant: { label: 'Merchant' } },
      items: {},
    })
    let language = 'nl'

    const editor = bindShopEditor(
      root.asElement(),
      () => {},
      (key, values) => editorLocalization([language]).t(key, values),
    )

    const state = { ...initial, view }
    editor.render(state, true)
    click('Winkel toevoegen')
    edit('Winkeltitel', 'Marktkraam')
    expect(field('Winkeltitel').value).toBe('Marktkraam')

    language = 'en'
    editor.render(state, false)
    expect(field('Shop title').value).toBe('Marktkraam')
    expect(() => field('Winkeltitel')).toThrow('Missing field')
    expect(editor.hasDrafts()).toBe(true)
  })
  it('authors shop participants and prices, preserves conflicting drafts, and binds trade shortcuts', () => {
    const { initial, root, edit, click, submit, commands, field } = panel()
    const view = structuredClone(initial.view!)
    view.rules = {
      state: [
        { path: ['gold'], value: 20 },
        { path: ['merchantGold'], value: 10 },
      ],
      actions: {},
    }
    view.inventory = inventorySchema.parse({
      'schema-version': '1.0.0',
      itemTypes: { coat: { label: 'Coat' } },
      owners: { player: { label: 'Player' }, merchant: { label: 'Merchant' } },
      items: {},
    })
    const editor = bindShopEditor(root.asElement(), (command) => commands.push(command))
    editor.render({ ...initial, view }, true)
    click('Add shop')
    edit('Shop title', 'A shop draft')
    edit('Merchant funds policy', 'finite')
    edit('Merchant balance field', JSON.stringify({ source: 'game.state', path: ['merchantGold'] }))
    click('Add prices')
    edit('Buy amount', '7')
    edit('Sell price source', 'fixed')
    edit('Sell amount', '4')
    edit('Bought message', 'Acquired {item}.')
    edit('Shop game scene', 'other')
    expect(field('Shop game scene').value).toBe('shop')
    editor.render(
      { ...initial, view: { ...view, revision: 'conflict' }, conflict: true, preserveDrafts: true },
      false,
    )
    expect(field('Shop title').value).toBe('A shop draft')
    editor.render(
      {
        ...initial,
        view: { ...view, revision: 'unrelated' },
        lastCommand: 'game.updateRules',
        preserveDrafts: true,
      },
      true,
    )
    expect(field('Buy amount').value).toBe('7')
    submit('Save shop')
    expect(commands[0]).toMatchObject({
      type: 'scene.upsertShop',
      component: {
        label: 'A shop draft',
        merchantFunds: { type: 'finite' },
        prices: { coat: { buy: 7, sell: 4 } },
        messages: { bought: 'Acquired {item}.' },
      },
      panels: [
        expect.objectContaining({ owners: ['player'], readOnly: true }),
        expect.objectContaining({ owners: ['merchant'], readOnly: true }),
      ],
    })
    const saved = commands[0]!

    if (saved.type !== 'scene.upsertShop') throw new Error('Expected shop')
    view.scenes[0]!.components.push(saved.component, ...(saved.panels ?? []))
    editor.render(
      {
        ...initial,
        view: { ...view, revision: 'saved' },
        lastCommand: 'scene.upsertShop',
        preserveDrafts: true,
      },
      true,
    )
    expect(editor.hasDrafts()).toBe(false)
    bindActionBarPanel(root.asElement(), (command) => commands.push(command)).render(
      { ...initial, view },
      true,
    )
    edit('Action type', 'shop-action')
    edit('Slot label', 'Buy')
    edit('Shop', saved.component.id)
    edit('Trade operation', 'buy')
    submit('Save action bar')
    expect(commands[1]).toMatchObject({
      type: 'scene.setActionBar',
      component: {
        slots: {
          '1': { action: { type: 'shop-action', shop: saved.component.id, operation: 'buy' } },
        },
      },
    })
  })
  it('authors item properties and linked equipment views while retaining conflicting drafts', () => {
    const { initial, root, edit, click, submit, commands, field } = panel()
    const view = structuredClone(initial.view!)
    view.inventory = inventorySchema.parse({
      'schema-version': '1.0.0',
      itemTypes: { cloak: { label: 'Cloak', equipmentSlots: ['body'] } },
      owners: { player: { label: 'Player', equipmentSlots: { body: 'Body' } } },
      items: {},
    })
    view.scenes[0]!.components.push(
      sceneComponentSchema.parse({
        id: 'items',
        type: 'inventory',
        label: 'Items',
        owners: ['player'],
        placement: { row: 1, column: 1 },
      }),
    )
    const editor = bindItemEditor(root.asElement(), (command) => commands.push(command))
    editor.render({ ...initial, view }, true)
    edit('Item editing target', 'item:cloak')
    edit('Description', 'A warm cloak')
    edit('Combat equipment effects', 'enabled')
    edit('Equipment attack bonus', '4')
    click('Add property')
    edit('Property label', 'Value')
    edit('Property value type', 'number')
    edit('Property value', '12')
    expect(editor.hasDrafts()).toBe(true)
    edit('Items game scene', 'other')
    expect(field('Items game scene').value).toBe('shop')
    editor.render(
      { ...initial, view: { ...view, revision: 'conflict' }, conflict: true, preserveDrafts: true },
      false,
    )
    expect(field('Description').value).toBe('A warm cloak')
    editor.render(
      {
        ...initial,
        view: { ...view, revision: 'unrelated' },
        lastCommand: 'game.updateRules',
        preserveDrafts: true,
      },
      true,
    )
    expect(field('Property value').value).toBe('12')
    submit('Save items and equipment')
    expect(commands[0]).toMatchObject({
      type: 'inventory.setItemPresentation',
      itemType: 'cloak',
      combatBonuses: { attack: 4, defense: 0, guard: 0, maximumHealth: 0 },
      presentation: {
        description: 'A warm cloak',
        properties: [{ id: 'property', label: 'Value', value: 12 }],
      },
    })
    click('Discard item draft')
    click('Add equipment')
    edit('Equipment owner', 'player')
    edit('Grid columns', '2')
    edit('Show equipment stats', 'true')
    edit('Slot order (comma separated IDs)', 'body')
    submit('Save items and equipment')
    expect(commands[1]).toMatchObject({
      type: 'scene.upsertItemView',
      component: {
        type: 'equipment',
        inventory: 'items',
        owner: 'player',
        columns: 2,
        showCombatStats: true,
        order: ['body'],
      },
    })
    const saved = commands[1]!

    if (saved.type !== 'scene.upsertItemView') throw new Error('Expected item view')
    view.scenes[0]!.components.push(saved.component)
    editor.render(
      {
        ...initial,
        view: { ...view, revision: 'saved' },
        lastCommand: 'scene.upsertItemView',
        preserveDrafts: true,
      },
      true,
    )
    expect(editor.hasDrafts()).toBe(false)
    bindActionBarPanel(root.asElement(), (command) => commands.push(command)).render(
      { ...initial, view },
      true,
    )
    edit('Action type', 'equipment-action')
    edit('Slot label', 'Wear')
    edit('Equipment view', saved.component.id)
    edit('Equipment operation', 'equip')
    submit('Save action bar')
    expect(commands[2]).toMatchObject({
      type: 'scene.setActionBar',
      component: {
        slots: {
          '1': {
            action: { type: 'equipment-action', equipment: saved.component.id, operation: 'equip' },
          },
        },
      },
    })
  })
  it('authors owner stat bindings and retains profile drafts across unrelated refreshes', () => {
    const { initial, root, edit, click, submit, commands, field } = panel()
    const view = structuredClone(initial.view!)
    view.rules = {
      state: [
        { path: ['hp'], value: 20 },
        { path: ['max'], value: 30 },
      ],
      actions: {},
    }
    view.inventory = inventorySchema.parse({
      'schema-version': '1.0.0',
      owners: { player: { label: 'Player', equipmentSlots: { hand: 'Hand' } } },
      itemTypes: { sword: { label: 'Sword', equipmentSlots: ['hand'] } },
      items: {},
    })
    const editor = bindItemEditor(root.asElement(), (command) => commands.push(command))
    editor.render({ ...initial, view }, true)
    edit('Item editing target', 'owner:player')
    edit('Combat stat profile', 'enabled')
    edit('Source', JSON.stringify({ source: 'game.state', path: ['max'] }), 'Base maximumHealth')
    edit('Value', '3', 'Base defense')
    edit('Item editing target', 'item:sword')
    expect(field('Item editing target').value).toBe('owner:player')
    editor.render(
      { ...initial, view: { ...view, revision: 'conflict' }, preserveDrafts: true, conflict: true },
      false,
    )
    expect(field('Value', 'Base defense').value).toBe('3')
    submit('Save items and equipment')
    expect(commands[0]).toMatchObject({
      type: 'inventory.setEquipmentSlots',
      owner: 'player',
      combatStats: {
        health: { source: 'game.state', path: ['hp'] },
        maximumHealth: { source: 'game.state', path: ['max'] },
        defense: 3,
      },
    })
    click('Discard item draft')
    expect(field('Combat stat profile').value).toBe('disabled')
  })
  it('authors and reorders status rows and effects while preserving conflicting and unrelated drafts', () => {
    const { initial, root, edit, click, submit, commands, field } = panel()
    const view = structuredClone(initial.view!)
    view.rules = {
      state: [
        { path: ['health'], value: 40 },
        { path: ['active'], value: true },
      ],
      actions: {},
    }
    const controls = bindStatusPanelEditor(root.asElement(), (command) => commands.push(command))
    controls.render({ ...initial, view }, true)
    click('Add status panel')
    edit('Status panel title', 'Player')
    click('Add resource bar')
    edit('Row 1 label', 'Health')
    edit('Row 1 value source', JSON.stringify({ source: 'game.state', path: ['health'] }))
    edit('Row 1 maximum', '40')
    click('Add value row')
    edit('Row 2 label', 'Currency')
    edit('Row 2 value', '12')
    click('Move row 2 up')
    click('Add status effect')
    edit('Effect 1 label', 'Ready')
    edit('Effect 1 description', 'Ready to act.')
    edit('Effect 1 visibility', JSON.stringify({ source: 'game.state', path: ['active'] }))
    expect(controls.hasDrafts()).toBe(true)
    edit('Status game scene', 'other')
    expect(field('Status game scene').value).toBe('shop')
    controls.render({ ...initial, view, conflict: true, preserveDrafts: true }, false)
    expect(field('Status panel title').value).toBe('Player')
    controls.render(
      {
        ...initial,
        view: { ...view, revision: 'new' },
        lastCommand: 'game.updateRules',
        preserveDrafts: true,
      },
      true,
    )
    expect(field('Row 1 label').value).toBe('Currency')
    submit('Save status panel')
    expect(commands[0]).toMatchObject({
      type: 'scene.upsertStatusPanel',
      sceneId: 'shop',
      component: {
        label: 'Player',
        rows: [
          { id: 'value-1', type: 'value', label: 'Currency', value: '12' },
          {
            id: 'bar-1',
            type: 'bar',
            label: 'Health',
            value: { source: 'game.state', path: ['health'] },
            maximum: 40,
          },
        ],
        effects: [
          {
            label: 'Ready',
            description: 'Ready to act.',
            visibleWhen: { source: 'game.state', path: ['active'] },
          },
        ],
      },
    })
    const saved = commands[0]!

    if (saved.type !== 'scene.upsertStatusPanel') throw new Error('Expected status command')
    view.scenes[0]!.components.push(saved.component)
    controls.render(
      {
        ...initial,
        view: { ...view, revision: 'saved' },
        lastCommand: 'scene.upsertStatusPanel',
        preserveDrafts: true,
      },
      true,
    )
    expect(controls.hasDrafts()).toBe(false)
    click('Remove status panel')
    expect(commands[1]).toMatchObject({
      type: 'scene.removeStatusPanel',
      sceneId: 'shop',
      componentId: saved.component.id,
    })
  })

  it('authors selectable nearby targets and links their action-bar provider', () => {
    const { initial, root, edit, click, submit, commands } = panel()
    const view = structuredClone(initial.view!)
    view.scenes[0]!.components.push(
      sceneComponentSchema.parse({
        id: 'narrative',
        type: 'text',
        text: 'A room.',
        placement: { row: 1, column: 2 },
      }),
    )
    view.rules = { state: [], actions: { talk: [{ when: [], effects: [] }] } }
    root.replaceChildren()
    root.asElement().append(
      nearbyForm(
        ruleFormControls(root.ownerDocument.asDocument(), () => {}),
        view,
        (command) => commands.push(command),
      ),
    )
    edit('New nearby target ID', 'guide')
    click('Add nearby target')
    edit('Target kind', 'character')
    edit('Target label', 'Guide')
    edit('Target description', 'A helpful guide.')
    edit('New nearby action ID', 'talk')
    click('Add nearby action')
    submit('Save nearby targets')
    expect(commands[0]).toMatchObject({
      type: 'scene.upsertNearby',
      sceneId: 'shop',
      component: {
        descriptionTarget: 'narrative',
        entries: {
          guide: {
            kind: 'character',
            label: 'Guide',
            description: 'A helpful guide.',
            actions: { talk: { action: 'talk' } },
          },
        },
      },
    })
    const saved = commands[0]!

    if (saved.type !== 'scene.upsertNearby') throw new Error('Expected nearby command')
    view.scenes[0]!.components.push(saved.component)
    bindActionBarPanel(root.asElement(), (command) => commands.push(command)).render(
      { ...initial, view },
      true,
    )
    edit('Action type', 'nearby-action')
    edit('Slot label', 'Talk')
    edit('Nearby panel', saved.component.id)
    edit('Target action ID', 'talk')
    submit('Save action bar')
    expect(commands[1]).toMatchObject({
      type: 'scene.setActionBar',
      component: {
        slots: {
          '1': { action: { type: 'nearby-action', nearby: saved.component.id, action: 'talk' } },
        },
      },
    })
  })

  it('authors directional movement for an interactive map in the selected scene', () => {
    const { controls, initial, edit, submit, commands } = panel()
    const view = structuredClone(initial.view!)
    view.scenes[0]!.components.push(
      sceneComponentSchema.parse({
        id: 'world-map',
        type: 'map-view',
        map: 'world',
        label: 'World map',
        placement: { row: 1, column: 2 },
        viewport: { columns: 3, rows: 3 },
        playerSpawn: { x: 1, y: 1 },
      }),
    )
    controls.render({ ...initial, view }, true)
    edit('Action type', 'move-map')
    edit('Slot label', 'West')
    edit('Target map view', 'world-map')
    edit('Direction', 'west')
    submit('Save action bar')
    expect(commands[0]).toMatchObject({
      type: 'scene.setActionBar',
      component: {
        slots: {
          '1': {
            label: 'West',
            action: { type: 'move-map', mapView: 'world-map', direction: 'west' },
          },
        },
      },
    })
  })

  it('configures inline inspection independently of its action and output binding', () => {
    const { initial, root, edit, submit, commands } = panel()
    const view = structuredClone(initial.view!)
    view.rules = {
      state: [{ path: ['result'], value: '' }],
      actions: { inspect: [{ when: [], effects: [] }] },
    }
    view.inventory = inventorySchema.parse({
      'schema-version': '1.0.0',
      itemTypes: {
        letter: {
          label: 'Letter',
          inspection: {
            action: 'inspect',
            details: { source: 'game.state', path: ['result'] },
          },
        },
      },
      owners: {},
      items: {},
    })
    root.replaceChildren()
    root.asElement().append(
      ...ruleTriggerForms(
        ruleFormControls(root.ownerDocument.asDocument(), () => {}),
        view,
        (command) => commands.push(command),
      ),
    )
    expect(root.textContent).toContain('To show results in the main text')
    edit('Show inspection in inventory', 'no')
    submit('Save inspection')
    expect(commands[0]).toEqual({
      type: 'inventory.setRuleInspection',
      itemType: 'letter',
      inspection: {
        action: 'inspect',
        details: { source: 'game.state', path: ['result'] },
        inline: false,
      },
    })
  })

  it('authors inventory providers and game-defined selected-item actions', () => {
    const { controls, initial, edit, submit, commands, root, click } = panel()
    const view = structuredClone(initial.view!)
    view.game!.inventory = ['items']
    view.game!.rules = ['items']
    view.rules = { state: [], actions: { act: [{ when: [], effects: [] }] } }
    view.inventory = inventorySchema.parse({
      'schema-version': '1.0.0',
      itemTypes: { letter: { label: 'Letter' } },
      owners: { player: { label: 'Player' } },
      items: {},
    })
    view.scenes[0]!.components.push(
      sceneComponentSchema.parse({
        id: 'items',
        type: 'inventory',
        label: 'Inventory',
        owners: ['player'],
        placement: { row: 1, column: 2 },
      }),
    )
    controls.render({ ...initial, view }, true)
    edit('Action type', 'inventory-action')
    edit('Slot label', 'Inspect')
    edit('Inventory panel', 'items')
    edit('Item action ID', 'inspect')
    submit('Save action bar')
    expect(commands[0]).toMatchObject({
      type: 'scene.setActionBar',
      component: {
        slots: {
          '1': { action: { type: 'inventory-action', inventory: 'items', action: 'inspect' } },
        },
      },
    })
    root.replaceChildren()
    let edited = false
    root.asElement().append(
      inventoryActionsForm(
        ruleFormControls(root.ownerDocument.asDocument(), () => {
          edited = true
        }),
        view,
        (command) => {
          commands.push(command)
        },
      ),
    )
    click('Add item action')
    edit('Item action ID', 'read')
    submit('Save item actions')
    expect(edited).toBe(true)
    expect(commands[1]).toEqual({
      type: 'inventory.setItemActions',
      itemType: 'letter',
      actions: { read: { action: 'act' } },
    })
  })
  it('edits slot content and bindings, preserves dirty drafts on conflict, and guards scene changes', () => {
    const { controls, commands, root, initial, field, edit, submit } = panel()
    expect(root.all().filter((node) => node.className === 'action-bar-slot')).toHaveLength(15)
    edit('Slot label', 'Changed')
    edit('Virtual input', 'slot-2')
    expect(controls.hasDrafts()).toBe(true)
    edit('Game scene', 'other')
    expect(field('Game scene').value).toBe('shop')
    controls.render({ ...initial, conflict: true, preserveDrafts: true }, false)
    controls.render(
      { ...initial, preserveDrafts: true, view: { ...initial.view!, revision: 'new' } },
      true,
    )
    expect(field('Slot label').value).toBe('Changed')
    submit('Save action bar')
    expect(commands[0]).toMatchObject({
      type: 'scene.setActionBar',
      sceneId: 'shop',
      component: { slots: { '1': { label: 'Changed', inputBinding: { input: 'slot-2' } } } },
    })
  })

  it('supports creating input and a bar for a game that has neither', () => {
    const { controls, commands, initial, edit, click, submit } = panel(false)
    click('Game input bindings')
    click('Create input configuration')
    edit('Input file ID', 'controls')
    submit('Save input bindings')
    expect(commands[0]).toMatchObject({
      type: 'game.updateInput',
      inputId: 'controls',
      input: { keyboard: { KeyQ: 'slot-1', KeyB: 'slot-15' } },
    })
    const created = applyCommand(project(false), commands[0]!)
    controls.render(
      {
        ...initial,
        view: inspectProject(created.project),
        preserveDrafts: true,
        lastCommand: 'game.updateInput',
      },
      true,
    )
    click('Scene action bar')
    click('Add action bar')
    edit('Action type', 'enter-scene')
    edit('Slot label', 'Visit')
    edit('Target scene', 'other')
    edit('Input context', 'gameplay')
    edit('Virtual input', 'slot-1')
    submit('Save action bar')
    expect(commands[1]).toMatchObject({
      type: 'scene.setActionBar',
      component: {
        slots: {
          '1': {
            label: 'Visit',
            action: { type: 'enter-scene', scene: 'other' },
            inputBinding: { context: 'gameplay', input: 'slot-1' },
          },
        },
      },
    })
  })

  it('validates input edits without losing entries and preserves the input draft after a bar save', () => {
    const { controls, commands, initial, field, edit, click, submit, root } = panel()
    click('Game input bindings')
    edit('Physical key code', 'Digit1')
    submit('Save input bindings')
    expect(commands).toEqual([])
    expect(root.textContent).toContain('duplicate keys')
    edit('Physical key code', 'KeyJ')
    controls.render(
      {
        ...initial,
        preserveDrafts: true,
        lastCommand: 'scene.setActionBar',
        view: { ...initial.view!, revision: 'saved' },
      },
      true,
    )
    expect(field('Physical key code').value).toBe('KeyJ')
    submit('Save input bindings')
    expect(commands[0]).toMatchObject({
      type: 'game.updateInput',
      input: { keyboard: { KeyJ: 'primary', Digit1: 'primary' } },
    })
    click('Discard input draft')
    expect(field('Physical key code').value).toBe('KeyQ')
  })
})

describe('editor draft workflows', () => {
  async function connected<T extends { render: ProjectEditorListener }>(
    bind: (root: HTMLElement, save: (command: EditorCommand) => void) => T,
    source = project(),
  ) {
    const ui = panel()
    let pending = Promise.resolve()
    let rejectNext = false
    let revision = 0

    const controller = new ProjectEditorController(
      {
        inspect: async () => inspectProject(source),
        apply: async ({ command }) => {
          if (rejectNext) {
            rejectNext = false
            throw new EditorClientError('revision_conflict', 'Conflict')
          }

          source = { ...applyCommand(source, command).project, revision: String(++revision) }

          return inspectProject(source)
        },
      },
      (state, replace) => editor.render(state, replace),
    )

    const editor = bind(ui.root.asElement(), (command) => {
      ui.commands.push(structuredClone(command))
      pending = controller.save(command)
    })

    await controller.load('demo')

    return {
      ...ui,
      editor,
      controller,
      flush: () => pending,
      rejectNext: () => {
        rejectNext = true
      },
      read: () => inspectProject(source),
    }
  }

  function itemViewProject() {
    let source = applyCommand(project(), {
      type: 'game.upsertInventory',
      inventoryId: 'items',
      inventory: {
        'schema-version': '1.0.0',
        itemTypes: {},
        owners: {
          hero: { label: 'Hero', equipmentSlots: {} },
          companion: { label: 'Companion', equipmentSlots: {} },
        },
        items: {},
      },
    }).project

    source = applyCommand(source, {
      type: 'assets.upsertComposition',
      id: 'portrait',
      composition: {
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        layers: ['base'],
        anchors: {},
        slots: {},
      },
    }).project

    for (const component of [
      {
        id: 'items',
        type: 'inventory',
        owners: ['hero', 'companion'],
        previews: {
          hero: { composition: 'portrait', slots: {} },
          companion: { composition: 'portrait', slots: {} },
        },
      },
      { id: 'other-items', type: 'inventory', owners: ['hero'] },
      { id: 'equipment', type: 'equipment', inventory: 'items', owner: 'hero' },
      { id: 'details', type: 'item-details', inventory: 'items', equipment: 'equipment' },
    ]) {
      const parsed = commandSchema.parse({
        type: 'scene.upsertItemView',
        sceneId: 'shop',
        component: { ...component, placement: { row: 1, column: 1 } },
      })

      source = applyCommand(source, parsed).project
    }

    return source
  }

  function statusProject() {
    return applyCommand(project(), {
      type: 'scene.upsertStatusPanel',
      sceneId: 'shop',
      component: {
        id: 'existing',
        type: 'status-panel',
        label: 'Original',
        name: '',
        rows: [],
        effects: [],
        placement: { row: 1, column: 1, rowSpan: 1, columnSpan: 1 },
      },
    }).project
  }

  it('protects create-only item and status commands against any component ID collision', () => {
    const itemSource = itemViewProject()
    const statusSource = statusProject()

    for (const [source, command] of [
      [
        itemSource,
        {
          type: 'scene.upsertItemView',
          sceneId: 'shop',
          component: inspectProject(itemSource).scenes[0]!.components.find(
            ({ id }) => id === 'items',
          ),
        },
      ],
      [
        statusSource,
        {
          type: 'scene.upsertStatusPanel',
          sceneId: 'shop',
          component: inspectProject(statusSource).scenes[0]!.components.find(
            ({ id }) => id === 'existing',
          ),
        },
      ],
    ] as const) {
      const before = JSON.stringify(source)

      for (const id of [command.component!.id, 'description']) {
        const input = commandSchema.parse({
          ...command,
          component: { ...command.component, id },
          createOnly: true,
        })

        expect(() => applyCommand(source, input)).toThrow(
          expect.objectContaining({ status: 409, code: 'component_exists' }),
        )
      }

      expect(JSON.stringify(source)).toBe(before)

      const updated = applyCommand(
        source,
        commandSchema.parse({ ...command, component: { ...command.component, label: 'Updated' } }),
      )

      expect(
        inspectProject(updated.project).scenes[0]!.components.find(
          ({ id }) => id === command.component!.id,
        ),
      ).toHaveProperty('label', 'Updated')
    }
  })

  it.each(['items', 'equipment', 'details'])(
    'keeps saved item-view ID %s immutable while editing its fields',
    async (id) => {
      const ui = await connected(bindItemEditor, itemViewProject())
      expect(ui.editor.navigate('shop', id)).toBe(true)
      expect(ui.field('View ID').readOnly).toBe(true)
      ui.edit('View ID', 'other-items')
      ui.edit('View label', 'Updated view')
      ui.submit('Save items and equipment')
      await ui.flush()
      expect(ui.commands[0]).toMatchObject({
        type: 'scene.upsertItemView',
        createOnly: false,
        component: { id, label: 'Updated view' },
      })
      expect(ui.read().scenes[0]!.components.find(({ id }) => id === 'other-items')).toHaveProperty(
        'label',
        'Inventory',
      )
      expect(
        ui.read().scenes[0]!.components.filter(({ id: savedId }) => savedId === id),
      ).toHaveLength(1)
      expect(ui.field('View ID').value).toBe(id)
    },
  )

  it('retains new item-view drafts through duplicate IDs and conflicts and locks the ID after saving', async () => {
    const ui = await connected(bindItemEditor, itemViewProject())
    ui.editor.navigate('shop', 'items')
    ui.click('Add inventory')
    ui.edit('View ID', 'other-items')
    ui.edit('View label', 'New panel')
    ui.submit('Save items and equipment')
    expect(ui.commands).toHaveLength(0)
    expect(ui.root.textContent).toContain('already exists')
    expect(ui.field('View ID').readOnly).toBe(false)
    ui.edit('View ID', 'new-items')
    ui.rejectNext()
    ui.submit('Save items and equipment')
    await ui.flush()
    await ui.controller.save({
      type: 'game.updateMetadata',
      title: 'Unrelated',
      description: '',
      version: '1',
    })
    expect(ui.field('View ID').value).toBe('new-items')
    expect(ui.field('View ID').readOnly).toBe(false)
    expect(ui.field('View label').value).toBe('New panel')
    ui.submit('Save items and equipment')
    await ui.flush()
    expect(ui.commands.at(-1)).toMatchObject({
      type: 'scene.upsertItemView',
      createOnly: true,
      component: { id: 'new-items' },
    })
    expect(ui.field('View ID').value).toBe('new-items')
    expect(ui.field('View ID').readOnly).toBe(true)
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.read().scenes[0]!.components.find(({ id }) => id === 'other-items')).toHaveProperty(
      'label',
      'Inventory',
    )
  })

  it('rejects new status-panel collisions after rerendering and preserves creation drafts on conflict', async () => {
    const ui = await connected(bindStatusPanelEditor, statusProject())
    ui.click('Add status panel')
    ui.edit('Status component ID', 'existing')
    ui.edit('Status panel title', 'New status')
    ui.click('Add value row')
    expect(ui.field('Status component ID').value).toBe('existing')
    ui.submit('Save status panel')
    expect(ui.commands).toHaveLength(0)
    expect(ui.root.textContent).toContain('already exists')
    ui.click('Remove status panel')
    expect(ui.commands).toHaveLength(0)
    ui.edit('Status component ID', 'description')
    ui.submit('Save status panel')
    expect(ui.commands).toHaveLength(0)
    ui.edit('Status component ID', 'new-status')
    ui.rejectNext()
    ui.submit('Save status panel')
    await ui.flush()
    await ui.controller.save({
      type: 'game.updateMetadata',
      title: 'Unrelated',
      description: '',
      version: '1',
    })
    expect(ui.field('Status component ID').value).toBe('new-status')
    expect(ui.field('Status panel title').value).toBe('New status')
    ui.submit('Save status panel')
    await ui.flush()
    expect(ui.commands.at(-1)).toMatchObject({
      type: 'scene.upsertStatusPanel',
      createOnly: true,
      component: { id: 'new-status' },
    })
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.read().scenes[0]!.components.find(({ id }) => id === 'existing')).toHaveProperty(
      'label',
      'Original',
    )
    ui.edit('Status panel title', 'Edited status')
    ui.submit('Save status panel')
    await ui.flush()
    expect(ui.commands.at(-1)).toMatchObject({
      createOnly: false,
      component: { id: 'new-status', label: 'Edited status' },
    })
  })

  it('removes hidden-owner previews, restores draft toggles, and preserves other owners and discarded mappings', async () => {
    const ui = await connected(bindItemEditor, itemViewProject())
    ui.editor.navigate('shop', 'items')
    ui.edit('Show owner Companion', 'false')
    ui.edit('Show owner Companion', 'true')
    ui.submit('Save items and equipment')
    await ui.flush()
    expect(ui.read().scenes[0]!.components.find(({ id }) => id === 'items')).toMatchObject({
      previews: { hero: { composition: 'portrait' }, companion: { composition: 'portrait' } },
    })
    ui.edit('Show owner Companion', 'false')
    ui.click('Discard item draft')
    expect(ui.field('Show owner Companion').value).toBe('true')
    ui.edit('Show owner Companion', 'false')
    ui.rejectNext()
    ui.submit('Save items and equipment')
    await ui.flush()
    expect(ui.field('Show owner Companion').value).toBe('false')
    ui.submit('Save items and equipment')
    await ui.flush()
    const saved = ui.read().scenes[0]!.components.find(({ id }) => id === 'items')
    expect(saved).toMatchObject({
      owners: ['hero'],
      previews: { hero: { composition: 'portrait' } },
    })
    expect(saved?.type === 'inventory' && Object.keys(saved.previews)).toEqual(['hero'])
    expect(ui.read().diagnostics).toEqual([])
    expect(ui.editor.hasDrafts()).toBe(false)
  })

  function progressionProject() {
    return applyCommand(project(), {
      type: 'game.updateRules',
      ruleId: 'state',
      rules: {
        state: [
          { path: ['experience'], value: 0 },
          { path: ['level'], value: 1 },
          { path: ['gold'], value: 10 },
        ],
        actions: {},
      },
    }).project
  }

  function styledProject() {
    return applyCommand(
      applyCommand(project(), {
        type: 'game.upsertStylesheet',
        file: 'theme.css',
        css: '.ancadeba-scene { color: gold; }\n',
        createOnly: true,
      }).project,
      {
        type: 'game.upsertStylesheet',
        file: 'styles/blue.css',
        css: '.ancadeba-scene { color: blue; }\n',
        createOnly: true,
        assign: false,
      },
    ).project
  }

  it('creates, assigns, detaches and reuses stylesheet files through authoring controls', async () => {
    const ui = await connected(bindStylesheetEditor, styledProject())
    expect(ui.field('CSS source').value).toContain('gold')
    expect(ui.field('Stylesheet path').readOnly).toBe(true)
    ui.click('New stylesheet')
    ui.edit('Stylesheet path', 'THEME.css')
    ui.submit('Save and assign stylesheet')
    expect(ui.commands).toHaveLength(0)
    expect(ui.root.textContent).toContain('already exists')
    ui.edit('Stylesheet path', 'styles/custom.css')
    ui.edit('CSS source', '/* My theme */\n.ancadeba-scene { color: purple; }\n')
    ui.submit('Save and assign stylesheet')
    await ui.flush()
    expect(ui.read().game?.stylesheet).toBe('styles/custom.css')
    expect(ui.read().stylesheets?.['styles/custom.css']).toContain('purple')
    expect(ui.field('Stylesheet path').readOnly).toBe(true)
    ui.click('Use built-in styling')
    await ui.flush()
    expect(ui.read().game?.stylesheet).toBeUndefined()
    expect(ui.read().stylesheets?.['styles/custom.css']).toContain('purple')
    ui.edit('Saved stylesheet', 'theme.css')
    ui.click('Assign saved stylesheet')
    await ui.flush()
    expect(ui.read().game?.stylesheet).toBe('theme.css')
    expect(ui.read().stylesheets?.['styles/blue.css']).toContain('blue')
  })

  it('keeps CSS drafts after conflicts and unrelated saves and guards switching files and assignments', async () => {
    const ui = await connected(bindStylesheetEditor, styledProject())
    const css = '.ancadeba-scene { --ge-scene-color: #123456; }\n'
    ui.edit('CSS source', css)
    ui.edit('Saved stylesheet', 'styles/blue.css')
    expect(ui.field('Saved stylesheet').value).toBe('theme.css')
    expect(ui.editor.navigate('styles/blue.css')).toBe(false)
    ui.click('Use built-in styling')
    expect(ui.commands).toHaveLength(0)
    expect(ui.root.textContent).toContain('Save or discard')
    ui.rejectNext()
    ui.submit('Save stylesheet')
    await ui.flush()
    expect(ui.field('CSS source').value).toBe(css)
    await ui.controller.save({
      type: 'game.updateMetadata',
      title: 'Unrelated',
      description: '',
      version: '1',
    })
    expect(ui.field('CSS source').value).toBe(css)
    ui.submit('Save stylesheet')
    await ui.flush()
    expect(ui.read().stylesheets?.['theme.css']).toBe(css)
    ui.edit('CSS source', 'discard me')
    ui.click('Discard stylesheet draft')
    expect(ui.field('CSS source').value).toBe(css)
    expect(ui.editor.hasDrafts()).toBe(false)
  })

  it('retains CSS when scoped compatibility or path validation fails and permits correction', async () => {
    const validate = vi.fn((css: string) => {
      if (css.includes('@font-face')) throw new Error('Unsupported global CSS rule')
    })

    const ui = await connected((root, save) =>
      bindStylesheetEditor(root, save, editorLocalization().t, validate),
    )

    ui.edit('CSS source', '@font-face { font-family: Bad; src: url(font.woff); }')
    ui.click('Check scoped CSS')
    ui.submit('Save and assign stylesheet')
    expect(ui.root.textContent).toContain('Unsupported global CSS rule')
    expect(ui.commands).toHaveLength(0)
    expect(ui.field('CSS source').value).toContain('@font-face')
    ui.edit('CSS source', '')
    ui.edit('Stylesheet path', '../outside.css')
    ui.submit('Save and assign stylesheet')
    expect(ui.commands).toHaveLength(0)
    ui.edit('Stylesheet path', 'styles/blank.css')
    ui.submit('Save and assign stylesheet')
    await ui.flush()
    expect(validate).toHaveBeenCalledWith('')
    expect(ui.read().stylesheets?.['styles/blank.css']).toBe('')
  })

  it('repairs missing assigned CSS without enabling unrelated invalid project edits', async () => {
    const source = styledProject()
    const documents = { ...source.documents }
    delete documents['theme.css']
    const ui = await connected(bindStylesheetEditor, { ...source, documents })
    ui.edit('CSS source', '.ancadeba-scene { color: teal; }')
    ui.submit('Save stylesheet')
    await ui.flush()
    expect(ui.read().diagnostics).toEqual([])
    expect(ui.read().stylesheets?.['theme.css']).toContain('teal')
  })

  function combatProject() {
    return applyCommand(project(), {
      type: 'game.updateRules',
      ruleId: 'health',
      rules: {
        state: [
          { path: ['hero', 'health'], value: 80 },
          { path: ['foe', 'hp'], value: 30 },
          { path: ['gold'], value: 0 },
        ],
        actions: {},
      },
    }).project
  }

  function sceneGraphicProject() {
    const image = {
      format: 'svg' as const,
      source: 'assets/cloth.svg',
      bounds: { x: 0, y: 0, width: 40, height: 40 },
      colors: { fill: '#112233' },
      palettes: { night: { fill: '#223344' } },
    }

    const initial = applyCommand(project(), {
      type: 'assets.upsertImage',
      id: 'cloth',
      image,
    }).project

    const shared = {
      bounds: image.bounds,
      pieces: [
        {
          id: 'cloth',
          image: 'cloth',
          layer: 'body',
          anchor: 'origin',
          sourceAnchor: { x: 0, y: 0 },
          scale: 1,
          rotation: 0,
          slots: { fill: 'fabric' },
        },
      ],
    }

    const definitions = applyCommand(initial, {
      type: 'assets.updateDefinitions',
      parts: {
        cloak: {
          ...shared,
          colors: { fabric: '#334455', trim: '#ffffff' },
          palettes: { royal: { fabric: '#665191' }, unique: { fabric: '#aa0000' } },
        },
        coat: {
          ...shared,
          colors: { fabric: '#556677' },
          palettes: { royal: { fabric: '#003399' } },
        },
      },
      compositions: {
        hero: {
          bounds: image.bounds,
          layers: ['body'],
          anchors: { origin: { x: 0, y: 0 } },
          slots: { outfit: { parts: ['cloak', 'coat'], default: 'cloak' } },
        },
      },
    }).project

    return applyCommand(definitions, {
      type: 'game.updateRules',
      ruleId: 'appearance',
      rules: {
        state: [
          { path: ['hero', 'tint'], value: '#123456' },
          { path: ['hero', 'palette'], value: 'royal' },
          { path: ['hero', 'show'], value: false },
          { path: ['hero', 'part'], value: 'coat' },
        ],
        actions: {},
      },
    }).project
  }

  it('authors scene graphic colors, palettes and visibility without a JSON field', async () => {
    const ui = await connected(bindSceneGraphicEditor, sceneGraphicProject())
    ui.editor.navigate('shop')
    ui.edit('Graphic component ID', 'portrait')
    ui.edit('Static palette', 'night', 'Graphic colors')
    ui.edit('Static color', 'override', 'Color fill')
    ui.edit('Hex color', '#abcdef', 'Color fill')
    expect(ui.field('Color picker', 'Color fill').value).toBe('#abcdef')
    ui.submit('Save scene graphic')
    await ui.flush()
    const current = ui.read().scenes[0]!.components.find((component) => component.id === 'portrait')
    expect(current).toMatchObject({
      appearance: { palette: 'night', colors: { fill: '#abcdef' }, visible: true },
    })
    expect(ui.field('Graphic component ID').readOnly).toBe(true)
    expect(ui.root.all().filter((node) => node.tagName === 'textarea')).toHaveLength(0)
    ui.edit('Static color', 'inherit', 'Color fill')
    ui.edit('Static palette', '', 'Graphic colors')
    ui.edit('Static visibility', 'false', 'Graphic')
    expect(ui.root.textContent).toContain('Graphic hidden')
    ui.submit('Save scene graphic')
    await ui.flush()
    expect(ui.commands.at(-1)).toMatchObject({
      component: { appearance: { colors: {}, visible: false } },
    })
    await ui.controller.load('demo')
    expect(ui.editor.navigate('shop', 'portrait')).toBe(true)
    expect(ui.field('Static visibility', 'Graphic').value).toBe('false')
  })

  it('binds scene visibility, slot parts, palettes, colors and slot visibility with typed fallbacks', async () => {
    const ui = await connected(bindSceneGraphicEditor, sceneGraphicProject())
    ui.editor.navigate('shop')
    ui.edit('Graphic visual', 'hero')

    const bind = (title: string, path: string[]) =>
      ui.edit('Bound value', textBindingId({ source: 'game.state', path }), title)

    bind('Graphic visibility binding', ['hero', 'show'])
    ui.edit('Static palette', 'royal', 'outfit colors')
    ui.edit('Static color', 'override', 'Color fabric')
    ui.edit('Hex color', '#ffffff', 'Color fabric')
    bind('outfit colors fabric binding', ['hero', 'tint'])
    bind('outfit colors palette binding', ['hero', 'palette'])
    bind('outfit slot visibility binding', ['hero', 'show'])
    bind('outfit part binding', ['hero', 'part'])
    ui.submit('Save scene graphic')
    await ui.flush()

    const component = ui
      .read()
      .scenes[0]!.components.find((component) => component.type === 'graphic')

    if (component?.type !== 'graphic') throw new Error('Expected graphic')
    expect(component.appearance).toMatchObject({
      bindings: { visible: { source: 'game.state', path: ['hero', 'show'] } },
      slots: {
        outfit: {
          palette: 'royal',
          colors: { fabric: '#ffffff' },
          partBinding: { path: ['hero', 'part'] },
          bindings: {
            palette: { path: ['hero', 'palette'] },
            visible: { path: ['hero', 'show'] },
            colors: { fabric: { path: ['hero', 'tint'] } },
          },
        },
      },
    })
    expect(
      resolveGraphic(ui.read().assets!, 'hero', component.appearance).pieces[0]?.colors.fill,
    ).toBe('#ffffff')
    ui.edit('Preview values', 'starting')
    expect(ui.root.textContent).toContain('Graphic hidden')
    ui.edit('Bound value', '', 'Graphic visibility binding')
    ui.edit('Bound value', '', 'outfit slot visibility binding')
    ui.submit('Save scene graphic')
    await ui.flush()
    const next = ui.read().scenes[0]!.components.find((entry) => entry.type === 'graphic')

    if (next?.type !== 'graphic') throw new Error('Expected graphic')

    const resolution = resolveGraphic(
      ui.read().assets!,
      'hero',
      next.appearance,
      startingGameBindings(ui.read()),
    )

    expect(resolution.visible).toBe(true)
    expect(resolution.pieces[0]?.colors.fill).toBe('#123456')
    expect(next.appearance.bindings?.visible).toBeUndefined()
    expect(next.appearance.slots.outfit?.bindings?.visible).toBeUndefined()
  })

  it('keeps slot overrides compatible with changed parts and supports defaults, none and resetting a slot', async () => {
    const ui = await connected(bindSceneGraphicEditor, sceneGraphicProject())
    ui.editor.navigate('shop')
    ui.edit('Graphic visual', 'hero')
    ui.edit('Static palette', 'unique', 'outfit colors')
    ui.edit('Static color', 'override', 'Color trim')
    ui.edit('Static part', 'part:coat', 'Slot outfit')
    expect(ui.field('Static palette', 'outfit colors').value).toBe('')
    ui.submit('Save scene graphic')
    await ui.flush()
    expect(ui.read().diagnostics).toEqual([])
    ui.edit('Static part', 'part:cloak', 'Slot outfit')
    ui.edit('Static palette', 'unique', 'outfit colors')
    ui.edit(
      'Bound value',
      textBindingId({ source: 'game.state', path: ['hero', 'part'] }),
      'outfit part binding',
    )
    expect(ui.field('Static palette', 'outfit colors').value).toBe('')
    ui.edit('Bound value', '', 'outfit part binding')
    ui.edit('Static part', 'none', 'Slot outfit')
    ui.submit('Save scene graphic')
    await ui.flush()
    expect(ui.commands.at(-1)).toMatchObject({
      component: { appearance: { slots: { outfit: { part: null } } } },
    })
    ui.click('Reset slot appearance')
    ui.submit('Save scene graphic')
    await ui.flush()
    expect(ui.commands.at(-1)).toMatchObject({ component: { appearance: { slots: {} } } })
    expect(ui.field('Static part', 'Slot outfit').value).toBe('inherit')
  })

  it('retains invalid and conflicting graphic drafts through unrelated saves and permits correction or discard', async () => {
    const ui = await connected(bindSceneGraphicEditor, sceneGraphicProject())
    ui.editor.navigate('shop')
    ui.edit('Static color', 'override', 'Color fill')
    ui.edit('Hex color', 'invalid', 'Color fill')
    ui.submit('Save scene graphic')
    expect(ui.commands).toHaveLength(0)
    expect(ui.editor.navigate('other')).toBe(false)
    ui.edit('Hex color', '#abcdef', 'Color fill')
    ui.edit('Bound value', 'custom', 'Graphic visibility binding')
    ui.edit('Path key', 'heroes', 'Path segment 1')
    ui.click('Add path segment')
    ui.edit('Path segment type', 'index', 'Path segment 2')
    ui.edit('Array index', '', 'Path segment 2')
    ui.submit('Save scene graphic')
    expect(ui.commands).toHaveLength(0)
    ui.edit('Array index', '0', 'Path segment 2')
    ui.click('Add path segment')
    ui.edit('Path key', 'visible', 'Path segment 3')
    ui.rejectNext()
    ui.submit('Save scene graphic')
    await ui.flush()
    expect(ui.field('Hex color', 'Color fill').value).toBe('#abcdef')
    await ui.controller.save({
      type: 'game.updateMetadata',
      title: 'Unrelated',
      description: '',
      version: '1',
    })
    expect(ui.field('Path key', 'Path segment 3').value).toBe('visible')
    ui.submit('Save scene graphic')
    await ui.flush()
    expect(ui.commands.at(-1)).toMatchObject({
      component: { appearance: { bindings: { visible: { path: ['heroes', 0, 'visible'] } } } },
    })
    ui.edit('Static visibility', 'false', 'Graphic')
    ui.click('Discard scene graphic draft')
    expect(ui.field('Static visibility', 'Graphic').value).toBe('true')
    expect(ui.editor.hasDrafts()).toBe(false)
  })

  it('supports static graphic authoring in stand-alone scenes and protects existing component IDs', async () => {
    const source = sceneGraphicProject()
    object(source.documents['scenes/other.json']).type = 'stand-alone'
    const ui = await connected(bindSceneGraphicEditor, source)
    ui.editor.navigate('other')
    expect(ui.root.textContent).toContain('Game-state bindings require a game scene')
    expect(ui.root.textContent).not.toContain('Bound value')
    ui.edit('Graphic component ID', 'description')
    ui.submit('Save scene graphic')
    expect(ui.commands).toHaveLength(0)
    expect(ui.root.textContent).toContain('already exists')
    ui.edit('Graphic component ID', 'decoration')
    ui.edit('Static visibility', 'false', 'Graphic')
    ui.submit('Save scene graphic')
    await ui.flush()
    expect(ui.read().diagnostics).toEqual([])
    const command = ui.commands[0]!
    expect(() => applyCommand(applyCommand(source, command).project, command)).toThrow(
      'already exists',
    )
  })

  it('preserves graphic extensions while removing cleared appearance values and bindings', () => {
    const source = sceneGraphicProject()

    const created = applyCommand(source, {
      type: 'scene.upsertGraphic',
      sceneId: 'shop',
      component: {
        id: 'portrait',
        type: 'graphic',
        visual: 'hero',
        alt: 'Hero',
        fit: 'contain',
        placement: { row: 1, column: 1, rowSpan: 1, columnSpan: 1 },
        appearance: {
          colors: {},
          visible: true,
          slots: {
            outfit: {
              colors: { fabric: '#abcdef' },
              palette: 'royal',
              part: 'cloak',
              visible: true,
              partBinding: { source: 'game.state', path: ['hero', 'part'] },
              bindings: { colors: {}, visible: { source: 'game.state', path: ['hero', 'show'] } },
            },
          },
        },
      },
    }).project

    const scene = object(created.documents['scenes/shop.json'])

    const raw = (Array.isArray(scene.components) ? scene.components.map(object) : []).find(
      (entry) => entry.id === 'portrait',
    )!

    raw.extension = 'component'
    object(raw.placement).extension = 'placement'
    object(raw.appearance).extension = 'appearance'
    object(object(object(raw.appearance).slots).outfit).extension = 'slot'
    const view = inspectProject(created)
    const current = view.scenes[0]!.components.find((component) => component.type === 'graphic')

    if (current?.type !== 'graphic') throw new Error('Expected graphic')
    current.appearance.slots.outfit = { visible: false, colors: {} }
    const before = JSON.stringify(created)

    const saved = applyCommand(created, {
      type: 'scene.upsertGraphic',
      sceneId: 'shop',
      component: current,
    })

    expect(JSON.stringify(created)).toBe(before)
    const result = JSON.parse(JSON.stringify(saved.project.documents['scenes/shop.json']))
    expect(result.components.at(-1)).toMatchObject({
      extension: 'component',
      placement: { extension: 'placement' },
      appearance: {
        extension: 'appearance',
        slots: { outfit: { extension: 'slot', visible: false, colors: {} } },
      },
    })
    expect(result.components.at(-1).appearance.slots.outfit).not.toHaveProperty('part')
    expect(result.components.at(-1).appearance.slots.outfit).not.toHaveProperty('partBinding')
    expect(result.components.at(-1).appearance.slots.outfit).not.toHaveProperty('palette')
    expect(result.components.at(-1).appearance.slots.outfit).not.toHaveProperty('bindings')
  })

  it('explains encounter health prerequisites before creating a draft', async () => {
    const ui = await connected(bindCombatEditor)
    ui.click('Add encounter')
    expect(ui.root.textContent).toContain('two distinct positive health fields')
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.commands).toHaveLength(0)

    await ui.controller.save({
      type: 'game.updateRules',
      ruleId: 'health',
      rules: {
        state: [
          { path: ['health'], value: 40 },
          { path: ['enemyHealth'], value: 0 },
        ],
        actions: {},
      },
    })
    ui.click('Add encounter')
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.read().combatSources).toEqual({})
  })

  it('creates a saveable encounter using distinct selected health fields and preserves initial state', async () => {
    const ui = await connected(bindCombatEditor, combatProject())
    const health = JSON.stringify(['hero', 'health'])
    const enemy = JSON.stringify(['foe', 'hp'])
    ui.edit('New enemy health field', health)
    ui.click('Add encounter')
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.root.textContent).toContain('two distinct positive health fields')
    ui.edit('New enemy health field', enemy)
    ui.click('Add encounter')
    ui.edit('Encounter ID', 'custom-training')
    ui.submit('Save combat encounter')
    await ui.flush()
    expect(ui.read().diagnostics).toEqual([])
    expect(ui.read().combatSources?.['custom-training']).toMatchObject({
      player: { health: { path: ['hero', 'health'] }, maximumHealth: 80 },
      enemies: [{ health: { path: ['foe', 'hp'] }, maximumHealth: 30 }],
    })
    expect(ui.read().rules?.state).toEqual(inspectProject(combatProject()).rules?.state)
    expect(ui.field('Combat encounter').value).toBe('custom-training')
    expect(ui.field('Encounter ID').readOnly).toBe(true)
  })

  it('protects existing encounters from new draft collisions in the UI and core', async () => {
    const ui = await connected(bindCombatEditor, combatProject())
    ui.click('Add encounter')
    ui.submit('Save combat encounter')
    await ui.flush()
    const original = ui.commands[0]!

    if (original.type !== 'game.upsertCombat') throw new Error('Expected encounter')
    const saved = applyCommand(combatProject(), original).project
    const before = JSON.stringify(saved)

    for (const id of ['training', 'TRAINING'])
      expect(() =>
        applyCommand(saved, { ...original, encounter: { ...original.encounter, id } }),
      ).toThrow('already exists')
    expect(JSON.stringify(saved)).toBe(before)

    ui.edit('Encounter ID', 'ignored-rename')
    ui.submit('Save combat encounter')
    await ui.flush()
    expect(ui.commands.at(-1)).toMatchObject({ encounter: { id: 'training' }, createOnly: false })
    ui.click('Add encounter')
    ui.edit('Encounter ID', 'TRAINING')
    ui.edit('Encounter name', 'Must not overwrite')
    const count = ui.commands.length
    ui.submit('Save combat encounter')
    expect(ui.commands).toHaveLength(count)
    expect(ui.root.textContent).toContain('already exists')
    expect(ui.read().combatSources?.training?.label).toBe('Training')
    ui.edit('Encounter ID', 'new-encounter')
    ui.rejectNext()
    ui.submit('Save combat encounter')
    await ui.flush()
    expect(ui.field('Encounter ID').value).toBe('new-encounter')
    expect(ui.field('Encounter ID').readOnly).toBe(false)
    ui.submit('Save combat encounter')
    await ui.flush()
    expect(ui.read().combatSources?.['new-encounter']?.label).toBe('Must not overwrite')
    expect(ui.field('Encounter ID').readOnly).toBe(true)
  })

  it('protects combat libraries from collisions and locks IDs only after successful creation', async () => {
    const ui = await connected(bindCombatEditor)
    ui.click('Add combat library')
    ui.edit('Library ID', 'shared')
    ui.click('Add guard move')
    ui.submit('Save combat library')
    await ui.flush()
    expect(ui.field('Library ID').readOnly).toBe(true)
    const original = ui.commands[0]!

    if (original.type !== 'game.upsertCombatLibrary') throw new Error('Expected library')
    const saved = applyCommand(project(), original).project

    for (const id of ['shared', 'SHARED'])
      expect(() =>
        applyCommand(saved, { ...original, library: { ...original.library, id, moves: {} } }),
      ).toThrow('already exists')
    ui.edit('Library ID', 'ignored-rename')
    ui.submit('Save combat library')
    await ui.flush()
    expect(ui.commands.at(-1)).toMatchObject({ library: { id: 'shared' }, createOnly: false })

    ui.click('Add combat library')
    ui.edit('Library ID', 'SHARED')
    const count = ui.commands.length
    ui.submit('Save combat library')
    expect(ui.commands).toHaveLength(count)
    expect(ui.root.textContent).toContain('already exists')
    expect(Object.keys(ui.read().combatLibraries!.shared!.moves)).not.toHaveLength(0)
    ui.edit('Library ID', 'new-library')
    ui.rejectNext()
    ui.submit('Save combat library')
    await ui.flush()
    expect(ui.field('Library ID').value).toBe('new-library')
    expect(ui.field('Library ID').readOnly).toBe(false)
    ui.submit('Save combat library')
    await ui.flush()
    expect(ui.field('Combat library').value).toBe('new-library')
    expect(ui.field('Library ID').readOnly).toBe(true)
  })

  it('retains pending input contexts through validation, rerenders and unrelated saves', async () => {
    const ui = await connected(bindActionBarPanel)
    ui.edit('New context ID', 'combat')
    ui.submit('Save input bindings')
    expect(ui.commands).toHaveLength(0)
    expect(ui.root.textContent).toContain('Add or clear the pending input context')
    ui.edit('Virtual keys (comma-separated)', 'primary, secondary, extra')
    expect(ui.field('New context ID').value).toBe('combat')
    await ui.controller.save({
      type: 'game.updateMetadata',
      title: 'Renamed',
      description: '',
      version: '1',
    })
    expect(ui.field('New context ID').value).toBe('combat')
    ui.click('Add context')
    expect(ui.field('New context ID').value).toBe('')
    ui.click('Add context mapping')
    ui.edit('Virtual input ID', 'attack')
    ui.rejectNext()
    ui.submit('Save input bindings')
    await ui.flush()
    expect(ui.field('Virtual input ID').value).toBe('attack')
    ui.submit('Save input bindings')
    await ui.flush()
    expect(ui.read().input?.contexts.combat).toEqual({ primary: 'attack' })
    ui.edit('New context ID', 'discard-me')
    ui.click('Discard input draft')
    expect(ui.field('New context ID').value).toBe('')
    ui.edit('New context ID', 'clear-me')
    ui.edit('New context ID', '')
    ui.submit('Save input bindings')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.read().input?.contexts).not.toHaveProperty('clear-me')
  })

  function textProject() {
    const source = applyCommand(project(), {
      type: 'game.updateRules',
      ruleId: 'state',
      rules: {
        state: [
          { path: ['gold'], value: 0 },
          { path: ['collected'], value: 1 },
          { path: ['flag'], value: false },
        ],
        actions: {},
      },
    }).project

    return applyCommand(source, {
      type: 'game.upsertQuest',
      quest: questSchema.parse({
        'schema-version': '1.0.0',
        id: 'delivery',
        label: 'Delivery',
        stages: [
          {
            id: 'collect',
            label: 'Collect',
            objectives: [
              {
                id: 'tokens',
                label: 'Tokens',
                progress: { binding: { source: 'game.state', path: ['collected'] }, target: 3 },
              },
            ],
          },
        ],
      }),
    }).project
  }

  it('authors state, gold and quest placeholders and previews their starting values', async () => {
    const ui = await connected(bindComponentEditor, textProject())
    ui.editor.navigate('shop', 'description')
    ui.edit('Text', 'Gold {{gold}} · Collected {{progress}}/3 · Quest {{quest}} · {{tracked}}')
    ui.edit('Text binding mode', 'dynamic')

    for (const [alias, source, path] of [
      ['gold', 'game.state', ['gold']],
      ['progress', 'game.state', ['collected']],
      ['quest', 'game.quests', ['delivery', 'status']],
      ['tracked', 'game.quests', ['delivery', 'tracked']],
    ] as const) {
      ui.edit('New binding name', alias)
      ui.edit('New binding value', textBindingId({ source, path }))
      ui.click('Add text binding')
    }

    expect(ui.root.all().find((node) => node.tagName === 'output')!.textContent).toBe(
      'Gold 0 · Collected 1/3 · Quest not-started · false',
    )
    ui.submit('Save component')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.read().scenes[0]!.components[0]).toMatchObject({
      bindings: {
        gold: { source: 'game.state', path: ['gold'] },
        progress: { path: ['collected'] },
        quest: { source: 'game.quests', path: ['delivery', 'status'] },
        tracked: { path: ['delivery', 'tracked'] },
      },
    })
    await ui.controller.load('demo')
    expect(ui.field('Bound value', 'Binding quest').value).toBe(
      textBindingId({ source: 'game.quests', path: ['delivery', 'status'] }),
    )
  })

  it('guards pending names, duplicates and unbound placeholders while preserving explicit static braces', async () => {
    const ui = await connected(bindComponentEditor, textProject())
    ui.editor.navigate('shop', 'description')
    ui.edit('Text', 'Gold: {{gold}}')
    expect(ui.root.all().find((node) => node.tagName === 'output')!.textContent).toBe(
      'Gold: {{gold}}',
    )
    ui.edit('Text binding mode', 'dynamic')
    expect(ui.root.textContent).toContain('Unbound placeholders: gold')
    ui.edit('New binding name', 'bad.name')
    ui.click('Add text binding')
    expect(ui.root.textContent).toContain('unused binding name')
    ui.edit('New binding name', 'gold')
    ui.click('Add text binding')
    ui.edit('New binding name', 'gold')
    ui.click('Add text binding')
    expect(ui.root.textContent).toContain('unused binding name')
    ui.submit('Save component')
    expect(ui.commands).toHaveLength(0)
    expect(ui.root.textContent).toContain('pending text binding')
    ui.edit('New binding name', '')
    ui.click('Remove binding gold')
    ui.submit('Save component')
    expect(ui.commands).toHaveLength(0)
    expect(ui.root.textContent).toContain('Undeclared or invalid text binding')
    ui.edit('Text binding mode', 'static')
    ui.submit('Save component')
    await ui.flush()
    expect(ui.read().scenes[0]!.components[0]).toMatchObject({ text: 'Gold: {{gold}}' })
    expect(ui.read().scenes[0]!.components[0]).toHaveProperty('bindings', undefined)
  })

  it('authors custom typed paths and fallback text and appends placeholders without JSON', async () => {
    const ui = await connected(bindComponentEditor, textProject())
    ui.editor.navigate('shop', 'description')
    ui.edit('Text', '')
    ui.edit('Text binding mode', 'dynamic')
    ui.edit('New binding name', 'heroGold')
    ui.click('Add text binding')
    ui.edit('Bound value', 'custom')
    ui.edit('Path key', 'heroes', 'Path segment 1')
    ui.click('Add path segment')
    ui.edit('Path segment type', 'index', 'Path segment 2')
    ui.edit('Array index', '0', 'Path segment 2')
    ui.click('Add path segment')
    ui.edit('Path key', 'gold', 'Path segment 3')
    ui.edit('Use fallback text', 'true')
    ui.edit('Fallback text', 'No hero')
    ui.click('Append {{heroGold}}')
    expect(ui.field('Text').value).toBe('{{heroGold}}')
    expect(ui.root.all().find((node) => node.tagName === 'output')!.textContent).toBe('No hero')
    ui.submit('Save component')
    await ui.flush()
    expect(ui.read().scenes[0]!.components[0]).toMatchObject({
      bindings: {
        heroGold: { source: 'game.state', path: ['heroes', 0, 'gold'], fallback: 'No hero' },
      },
    })
    ui.edit('Use fallback text', 'false')
    ui.submit('Save component')
    await ui.flush()
    const component = ui.read().scenes[0]!.components[0]!

    if (component.type !== 'text') throw new Error('Expected text')
    expect(component.bindings!.heroGold!.fallback).toBeUndefined()
  })

  it('preserves failed drafts and pending names while refreshing state choices after unrelated saves', async () => {
    const ui = await connected(bindComponentEditor, textProject())
    ui.editor.navigate('shop', 'description')
    ui.edit('Text', '{{gold}}')
    ui.edit('Text binding mode', 'dynamic')
    ui.edit('New binding name', 'gold')
    ui.click('Add text binding')
    ui.edit('Use fallback text', 'true')
    ui.edit('Fallback text', 'Unavailable')
    ui.rejectNext()
    ui.submit('Save component')
    await ui.flush()
    ui.edit('New binding name', 'bonus')
    await ui.controller.save({
      type: 'game.updateRules',
      ruleId: 'state',
      rules: {
        ...ui.read().rules!,
        state: [...ui.read().rules!.state, { path: ['bonus'], value: 5 }],
      },
    })
    expect(ui.field('New binding name').value).toBe('bonus')
    expect(ui.field('Fallback text').value).toBe('Unavailable')
    ui.edit('New binding value', textBindingId({ source: 'game.state', path: ['bonus'] }))
    ui.click('Add text binding')
    ui.submit('Save component')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.read().scenes[0]!.components[0]).toMatchObject({
      bindings: { gold: { fallback: 'Unavailable' }, bonus: { path: ['bonus'] } },
    })
  })

  it('previews translated templates and preserves invalid translated drafts for correction', async () => {
    const source = applyCommand(textProject(), {
      type: 'game.updateLocalization',
      languages: { default: 'en', available: ['en', 'nl'] },
      catalogs: { en: { hud: 'Gold {{gold}}' }, nl: { hud: 'Goud {{gold}}' } },
    }).project

    const ui = await connected(bindComponentEditor, source)
    ui.editor.navigate('shop', 'description')
    ui.edit('Text translation', 'hud')
    ui.edit('Text binding mode', 'dynamic')
    ui.edit('New binding name', 'gold')
    ui.click('Add text binding')
    expect(ui.root.all().find((node) => node.tagName === 'output')!.textContent).toBe('Gold 0')
    expect(
      ui.root
        .all()
        .find((node) => node.tagName === 'button' && node.textContent === 'Append {{gold}}'),
    ).toHaveProperty('disabled', true)
    ui.submit('Save component')
    await ui.flush()
    ui.click('Remove binding gold')
    ui.submit('Save component')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(true)
    expect(ui.read().scenes[0]!.components[0]).toMatchObject({
      bindings: { gold: { path: ['gold'] } },
    })
    ui.click('Discard component draft')
    expect(ui.field('Bound value').value).toBe(
      textBindingId({ source: 'game.state', path: ['gold'] }),
    )
  })

  it('keeps stand-alone text static and disables runtime binding authoring there', async () => {
    const initial = project()

    const source = {
      ...initial,
      documents: {
        ...initial.documents,
        'scenes/other.json': {
          ...object(initial.documents['scenes/other.json']),
          type: 'stand-alone',
        },
      },
    }

    const ui = await connected(bindComponentEditor, source)
    ui.editor.navigate('other', 'description')
    expect(ui.field('Text binding mode')).toHaveProperty('disabled', true)
    ui.edit('Text', 'Literal {{braces}}')
    ui.submit('Save component')
    await ui.flush()
    expect(ui.read().scenes[1]!.components[0]).toMatchObject({ text: 'Literal {{braces}}' })
  })

  function graphicProject() {
    return applyCommand(project(), {
      type: 'assets.upsertImage',
      id: 'cloth',
      image: {
        format: 'svg',
        source: 'assets/images/cloth.svg',
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        colors: { fabric: '#123456' },
        palettes: {},
      },
    }).project
  }

  it('authors a layered part and composition, including colors, palettes, anchors and slot defaults', async () => {
    const ui = await connected(bindGraphicDefinitionsEditor, graphicProject())
    ui.edit('New graphic definition ID', 'cloak')
    ui.click('Add part')
    ui.edit('New piece ID', 'rear')
    ui.click('Add image piece')
    ui.edit('Piece layer', 'back', 'Piece rear')
    ui.edit('Source anchor x', '10', 'Piece rear')
    ui.edit('Source anchor y', '20', 'Piece rear')
    ui.edit('Piece scale', '1.5', 'Piece rear')
    ui.edit('Piece rotation', '15', 'Piece rear')
    ui.edit('New part color ID', 'shared')
    ui.click('Add part color')
    ui.edit('Default color', '#336699', 'Color shared')
    ui.edit('Map image color fabric', 'shared', 'Piece rear')
    ui.edit('New part palette ID', 'ocean')
    ui.click('Add part palette')
    ui.edit('shared', 'true', 'Palette ocean')
    ui.edit('shared color', '#223344', 'Palette ocean')
    ui.edit('New piece ID', 'clasp')
    ui.click('Add image piece')
    ui.edit('Piece layer', 'front', 'Piece clasp')
    ui.click('Move piece clasp up')
    ui.edit('Definition kind', 'compositions')
    ui.edit('New graphic definition ID', 'hero')
    ui.click('Add composition')
    ui.edit('New slot ID', 'outfit')
    ui.click('Add composition slot')
    ui.click('Remove layer body')
    ui.click('Move layer back back')
    ui.edit('Anchor x', '50', 'Anchor origin')
    ui.edit('Anchor y', '60', 'Anchor origin')
    ui.edit('Default part', '', 'Slot outfit')
    ui.edit('Default part', 'cloak', 'Slot outfit')
    ui.submit('Save parts and compositions')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.field('Graphic definition').value).toBe('hero')
    expect(ui.read().assets).toMatchObject({
      parts: {
        cloak: {
          colors: { shared: '#336699' },
          palettes: { ocean: { shared: '#223344' } },
          pieces: [
            { id: 'clasp', layer: 'front' },
            {
              id: 'rear',
              layer: 'back',
              sourceAnchor: { x: 10, y: 20 },
              scale: 1.5,
              rotation: 15,
              slots: { fabric: 'shared' },
            },
          ],
        },
      },
      compositions: {
        hero: {
          layers: ['back', 'front'],
          anchors: { origin: { x: 50, y: 60 } },
          slots: { outfit: { parts: ['cloak'], default: 'cloak' } },
        },
      },
    })
    ui.edit('Definition kind', 'parts')
    ui.edit('Graphic definition', 'cloak')
    ui.edit('Preview palette', 'ocean')
    expect(ui.editor.hasDrafts()).toBe(false)
    ui.click('Remove palette ocean')
    expect(
      ui.root.all().some((node) => node.tagName === 'label' && node.ownText === 'Preview palette'),
    ).toBe(false)
    ui.submit('Save parts and compositions')
    await ui.flush()
    expect(ui.read().assets!.parts.cloak!.palettes).toEqual({})
    await ui.controller.load('demo')
    expect(ui.field('Graphic definition').value).toBe('cloak')
    expect(ui.field('Piece layer', 'Piece rear').value).toBe('back')
  })

  it('keeps invalid and conflicting graphic drafts editable across unrelated saves', async () => {
    const ui = await connected(bindGraphicDefinitionsEditor, graphicProject())
    ui.edit('New graphic definition ID', 'cape')
    ui.click('Add part')
    ui.submit('Save parts and compositions')
    expect(ui.commands).toHaveLength(0)
    expect(ui.editor.hasDrafts()).toBe(true)
    ui.edit('New piece ID', 'fabric')
    ui.click('Add image piece')
    ui.rejectNext()
    ui.submit('Save parts and compositions')
    await ui.flush()
    await ui.controller.save({
      type: 'game.updateMetadata',
      title: 'Changed',
      description: '',
      version: '1',
    })
    expect(ui.field('Graphic definition').value).toBe('cape')
    expect(ui.field('Piece image').value).toBe('cloth')
    expect(ui.editor.hasDrafts()).toBe(true)
    ui.submit('Save parts and compositions')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.read().assets!.parts.cape).toBeDefined()
    ui.edit('Piece rotation', '25')
    expect(ui.editor.navigate('compositions')).toBe(false)
    ui.click('Discard graphic definitions draft')
    expect(ui.field('Piece rotation').value).toBe('0')
  })

  it('guards pending identifiers and rejects duplicate or reserved definition and piece IDs', async () => {
    const ui = await connected(bindGraphicDefinitionsEditor, graphicProject())
    ui.edit('New graphic definition ID', 'cloth')
    ui.click('Add part')
    expect(ui.root.textContent).toContain('valid, unused identifier')
    ui.edit('New graphic definition ID', '__proto__')
    ui.click('Add part')
    expect(ui.root.textContent).toContain('valid, unused identifier')
    ui.edit('New graphic definition ID', 'part')
    ui.click('Add part')
    ui.edit('New piece ID', 'piece')
    ui.edit('Definition kind', 'compositions')
    expect(ui.field('Definition kind').value).toBe('parts')
    ui.submit('Save parts and compositions')
    expect(ui.root.textContent).toContain('pending identifiers')
    ui.click('Add image piece')
    ui.edit('New piece ID', 'piece')
    ui.click('Add image piece')
    expect(ui.root.textContent).toContain('valid, unused identifier')
    ui.edit('New piece ID', '')
    ui.submit('Save parts and compositions')
    await ui.flush()
    expect(ui.read().assets!.parts.part!.pieces).toHaveLength(1)
  })

  it('retains referenced deletions and permits removing a composition and its part together', async () => {
    const ui = await connected(bindGraphicDefinitionsEditor, graphicProject())
    ui.edit('New graphic definition ID', 'part')
    ui.click('Add part')
    ui.edit('New piece ID', 'piece')
    ui.click('Add image piece')
    ui.edit('Definition kind', 'compositions')
    ui.edit('New graphic definition ID', 'hero')
    ui.click('Add composition')
    ui.edit('New slot ID', 'outfit')
    ui.click('Add composition slot')
    ui.submit('Save parts and compositions')
    await ui.flush()
    ui.edit('Definition kind', 'parts')
    ui.edit('Graphic definition', 'part')
    ui.click('Remove part')
    ui.submit('Save parts and compositions')
    expect(ui.editor.hasDrafts()).toBe(true)
    expect(ui.root.textContent).toContain('Missing part part')
    ui.edit('Definition kind', 'compositions')
    ui.edit('Graphic definition', 'hero')
    ui.click('Remove composition')
    ui.submit('Save parts and compositions')
    await ui.flush()
    expect(ui.read().assets).toMatchObject({ parts: {}, compositions: {} })
    expect(ui.read().assets!.images.cloth).toBeDefined()
  })

  it('authors languages and multiline translations with live fallback and intentional empty text', async () => {
    const ui = await connected(bindLocalizationEditor)
    ui.click('Add language')
    ui.edit('New language tag', 'nl')
    ui.click('Add language')
    ui.edit('New translation key', 'story.welcome')
    ui.click('Add translation key')
    ui.edit('Translation text (en)', 'Hello\ntraveler')
    expect(ui.field('Translation text (nl)')).toHaveProperty('disabled', true)
    expect(ui.field('Translation text (nl)').value).toBe('Hello\ntraveler')
    ui.edit('Text source (nl)', 'translated')
    ui.edit('Translation text (nl)', '')
    ui.submit('Save localization')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.read().languageCatalogs).toEqual({
      en: { 'story.welcome': 'Hello\ntraveler' },
      nl: { 'story.welcome': '' },
    })
    expect(ui.read().translationKeys).toContain('story.welcome')
    ui.edit('Text source (nl)', 'default')
    ui.edit('New translation key', 'story.goodbye')
    ui.click('Add translation key')
    ui.edit('Translation text (en)', 'Goodbye')
    ui.edit('Translation key', 'story.welcome')
    expect(ui.field('Translation text (nl)').value).toBe('Hello\ntraveler')
    ui.edit('Default language', 'nl')
    expect(ui.field('Translation text (nl)').value).toBe('Hello\ntraveler')
    ui.submit('Save localization')
    await ui.flush()
    expect(ui.read().game!.languages!.default).toBe('nl')
    expect(ui.read().languageCatalogs!.nl).toEqual({
      'story.welcome': 'Hello\ntraveler',
      'story.goodbye': 'Goodbye',
    })
    await ui.controller.load('demo')
    expect(ui.field('Default language').value).toBe('nl')
    expect(ui.field('Translation text (nl)').value).toBe('Hello\ntraveler')
  })

  it('finds translation keys by key or text and marks keys without a translation', async () => {
    const ui = await connected(bindLocalizationEditor)
    ui.click('Add language')
    ui.edit('New language tag', 'nl')
    ui.click('Add language')
    ui.edit('New translation key', 'story.welcome')
    ui.click('Add translation key')
    ui.edit('Translation text (en)', 'Hello')
    ui.edit('Text source (nl)', 'translated')
    ui.edit('Translation text (nl)', 'Hallo')
    ui.edit('New translation key', 'story.goodbye')
    ui.click('Add translation key')
    ui.edit('Translation text (en)', 'Goodbye')
    const options = () => ui.field('Translation key').children.map((option) => option.ownText)
    expect(options()).toEqual(['Choose a key', 'story.goodbye · no nl text', 'story.welcome'])
    ui.edit('Translation key', '')
    ui.edit('Find translation key', 'hallo')
    expect(options()).toEqual(['Choose a key', 'story.welcome'])
    ui.edit('Find translation key', '')
    ui.edit('Show', 'missing')
    expect(options()).toEqual(['Choose a key', 'story.goodbye · no nl text'])
    expect(ui.editor.hasDrafts()).toBe(true)
  })

  it('preserves failed localization drafts through unrelated saves and permits retry or discard', async () => {
    const ui = await connected(bindLocalizationEditor)
    ui.click('Add language')
    ui.edit('New translation key', 'greeting')
    ui.click('Add translation key')
    ui.edit('Translation text (en)', 'Draft')
    ui.rejectNext()
    ui.submit('Save localization')
    await ui.flush()
    await ui.controller.save({
      type: 'game.updateMetadata',
      title: 'Changed',
      description: '',
      version: '1',
    })
    expect(ui.field('Translation text (en)').value).toBe('Draft')
    expect(ui.editor.hasDrafts()).toBe(true)
    ui.submit('Save localization')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    ui.edit('Translation text (en)', 'Unsaved')
    await ui.controller.load('demo', true)
    expect(ui.field('Translation text (en)').value).toBe('Unsaved')
    ui.click('Discard localization draft')
    expect(ui.field('Translation text (en)').value).toBe('Draft')
    ui.edit('Translation text (en)', 'Discard on load')
    await ui.controller.load('demo')
    expect(ui.field('Translation text (en)').value).toBe('Draft')
  })

  it('rejects duplicate and invalid identifiers and guards pending inputs while saving', async () => {
    const ui = await connected(bindLocalizationEditor)
    ui.click('Add language')
    ui.edit('New language tag', 'EN')
    ui.click('Add language')
    expect(ui.root.textContent).toContain('unique language tag')
    ui.edit('New language tag', '../nl')
    ui.click('Add language')
    expect(ui.root.textContent).toContain('unique language tag')
    ui.edit('New language tag', '')
    ui.edit('New translation key', 'invalid key')
    ui.click('Add translation key')
    expect(ui.root.textContent).toContain('unused key')
    ui.edit('New translation key', 'greeting')
    ui.click('Add translation key')
    ui.edit('New translation key', 'greeting')
    ui.click('Add translation key')
    expect(ui.root.textContent).toContain('unused key')
    ui.submit('Save localization')
    expect(ui.commands).toHaveLength(0)
    expect(ui.root.textContent).toContain('pending language tag or translation key')
    ui.edit('New translation key', '')
    ui.submit('Save localization')
    await ui.flush()
    expect(ui.read().game!.languages!.available).toEqual(['en'])
    expect(
      ui.root
        .all()
        .find((node) => node.tagName === 'button' && node.textContent === 'Remove language en'),
    ).toHaveProperty('disabled', true)
  })

  it('retains a referenced-key deletion for correction and removes languages with their fallback intact', async () => {
    const ui = await connected(bindLocalizationEditor)
    ui.click('Add language')
    ui.edit('New language tag', 'nl')
    ui.click('Add language')
    ui.edit('New translation key', 'greeting')
    ui.click('Add translation key')
    ui.edit('Translation text (en)', 'Hello')
    ui.submit('Save localization')
    await ui.flush()
    await ui.controller.save({
      type: 'scene.upsertComponent',
      sceneId: 'shop',
      component: textComponentSchema.parse({
        id: 'welcome',
        type: 'text',
        textKey: 'greeting',
        placement: { row: 3, column: 1 },
      }),
    })
    ui.click('Remove translation key')
    ui.submit('Save localization')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(true)
    expect(ui.read().translationKeys).toContain('greeting')
    ui.edit('New translation key', 'greeting')
    ui.click('Add translation key')
    ui.edit('Translation text (en)', 'Restored')
    ui.click('Remove language en')
    expect(ui.field('Default language').value).toBe('nl')
    expect(ui.field('Translation text (nl)').value).toBe('Restored')
    ui.submit('Save localization')
    await ui.flush()
    expect(ui.read().languageCatalogs).toEqual({ nl: { greeting: 'Restored' } })
    expect(ui.editor.hasDrafts()).toBe(false)
  })

  it('keeps a custom leveling profile and display selected after saving and reloading', async () => {
    const ui = await connected(bindLevelingEditor, progressionProject())
    ui.click('Add leveling profile')
    ui.edit('Profile ID', 'hero')
    ui.edit('Display component ID', 'hero-levels')
    ui.submit('Save character levels')
    await ui.flush()
    expect(ui.field('Leveling profile').value).toBe('hero')
    expect(ui.field('Profile ID').value).toBe('hero')
    expect(ui.field('Display component ID').value).toBe('hero-levels')
    expect(ui.editor.hasDrafts()).toBe(false)
    ui.edit('Profile label', 'Hero progression')
    ui.submit('Save character levels')
    await ui.flush()
    expect(ui.read().leveling!.hero!.label).toBe('Hero progression')
    expect(ui.read().game!.leveling).toEqual(['hero'])
    await ui.controller.load('demo')
    expect(ui.field('Profile ID').value).toBe('hero')
    expect(ui.field('Display component ID').value).toBe('hero-levels')
  })

  it('retains a failed custom leveling draft across unrelated saves and selects it after retry', async () => {
    const ui = await connected(bindLevelingEditor, progressionProject())
    ui.click('Add leveling profile')
    ui.edit('Profile ID', 'hero')
    ui.edit('Display component ID', 'hero-levels')
    ui.rejectNext()
    ui.submit('Save character levels')
    await ui.flush()
    await ui.controller.save({
      type: 'game.updateMetadata',
      title: 'Changed',
      description: '',
      version: '1',
    })
    expect(ui.field('Profile ID').value).toBe('hero')
    expect(ui.field('Display component ID').value).toBe('hero-levels')
    expect(ui.editor.hasDrafts()).toBe(true)
    ui.submit('Save character levels')
    await ui.flush()
    expect(ui.field('Leveling profile').value).toBe('hero')
    expect(ui.editor.hasDrafts()).toBe(false)
  })

  it('edits and removes the selected duplicate level display while preserving the original', async () => {
    const first = await connected(bindLevelingEditor, progressionProject())
    first.click('Add leveling profile')
    first.submit('Save character levels')
    await first.flush()
    await first.controller.save({
      type: 'scene.duplicateComponent',
      sceneId: 'shop',
      componentId: 'progression-player',
      newId: 'second-display',
    })
    expect(first.editor.navigate('shop', 'player', 'second-display')).toBe(true)
    expect(first.field('Display component ID').value).toBe('second-display')
    first.edit('Row', '4')
    expect(first.editor.navigate('shop', 'player', 'progression-player')).toBe(false)
    first.edit('Level display', 'progression-player')
    expect(first.field('Level display').value).toBe('second-display')
    first.submit('Save character levels')
    await first.flush()
    expect(first.field('Level display').value).toBe('second-display')
    expect(first.field('Display component ID').value).toBe('second-display')

    const displays = first
      .read()
      .scenes[0]!.components.filter((component) => component.type === 'character-progression')

    expect(displays.map((component) => [component.id, component.placement.row])).toEqual([
      ['progression-player', 1],
      ['second-display', 4],
    ])
    first.edit('Level display', 'progression-player')
    expect(first.field('Row').value).toBe('1')
    first.edit('Level display', 'second-display')
    first.click('Remove level display from scene')
    await first.flush()
    expect(
      first
        .read()
        .scenes[0]!.components.filter((component) => component.type === 'character-progression')
        .map((component) => component.id),
    ).toEqual(['progression-player'])
    expect(first.field('Display component ID').value).toBe('progression-player')
  })

  it('allows a custom shop ID before creation and keeps saved identity stable through later edits', async () => {
    const source = applyCommand(progressionProject(), {
      type: 'game.upsertInventory',
      inventoryId: 'items',
      inventory: inventorySchema.parse({
        'schema-version': '1.0.0',
        itemTypes: {},
        items: {},
        owners: { player: { label: 'Hero' }, merchant: { label: 'Merchant' } },
      }),
    }).project

    const ui = await connected(bindShopEditor, source)
    ui.click('Add shop')
    expect(ui.field('Shop ID')).not.toHaveProperty('readOnly', true)
    ui.edit('Shop ID', 'market')
    ui.submit('Save shop')
    await ui.flush()
    expect(ui.field('Shop ID')).toHaveProperty('readOnly', true)
    expect(ui.field('Shop ID').value).toBe('market')
    await ui.controller.save({
      type: 'scene.setActionBar',
      sceneId: 'shop',
      component: actionBarComponentSchema.parse({
        id: 'trade-actions',
        type: 'action-bar',
        placement: { row: 3, column: 1 },
        slots: {
          '1': { label: 'Buy', action: { type: 'shop-action', shop: 'market', operation: 'buy' } },
        },
      }),
    })
    ui.edit('Shop title', 'Market stalls')
    ui.submit('Save shop')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    const scene = ui.read().scenes[0]!
    expect(scene.components.filter((component) => component.type === 'shop')).toMatchObject([
      { id: 'market', label: 'Market stalls' },
    ])
    expect(scene.components.find((component) => component.type === 'action-bar')).toMatchObject({
      slots: { '1': { action: { shop: 'market' } } },
    })
    await ui.controller.load('demo')
    expect(ui.field('Shop ID')).toHaveProperty('readOnly', true)
    expect(ui.field('Shop title').value).toBe('Market stalls')
  })

  function triggerProject() {
    let source = project()
    source = {
      ...source,
      documents: {
        ...source.documents,
        'game.json': {
          ...object(source.documents['game.json']),
          inventory: ['items'],
          rules: ['rules'],
        },
        'inventory/items.json': inventorySchema.parse({
          'schema-version': '1.0.0',
          owners: {},
          items: {},
          itemTypes: {
            letter: {
              label: 'Letter',
              inspection: {
                action: 'inspect',
                details: { source: 'game.state', path: ['result'] },
              },
            },
            book: { label: 'Book' },
          },
        }),
        'rules/rules.json': {
          state: [{ path: ['result'], value: '' }],
          actions: { inspect: [{ when: [], effects: [] }] },
        },
      },
    }

    for (const id of ['one', 'two'])
      source = applyCommand(source, {
        type: 'scene.upsertRuleButton',
        sceneId: 'shop',
        component: {
          id,
          type: 'button',
          label: id,
          placement: { row: 1, column: 1, rowSpan: 1, columnSpan: 1 },
        },
      }).project

    return source
  }

  it('protects button and scene selectors until a trigger draft is saved or discarded', async () => {
    const ui = await connected(bindRulesPanel, triggerProject())
    ui.click('Trigger links')
    ui.edit('Button', 'one')
    ui.edit('Label', 'Changed label')
    ui.edit('Button', 'two')
    expect(ui.field('Button').value).toBe('one')
    expect(ui.field('Label').value).toBe('Changed label')
    expect(ui.root.textContent).toContain('before switching buttons')
    ui.edit('Game scene', 'other')
    expect(ui.field('Game scene').value).toBe('shop')
    expect(ui.field('Label').value).toBe('Changed label')
    ui.submit('Save button')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    ui.edit('Button', 'two')
    ui.edit('Label', 'Discard me')
    ui.click('Discard trigger draft')
    expect(ui.editor.hasDrafts()).toBe(false)
    ui.edit('Button', 'one')
    expect(ui.field('Label').value).toBe('Changed label')
    ui.edit('Game scene', 'other')
    expect(ui.field('Game scene').value).toBe('other')
  })

  it('protects inspection targets and retains another trigger draft through saves, conflicts and refreshes', async () => {
    const ui = await connected(bindRulesPanel, triggerProject())
    ui.edit('Button', 'one')
    ui.edit('Label', 'Keep this label')
    ui.edit('Show inspection in inventory', 'no')
    ui.edit('Item type', 'book', 'Inventory inspection')
    expect(ui.field('Item type', 'Inventory inspection').value).toBe('letter')
    expect(ui.field('Show inspection in inventory').value).toBe('no')
    ui.submit('Save inspection')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(true)
    expect(ui.field('Label').value).toBe('Keep this label')
    ui.edit('Item type', 'book', 'Inventory inspection')
    expect(ui.field('Item type', 'Inventory inspection').value).toBe('book')
    ui.rejectNext()
    ui.submit('Save button')
    await ui.flush()
    expect(ui.field('Label').value).toBe('Keep this label')
    ui.edit('Button', 'two')
    expect(ui.field('Button').value).toBe('one')
    await ui.controller.save({
      type: 'game.updateMetadata',
      title: 'Updated',
      description: '',
      version: '1',
    })
    expect(ui.field('Label').value).toBe('Keep this label')
    ui.submit('Save button')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
  })

  it('clears locally discarded item-action and nearby drafts without losing other trigger edits', async () => {
    const ui = await connected(bindRulesPanel, triggerProject())
    ui.edit('Button', 'one')
    ui.edit('Label', 'Keep button')
    ui.click('Add item action')
    ui.click('Discard item-action draft')
    expect(ui.field('Label').value).toBe('Keep button')
    ui.edit('Nearby title', 'Changed nearby')
    ui.click('Discard nearby draft')
    expect(ui.field('Label').value).toBe('Keep button')
    ui.submit('Save button')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
  })

  it.each(['dialogue', 'quest'] as const)(
    'clears a saved %s draft through the real controller and allows create, edit and delete',
    async (kind) => {
      const ui = await connected(bindStoryEditor)
      ui.click(`Add ${kind}`)
      ui.edit('Definition ID', `new-${kind}`)
      ui.edit('Name', 'Saved definition')
      ui.submit(`Save ${kind}`)
      await ui.flush()
      expect(ui.editor.hasDrafts()).toBe(false)
      expect(ui.field('Dialogue or quest').value).toBe(`${kind}:new-${kind}`)
      ui.click(kind === 'dialogue' ? 'Add quest' : 'Add dialogue')
      expect(ui.field('Definition ID').value).toBe(kind === 'dialogue' ? 'quest' : 'dialogue')
      ui.click('Discard story draft')
      ui.edit('Dialogue or quest', `${kind}:new-${kind}`)
      ui.edit('Name', 'Updated definition')
      ui.submit(`Save ${kind}`)
      await ui.flush()
      expect(ui.editor.hasDrafts()).toBe(false)
      expect(ui.field('Name').value).toBe('Updated definition')
      ui.click('Delete definition')
      await ui.flush()
      expect(ui.editor.hasDrafts()).toBe(false)
      expect(ui.field('Dialogue or quest').value).toBe('')
    },
  )

  it.each(['story', 'journal'] as const)(
    'preserves independent story and journal edits when saving %s first',
    async (first) => {
      const ui = await connected(bindStoryEditor)
      ui.click('Add dialogue')
      ui.edit('Name', 'Keep conversation')
      ui.edit('Journal scene', 'shop')
      ui.edit('Journal label', 'Keep journal')
      const firstSave = first === 'story' ? 'Save dialogue' : 'Save quest journal'
      const secondSave = first === 'story' ? 'Save quest journal' : 'Save dialogue'
      ui.submit(firstSave)
      await ui.flush()
      expect(ui.editor.hasDrafts()).toBe(true)
      expect(ui.field('Name').value).toBe('Keep conversation')
      expect(ui.field('Journal label').value).toBe('Keep journal')
      ui.submit(secondSave)
      await ui.flush()
      expect(ui.editor.hasDrafts()).toBe(false)
      ui.edit('Journal scene', 'other')
      expect(ui.field('Journal scene').value).toBe('other')
    },
  )

  it('retains a failed story draft through an unrelated save of the same command type, then clears it on retry', async () => {
    const ui = await connected(bindStoryEditor)
    ui.click('Add dialogue')
    ui.edit('Name', 'Retry conversation')
    ui.rejectNext()
    ui.submit('Save dialogue')
    await ui.flush()
    const failed = ui.commands[0]!

    if (failed.type !== 'game.upsertDialogue') throw new Error('Expected dialogue save')
    await ui.controller.save({
      ...failed,
      dialogue: { ...failed.dialogue, id: 'external', label: 'Another conversation' },
    })
    expect(ui.field('Name').value).toBe('Retry conversation')
    expect(ui.editor.hasDrafts()).toBe(true)
    ui.submit('Save dialogue')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
  })

  it('retains a failed journal draft until its own retry succeeds', async () => {
    const ui = await connected(bindStoryEditor)
    ui.edit('Journal scene', 'shop')
    ui.edit('Journal label', 'Retry journal')
    ui.rejectNext()
    ui.submit('Save quest journal')
    await ui.flush()
    const failed = ui.commands[0]!

    if (failed.type !== 'scene.upsertComponent') throw new Error('Expected journal save')
    await ui.controller.save({ ...failed, sceneId: 'other' })
    expect(ui.editor.hasDrafts()).toBe(true)
    expect(ui.field('Journal label').value).toBe('Retry journal')
    ui.edit('Journal scene', 'other')
    expect(ui.field('Journal scene').value).toBe('shop')
    ui.submit('Save quest journal')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
  })

  it('creates types, owners, slots and starting placements together from an empty project', async () => {
    const ui = await connected(bindInventoryEditor)
    ui.edit('Inventory entry kind', 'owners')
    ui.edit('New entry ID', 'player')
    ui.click('Add owner')
    ui.edit('Owner name', 'Hero')
    ui.edit('New slot ID', 'hand')
    ui.edit('New slot name', 'Hand')
    ui.click('Add equipment slot')
    ui.edit('Inventory entry kind', 'itemTypes')
    ui.edit('New entry ID', 'bag')
    ui.click('Add item type')
    ui.edit('Can contain items', 'true')
    ui.edit('New entry ID', 'sword')
    ui.click('Add item type')
    ui.edit('Fits slot hand', 'true')
    ui.edit('Item name', 'Iron sword')
    ui.edit('Inventory entry kind', 'items')
    ui.edit('New entry ID', 'pack')
    ui.click('Add starting item')
    ui.edit('New entry ID', 'blade')
    ui.click('Add starting item')
    ui.edit('Starting item type', 'sword')
    ui.edit('Starting placement', 'equipped')
    ui.edit('New entry ID', 'spare')
    ui.click('Add starting item')
    ui.edit('Starting item type', 'sword')
    ui.edit('Starting placement', 'inside')
    ui.edit('Starting container', 'pack')
    ui.submit('Save inventory')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.read().inventory).toMatchObject({
      owners: { player: { label: 'Hero', equipmentSlots: { hand: 'Hand' } } },
      itemTypes: {
        bag: { container: true },
        sword: { label: 'Iron sword', equipmentSlots: ['hand'] },
      },
      items: {
        pack: { placement: { type: 'carried', owner: 'player' } },
        blade: { placement: { type: 'equipped', owner: 'player', slot: 'hand' } },
        spare: { placement: { type: 'inside', container: 'pack' } },
      },
    })
    await ui.controller.load('demo')
    expect(ui.field('Starting container').value).toBe('pack')
    expect(ui.field('Inventory ID').value).toBe('items')
  })

  it('keeps invalid containment edits available and allows related fixes before a single save', async () => {
    const data = inventorySchema.parse({
      'schema-version': '1.0.0',
      itemTypes: { bag: { label: 'Bag', container: true } },
      owners: { player: { label: 'Player' } },
      items: {
        bag1: { itemType: 'bag', placement: { type: 'carried', owner: 'player' } },
        bag2: { itemType: 'bag', placement: { type: 'carried', owner: 'player' } },
      },
    })

    const source = applyCommand(project(), {
      type: 'game.upsertInventory',
      inventoryId: 'items',
      inventory: data,
    }).project

    const ui = await connected(bindInventoryEditor, source)
    ui.edit('Inventory entry kind', 'items')
    ui.edit('Inventory entry', 'bag1')
    ui.edit('Starting placement', 'inside')
    ui.edit('Starting container', 'bag2')
    ui.edit('Inventory entry', 'bag2')
    ui.edit('Starting placement', 'inside')
    ui.edit('Starting container', 'bag1')
    ui.submit('Save inventory')
    expect(ui.root.textContent).toContain('containment cycle')
    expect(ui.commands).toEqual([])
    expect(ui.field('Starting container').value).toBe('bag1')
    ui.edit('Starting placement', 'carried')
    ui.submit('Save inventory')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.read().inventory!.items.bag1!.placement).toEqual({
      type: 'inside',
      container: 'bag2',
    })
  })

  it('rejects duplicate IDs and deleting referenced owners, then saves a coherent cleanup', async () => {
    const data = inventorySchema.parse({
      'schema-version': '1.0.0',
      itemTypes: { coin: { label: 'Coin' } },
      owners: { player: { label: 'Player' } },
      items: { coin1: { itemType: 'coin', placement: { type: 'carried', owner: 'player' } } },
    })

    const source = applyCommand(project(), {
      type: 'game.upsertInventory',
      inventoryId: 'items',
      inventory: data,
    }).project

    const ui = await connected(bindInventoryEditor, source)
    ui.edit('New entry ID', 'Coin')
    ui.click('Add item type')
    expect(ui.root.textContent).toContain('unused entry ID')
    ui.edit('New entry ID', '')
    ui.edit('Inventory entry kind', 'owners')
    ui.edit('Inventory entry', 'player')
    ui.click('Remove owner')
    ui.submit('Save inventory')
    expect(ui.root.textContent).toContain('Unknown inventory owner')
    ui.edit('Inventory entry kind', 'items')
    ui.edit('Inventory entry', 'coin1')
    ui.click('Remove starting item')
    ui.submit('Save inventory')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.read().inventory!.owners).toEqual({})
    expect(ui.read().inventory!.items).toEqual({})
  })

  it('retains a failed inventory draft through unrelated saves and guards file and pending-slot navigation', async () => {
    const ui = await connected(bindInventoryEditor)
    ui.edit('New entry ID', 'coin')
    ui.click('Add item type')
    ui.edit('Item name', 'Gold coin')
    ui.rejectNext()
    ui.submit('Save inventory')
    await ui.flush()
    await ui.controller.save({
      type: 'game.updateMetadata',
      title: 'Other save',
      description: '',
      version: '1',
    })
    expect(ui.field('Item name').value).toBe('Gold coin')
    expect(ui.editor.hasDrafts()).toBe(true)
    ui.submit('Save inventory')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    ui.edit('Inventory file', '')
    ui.edit('Inventory entry kind', 'owners')
    ui.edit('New entry ID', 'merchant')
    ui.click('Add owner')
    ui.edit('Inventory file', 'items')
    expect(ui.field('Inventory file').value).toBe('')
    ui.edit('New slot ID', 'hand')
    ui.edit('Inventory entry kind', 'itemTypes')
    expect(ui.field('Inventory entry kind').value).toBe('owners')
    ui.submit('Save inventory')
    expect(ui.root.textContent).toContain('pending entry or equipment slot')
    ui.click('Discard inventory draft')
    ui.edit('Inventory file', 'items')
    expect(ui.field('Inventory file').value).toBe('items')
  })

  it('creates an inventory panel and equipment view without JSON and guards mode switches with drafts', async () => {
    const ui = await connected(bindItemEditor)
    ui.click('Item views and advanced settings')
    ui.click('Add equipment')
    expect(ui.root.textContent).toContain('Add an inventory panel')
    ui.click('Inventory definitions')
    ui.edit('Inventory entry kind', 'owners')
    ui.edit('New entry ID', 'player')
    ui.click('Add owner')
    ui.click('Item views and advanced settings')
    expect(ui.root.textContent).toContain('before switching editors')
    ui.submit('Save inventory')
    await ui.flush()
    ui.click('Item views and advanced settings')
    ui.click('Add inventory')
    ui.edit('View ID', 'items')
    ui.edit('View label', 'Backpack')
    ui.submit('Save items and equipment')
    await ui.flush()
    expect(ui.editor.hasDrafts()).toBe(false)
    ui.click('Add equipment')
    ui.submit('Save items and equipment')
    await ui.flush()
    expect(ui.read().scenes[0]!.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'items',
          type: 'inventory',
          owners: ['player'],
          label: 'Backpack',
        }),
        expect.objectContaining({ type: 'equipment', inventory: 'items', owner: 'player' }),
      ]),
    )
    expect(ui.editor.hasDrafts()).toBe(false)
  })

  it('discards both story and journal drafts when explicitly reloading the project', async () => {
    const ui = await connected(bindStoryEditor)
    ui.click('Add dialogue')
    ui.edit('Journal scene', 'shop')
    ui.edit('Journal label', 'Discard journal')
    expect(ui.editor.hasDrafts()).toBe(true)
    await ui.controller.load('demo')
    expect(ui.editor.hasDrafts()).toBe(false)
    expect(ui.field('Journal label').value).toBe('Quests')
  })
})

describe('dialogue and quest editor controls', () => {
  it('authors nodes and preserves a conflicting dialogue draft', () => {
    const { root, initial, edit, click, submit, commands, field } = panel()
    const editor = bindStoryEditor(root.asElement(), (command) => commands.push(command))
    editor.render(initial, true)
    click('Add dialogue')
    edit('Definition ID', 'greeting')
    edit('Name', 'A conversation')
    edit('Dialogue text', 'Welcome back.')
    editor.render(
      {
        ...initial,
        view: { ...initial.view!, revision: 'changed' },
        preserveDrafts: true,
        conflict: true,
      },
      false,
    )
    expect(field('Name').value).toBe('A conversation')
    submit('Save dialogue')
    expect(commands[0]).toMatchObject({
      type: 'game.upsertDialogue',
      dialogue: {
        id: 'greeting',
        label: 'A conversation',
        nodes: { start: { lines: [{ text: 'Welcome back.' }] } },
      },
    })
    click('Add quest')
    expect(root.textContent).toContain('Save or discard')
    expect(editor.hasDrafts()).toBe(true)
  })
  it('authors quest objectives, hand-ins, rewards and a journal', () => {
    const { root, initial, edit, click, submit, commands } = panel()
    const editor = bindStoryEditor(root.asElement(), (command) => commands.push(command))
    editor.render(initial, true)
    click('Add quest')
    edit('Name', 'Visit the shop')
    submit('Save quest')
    expect(commands[0]).toMatchObject({
      type: 'game.upsertQuest',
      quest: {
        label: 'Visit the shop',
        stages: [{ objectives: [{ when: [{ type: 'scene-is', scene: 'shop' }] }] }],
      },
    })
    edit('Journal scene', 'shop')
    edit('Journal Row', '3')
    edit('Journal main text', 'description')
    submit('Save quest journal')
    expect(commands[1]).toMatchObject({
      type: 'scene.upsertComponent',
      sceneId: 'shop',
      component: { type: 'quest-log', textTarget: 'description', placement: { row: 3 } },
    })
  })
})
