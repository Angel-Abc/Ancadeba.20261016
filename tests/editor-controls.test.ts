/// <reference lib="dom" />
import { describe, expect, it } from 'vite-plus/test'
import {
  applyCommand,
  inspectProject,
  object,
  projectViewSchema,
  type EditorCommand,
  type ProjectSnapshot,
} from '@ancadeba/editor-core'
import { actionBarComponentSchema, inputSchema } from '@ancadeba/schemas'
import { bindActionBarPanel } from '../apps/editor-ui/src/actionBarPanel.js'
import { createInputDraft, readInputDraft } from '../apps/editor-ui/src/inputDefinitionForm.js'
import type { ProjectEditorState } from '../apps/editor-ui/src/projectController.js'

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
  type = ''
  className = ''
  disabled = false
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

  const field = (title: string) => {
    const label = root.all().find((node) => node.tagName === 'label' && node.ownText === title)

    if (!label) throw new Error(`Missing field: ${title}`)

    return label.children[0]!
  }

  const edit = (title: string, value: string) => {
    const control = field(title)
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

describe('action bar editor controls', () => {
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
