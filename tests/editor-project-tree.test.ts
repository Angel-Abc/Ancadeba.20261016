/// <reference lib="dom" />
import { describe, expect, it } from 'vite-plus/test'
import { projectViewSchema } from '@ancadeba/editor-core'
import {
  buildProjectTree,
  dataFilesSection,
  filterProjectTree,
  flattenProjectTree,
  ruleFileNodes,
  sceneTitle,
  type ProjectTreeNode,
} from '../apps/editor-ui/src/projectTree.js'
import { bindProjectTree } from '../apps/editor-ui/src/projectTreeView.js'
import { editorLocalization } from '../apps/editor-ui/src/localization.js'

const view = projectViewSchema.parse({
  revision: 'one',
  game: {
    'schema-version': '1.0.0',
    id: 'test',
    title: 'Test',
    version: '1',
    scenes: ['standard'],
    'initial-scene': 'standard',
  },
  scenes: [
    {
      'schema-version': '1.0.0',
      id: 'standard',
      title: 'Standard',
      type: 'game',
      screen: { type: 'grid', grid: { rows: 4, columns: 4 } },
      components: [
        { id: 'health', type: 'text', text: 'Health', placement: { row: 1, column: 1 } },
      ],
    },
  ],
  assets: {
    'schema-version': '1.0.0',
    images: {
      portrait: {
        format: 'png',
        source: 'portrait.png',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      },
    },
  },
  diagnostics: [],
})

const t = editorLocalization().t

// This harness exercises actual event listeners and focus changes without a browser global.
class TreeElement extends EventTarget {
  children: TreeElement[] = []
  attributes = new Map<string, string>()
  dataset: Record<string, string> = {}
  style = { setProperty: (_name: string, _value: string) => {} }
  value = ''
  textContent = ''
  tabIndex = -1
  className = ''
  title = ''
  placeholder = ''
  constructor(readonly ownerDocument: TreeDocument) {
    super()
  }
  append(...children: TreeElement[]) {
    this.children.push(...children)
  }
  replaceChildren() {
    this.children = []
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }
  contains(element: TreeElement | null): boolean {
    return this === element || this.children.some((child) => child.contains(element))
  }
  focus() {
    this.ownerDocument.activeElement = this
    this.dispatchEvent(new Event('focus'))
  }
  all(): TreeElement[] {
    return [this, ...this.children.flatMap((child) => child.all())]
  }
  asElement(): HTMLElement {
    // @ts-expect-error -- Partial DOM harness implements the tree's element operations.
    return this
  }
  asInput(): HTMLInputElement {
    // @ts-expect-error -- Partial DOM harness implements the search input operations.
    return this
  }
}

class TreeDocument {
  activeElement: TreeElement | null = null
  createElement() {
    return new TreeElement(this)
  }
}

function setup(accept: (node: ProjectTreeNode) => boolean = () => true) {
  const document = new TreeDocument()
  const root = document.createElement()
  const search = document.createElement()
  const selections: string[] = []

  const tree = bindProjectTree(
    root.asElement(),
    search.asInput(),
    (node) => {
      if (!accept(node)) return false
      selections.push(node.key)

      return true
    },
    t,
  )

  tree.render(view, false)

  const row = (key: string) => {
    const element = root.all().find((element) => element.dataset.treeKey === key)

    if (!element) throw new Error(`Missing tree row: ${key}`)

    return element
  }

  const key = (value: string) => {
    const event = new Event('keydown', { cancelable: true })
    Object.defineProperty(event, 'key', { value })
    root.dispatchEvent(event)
  }

  return { tree, root, search, selections, row, key, document }
}

