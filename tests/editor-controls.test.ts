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
import {
  actionBarComponentSchema,
  inputSchema,
  inventorySchema,
  sceneComponentSchema,
} from '@ancadeba/schemas'
import { bindActionBarPanel } from '../apps/editor-ui/src/actionBarPanel.js'
import { createInputDraft, readInputDraft } from '../apps/editor-ui/src/inputDefinitionForm.js'
import type { ProjectEditorState } from '../apps/editor-ui/src/projectController.js'
import { inventoryActionsForm } from '../apps/editor-ui/src/inventoryActionsForm.js'
import { ruleFormControls } from '../apps/editor-ui/src/ruleFormControls.js'
import { ruleTriggerForms } from '../apps/editor-ui/src/ruleTriggerForms.js'
import { nearbyForm } from '../apps/editor-ui/src/nearbyForm.js'
import { bindStatusPanelEditor } from '../apps/editor-ui/src/statusPanelEditor.js'
import { bindItemEditor } from '../apps/editor-ui/src/itemEditor.js'
import { bindCombatEditor } from '../apps/editor-ui/src/combatEditor.js'
import { bindShopEditor } from '../apps/editor-ui/src/shopEditor.js'

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
    edit('Player AP', '4')
    edit('Enemy 1 rotation (IDs)', 'guard, attack')
    edit('Enemy 1 available moves (IDs)', 'attack, guard')
    edit('Move attack maximum damage', '7')
    edit('Allow escape', 'true')
    edit('victory destination', 'other')
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
    expect(field('Move attack maximum damage').value).toBe('7')
    expect(field('Reward 1 amount').value).toBe('8')
    submit('Save combat encounter')
    const saved = commands[0]!
    expect(saved).toMatchObject({
      type: 'game.upsertCombat',
      encounter: {
        label: '<b>Training</b>',
        player: { ap: 4 },
        enemies: [{ rotation: ['guard', 'attack'] }],
        moves: { attack: { damage: { max: 7 } } },
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
    edit('buy amount', '7')
    edit('sell price source', 'fixed')
    edit('sell amount', '4')
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
    expect(field('buy amount').value).toBe('7')
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
      presentation: {
        description: 'A warm cloak',
        properties: [{ id: 'property', label: 'Value', value: 12 }],
      },
    })
    click('Discard item draft')
    click('Add equipment')
    edit('Equipment owner', 'player')
    edit('Grid columns', '2')
    edit('Slot order (comma separated IDs)', 'body')
    submit('Save items and equipment')
    expect(commands[1]).toMatchObject({
      type: 'scene.upsertItemView',
      component: {
        type: 'equipment',
        inventory: 'items',
        owner: 'player',
        columns: 2,
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
