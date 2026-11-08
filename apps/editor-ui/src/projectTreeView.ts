import type { ProjectView } from '@ancadeba/editor-core'
import type { Translate } from '@ancadeba/utilities'
import {
  buildProjectTree,
  filterProjectTree,
  flattenProjectTree,
  projectTreeSections,
  type ProjectTreeNode,
  type ProjectTreeSection,
} from './projectTree.js'

export function bindProjectTree(
  container: HTMLElement,
  search: HTMLInputElement,
  onSelect: (node: ProjectTreeNode) => boolean,
  t: Translate,
  sections: readonly ProjectTreeSection[] = projectTreeSections,
) {
  const document = container.ownerDocument
  const expanded = new Set(['scenes', 'assets', 'maps'])
  const abort = new AbortController()
  let nodes: ProjectTreeNode[] = []
  let selected = 'game'
  let busy = false
  let rows: { node: ProjectTreeNode; element: HTMLElement; parent: string | undefined }[] = []
  let focused = 'game'

  const render = () => {
    rows = []
    container.replaceChildren()
    container.setAttribute('aria-label', t('tree.heading'))
    container.setAttribute('aria-busy', String(busy))
    search.placeholder = t('tree.search')
    search.setAttribute('aria-label', t('tree.search'))
    const filtered = filterProjectTree(nodes, search.value)

    const append = (
      parent: HTMLElement,
      entries: ProjectTreeNode[],
      level: number,
      parentKey?: string,
    ) => {
      for (const [index, node] of entries.entries()) {
        const row = document.createElement('div')
        const branch = Boolean(node.children?.length)
        const open = branch && (Boolean(search.value.trim()) || expanded.has(node.key))
        row.className = 'project-tree-row'
        row.setAttribute('role', 'treeitem')
        row.setAttribute('aria-level', String(level))
        row.setAttribute('aria-posinset', String(index + 1))
        row.setAttribute('aria-setsize', String(entries.length))
        row.setAttribute('aria-selected', String(selected === node.key))
        row.setAttribute('aria-disabled', String(busy))
        row.tabIndex = -1
        row.dataset.treeKey = node.key
        row.style.setProperty('--tree-depth', String(level - 1))
        row.title = node.id ?? node.label

        if (branch) row.setAttribute('aria-expanded', String(open))
        const toggle = document.createElement('span')
        toggle.className = 'tree-toggle'
        toggle.textContent = branch ? (open ? '▾' : '▸') : '·'
        toggle.setAttribute('aria-hidden', 'true')
        toggle.addEventListener('click', (event) => {
          event.stopPropagation()

          if (branch) {
            changeExpanded(node.key)
            focus(node.key)
          }
        })
        const label = document.createElement('span')
        label.className = 'tree-label'
        label.textContent = node.label
        label.title = node.label
        row.append(toggle, label)

        if (node.detail) {
          const detail = document.createElement('small')
          detail.textContent = node.detail
          detail.title = node.detail
          row.append(detail)
        }

        row.addEventListener('focus', () => {
          focused = node.key
          updateTabStops()
        })
        row.addEventListener('click', (event) => {
          event.stopPropagation()
          focus(node.key)
          select(node)
        })
        rows.push({ node, element: row, parent: parentKey })
        parent.append(row)

        if (open) {
          const group = document.createElement('div')
          group.setAttribute('role', 'group')
          row.append(group)
          append(group, node.children ?? [], level + 1, node.key)
        }
      }
    }

    append(container, filtered, 1)

    if (!rows.length) {
      const empty = document.createElement('p')
      empty.className = 'help'
      empty.textContent = nodes.length ? t('tree.noResults') : t('tree.empty')
      container.append(empty)
    }

    if (!rows.some((row) => row.node.key === focused))
      focused = rows.find((row) => row.node.key === selected)?.node.key ?? rows[0]?.node.key ?? ''
    updateTabStops()
  }

  const updateTabStops = () => {
    for (const row of rows) row.element.tabIndex = row.node.key === focused ? 0 : -1
  }

  const focus = (key: string) => {
    focused = key
    updateTabStops()
    rows.find((row) => row.node.key === key)?.element.focus()
  }

  const changeExpanded = (key: string) => {
    if (expanded.has(key)) expanded.delete(key)
    else expanded.add(key)
    render()
  }

  const select = (node: ProjectTreeNode) => {
    if (busy || !onSelect(node)) return
    selected = node.key

    for (const row of rows)
      row.element.setAttribute('aria-selected', String(row.node.key === selected))
  }

  search.addEventListener('input', render, { signal: abort.signal })
  container.addEventListener(
    'keydown',
    (event) => {
      const index = rows.findIndex((row) => row.node.key === focused)
      const row = rows[index]

      if (!row) return

      switch (event.key) {
        case 'ArrowDown':
          focus(rows[Math.min(index + 1, rows.length - 1)]!.node.key)
          break
        case 'ArrowUp':
          focus(rows[Math.max(index - 1, 0)]!.node.key)
          break
        case 'Home':
          focus(rows[0]!.node.key)
          break
        case 'End':
          focus(rows.at(-1)!.node.key)
          break
        case 'ArrowRight':
          if (row.node.children?.length) {
            if (row.element.getAttribute('aria-expanded') !== 'true') {
              expanded.add(focused)
              render()
              focus(focused)
            } else if (rows[index + 1]) focus(rows[index + 1]!.node.key)
          }

          break
        case 'ArrowLeft':
          if (expanded.has(focused) && !search.value.trim()) {
            expanded.delete(focused)
            render()
            focus(focused)
          } else if (row.parent) focus(row.parent)
          break
        case 'Enter':
        case ' ':
          select(row.node)
          break
        default:
          return
      }

      event.preventDefault()
      event.stopPropagation()
    },
    { signal: abort.signal },
  )

  return {
    select(key: string) {
      const node = flattenProjectTree(nodes).find((node) => node.key === key)

      if (node) {
        select(node)

        const reveal = (entries: ProjectTreeNode[]): boolean =>
          entries.some((entry) => {
            if (entry.key === selected) return true

            if (reveal(entry.children ?? [])) {
              expanded.add(entry.key)

              return true
            }

            return false
          })

        reveal(nodes)
        render()
      }
    },
    render(view: ProjectView | undefined, working: boolean, selection = selected) {
      selected = selection
      busy = working
      nodes = view ? buildProjectTree(view, t, sections) : []
      const all = flattenProjectTree(nodes)

      if (!all.some((node) => node.key === selected)) {
        const fallback = all.find((node) => node.key === 'game')

        if (fallback && !busy && onSelect(fallback)) selected = fallback.key
      }

      const active = document.activeElement
      const restoreFocus = container.contains(active)
      render()

      if (restoreFocus) focus(focused)
    },
    dispose() {
      abort.abort()
      container.replaceChildren()
    },
  }
}