describe('extensible project explorer', () => {
  it('separates scene components from shared assets and marks startup and scene context', () => {
    const nodes = buildProjectTree(view, t)
    expect(nodes.map((node) => node.key)).toEqual(['game', 'scenes', 'assets'])
    const scene = nodes[1]!.children![0]!
    expect(scene.detail).toBe('Game · Startup')
    expect(scene.children![0]).toMatchObject({
      key: 'component:standard:health',
      parentId: 'standard',
      kind: 'component',
    })
    expect(nodes[2]!.children![0]!.children![0]).toMatchObject({
      key: 'asset:portrait',
      kind: 'asset',
    })
    expect(new Set(flattenProjectTree(nodes).map((node) => node.key)).size).toBe(
      flattenProjectTree(nodes).length,
    )
  })

  it('names scenes by their translated title and lists rule, map, and inventory files', () => {
    const scene = { ...view.scenes[0]!, title: '', titleKey: 'scenes.standard.title' }

    const translated = {
      ...view,
      game: { ...view.game!, rules: ['rules', 'puzzle'], maps: ['museum'], inventory: ['shop'] },
      scenes: [scene],
      translations: { 'scenes.standard.title': 'In the museum' },
    }

    expect(sceneTitle(translated, scene)).toBe('In the museum')
    expect(sceneTitle({ ...translated, translations: {} }, scene)).toBe('standard')
    expect(ruleFileNodes(translated).map((node) => node.key)).toEqual([
      'rule-file:rules',
      'rule-file:puzzle',
    ])
    expect(
      flattenProjectTree(dataFilesSection.nodes(translated, t)).map((node) => node.key),
    ).toEqual(['data:maps', 'map:museum', 'data:inventories', 'inventory-file:shop'])
  })

  it('accepts an additional system without changes to the tree renderer', () => {
    const nodes = buildProjectTree(view, t, [
      {
        id: 'maps',
        labelKey: 'Maps',
        nodes: () => [{ key: 'map:world', section: 'maps', kind: 'map', label: 'World' }],
      },
    ])

    expect(nodes[0]!.children![0]!.key).toBe('map:world')
  })

  it('filters by name or ID while retaining ancestors and translating labels', () => {
    const nodes = buildProjectTree(view, t)
    expect(flattenProjectTree(filterProjectTree(nodes, 'HEALTH')).map((node) => node.key)).toEqual([
      'scenes',
      'scene:standard',
      'component:standard:health',
    ])
    expect(filterProjectTree(nodes, 'no match')).toEqual([])
    expect(buildProjectTree(view, editorLocalization(['nl']).t)[1]!.label).toBe('Scènes')
  })

  it('navigates visible branches with arrows without selecting until Enter', () => {
    const { row, key, document, selections, tree } = setup()
    row('scene:standard').focus()
    key('ArrowRight')
    expect(row('scene:standard').getAttribute('aria-expanded')).toBe('true')
    key('ArrowRight')
    expect(document.activeElement).toBe(row('component:standard:health'))
    expect(selections).toEqual([])
    key('Enter')
    expect(selections).toEqual(['component:standard:health'])
    key('ArrowLeft')
    expect(document.activeElement).toBe(row('scene:standard'))
    key('ArrowLeft')
    expect(row('scene:standard').getAttribute('aria-expanded')).toBe('false')
    expect(row('scene:standard').tabIndex).toBe(0)
    tree.dispose()
  })

  it('keeps selection when navigation is refused or busy and falls back after removal', () => {
    const { tree, row, selections } = setup((node) => node.key !== 'scene:standard')
    tree.select('scene:standard')
    expect(row('game').getAttribute('aria-selected')).toBe('true')
    tree.render(view, true)
    tree.select('asset:portrait')
    expect(selections).toEqual([])
    tree.render(view, false)
    tree.select('asset:portrait')
    expect(row('asset:portrait').getAttribute('aria-selected')).toBe('true')
    tree.render({ ...view, assets: undefined }, false)
    expect(row('game').getAttribute('aria-selected')).toBe('true')
    tree.dispose()
  })

  it('retains expansion, selection and focus across revisions and removes listeners on disposal', () => {
    const { tree, row, document, search, root } = setup()
    tree.select('asset:portrait')
    row('asset:portrait').focus()
    tree.render({ ...view, revision: 'two' }, false)
    expect(document.activeElement).toBe(row('asset:portrait'))
    search.value = 'health'
    search.dispatchEvent(new Event('input'))
    expect(row('component:standard:health')).toBeDefined()
    tree.dispose()
    search.dispatchEvent(new Event('input'))
    expect(root.children).toEqual([])
  })
})
