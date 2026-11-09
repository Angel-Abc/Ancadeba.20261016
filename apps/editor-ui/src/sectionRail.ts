import type { Translate } from '@ancadeba/utilities'
import type { ProjectTreeSection } from './projectTree.js'

const svgNamespace = 'http://www.w3.org/2000/svg'

/** Outline icon paths on a 24-unit grid, keyed by tree section. */
const sectionIcons = new Map([
  ['maps', 'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16M15 5v16'],
  ['game', 'M4 7h16M4 12h16M4 17h10'],
  ['scenes', 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5'],
  ['assets', 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5'],
  ['rules', 'M13 3L5 14h6l-1 7 8-11h-6z'],
  [
    'controls',
    'M6 9h12a3 3 0 0 1 3 3v2a3 3 0 0 1-5 2l-1-1H9l-1 1a3 3 0 0 1-5-2v-2a3 3 0 0 1 3-3zM8 11v3M6.5 12.5h3M15 12h.01M17 13.5h.01',
  ],
  ['status', 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z'],
  ['items', 'M5 8h14v12H5zM9 8V5h6v3M5 13h14'],
  ['shops', 'M4 9l1.5-5h13L20 9M4 9h16v11H4zM9 20v-6h6v6'],
  ['combat', 'M14 4h6v6L9 21l-3-3zM5 15l4 4M3 21l3-3'],
  ['data', 'M6 3h9l3 3v15H6zM15 3v3h3M9 11h6M9 15h6'],
  ['localization', 'M3 5h12M9 3v2M5 5c0 7 8 11 8 11M13 5c0 7-8 11-8 11M14 21l4-10 4 10M16 17h4'],
])

const fallbackIcon = 'M5 5h14v14H5zM9 12h6'

/** Section shortcuts beside the explorer; selection itself stays with the project tree. */
export function bindSectionRail(
  container: HTMLElement,
  sections: readonly ProjectTreeSection[],
  t: Translate,
  onSelect: (sectionId: string) => void,
) {
  const document = container.ownerDocument
  const abort = new AbortController()

  const entries = sections.map((section) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.section = section.id
    const icon = document.createElementNS(svgNamespace, 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '1.7')
    icon.setAttribute('stroke-linecap', 'round')
    icon.setAttribute('stroke-linejoin', 'round')
    icon.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(svgNamespace, 'path')
    path.setAttribute('d', sectionIcons.get(section.id) ?? fallbackIcon)
    icon.append(path)
    const label = document.createElement('span')
    button.append(icon, label)
    button.addEventListener('click', () => onSelect(section.id), { signal: abort.signal })

    return { section, button, label }
  })

  container.replaceChildren(...entries.map(({ button }) => button))

  return {
    render(activeSection: string | undefined) {
      container.hidden = activeSection === undefined

      for (const { section, button, label } of entries) {
        const name = t(section.labelKey)
        const shortKey = `rail.${section.id}`
        const short = t(shortKey)
        label.textContent = short === shortKey ? name : short
        button.title = name
        button.setAttribute('aria-label', name)
        button.setAttribute('aria-current', String(section.id === activeSection))
      }
    },
    dispose() {
      abort.abort()
      container.replaceChildren()
    },
  }
}
