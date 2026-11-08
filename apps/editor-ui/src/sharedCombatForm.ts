import { resolveCombatSource, type CombatSource } from '@ancadeba/schemas'
import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import { ruleFormControls, type RuleFormControls } from './ruleFormControls.js'

const kindNames = { moves: ['move', 'moves'], statuses: ['status', 'statuses'] } as const

/** Lists shared library entries once each, with import, removal and local-copy actions. */
export function sharedCombatForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: CombatSource,
  render: () => void,
  openLibrary: (id: string) => void,
  copy: (command: EditorCommand) => void,
): HTMLElement {
  const { group, select, button, create } = controls
  const copyControls = ruleFormControls(create('div').ownerDocument, () => {})
  const libraries = new Map(Object.entries(view.combatLibraries ?? {}))
  const resolved = resolveCombatSource(draft, libraries, undefined, view.inventory)
  const usedLibraries = new Set<string>()
  const rows: HTMLElement[] = []

  for (const kind of ['moves', 'statuses'] as const) {
    const [single, plural] = kindNames[kind]
    const key = kind === 'moves' ? 'sharedMoves' : 'sharedStatuses'
    const refs = draft[key] ?? []

    const imported = (library: string, id: string) =>
      refs.some((ref) => ref.library === library && ref.id === id)

    const choices = [...libraries].flatMap(([library, data]) =>
      Object.keys(data[kind])
        .filter((id) => !imported(library, id))
        .map((id) => `${library}/${id}`),
    )

    let choice = choices[0] ?? ''
    const list = create('ul')
    list.className = 'shared-entries'

    for (const [id, origin] of Object.entries(resolved.origins[kind])) {
      if (!origin.library) continue
      const library = origin.library
      usedLibraries.add(library)
      const entry = libraries.get(library)?.[kind][id]
      const index = refs.findIndex((ref) => ref.library === library && ref.id === id)
      let localId = `${id}-local`

      const name = (entry?.labelKey && view.translations?.[entry.labelKey]) || entry?.label || id

      const text =
        (entry?.descriptionKey && view.translations?.[entry.descriptionKey]) ||
        entry?.description ||
        ''

      const title = create('strong')
      title.textContent = name
      const source = create('small')
      source.textContent = `${library}/${id}${index < 0 ? ' · automatic ability dependency' : ''}`
      const description = create('p')
      description.className = 'help'
      description.textContent = text
      const local = create('details')
      const summary = create('summary')
      summary.textContent = 'Make a local copy'
      local.append(
        summary,
        copyControls.input(`Local copy ID for ${single} ${id}`, localId, (value) => {
          localId = value.trim()
        }),
        button(`Make local copy of ${single} ${id}`, () =>
          copy({
            type: 'combat.copySharedEntry',
            encounterId: draft.id,
            kind,
            reference: { library, id },
            localId,
          }),
        ),
      )
      const item = create('li')
      item.append(title, source, ...(text ? [description] : []))

      if (index >= 0)
        item.append(
          button(`Remove shared ${single} ${id}`, () => {
            draft[key]?.splice(index, 1)
            controls.markEdited()
            render()
          }),
        )
      item.append(local)
      list.append(item)
    }

    // Imports that do not resolve (missing or overridden locally) stay removable.
    for (const [index, ref] of refs.entries()) {
      if (resolved.origins[kind][ref.id]?.library === ref.library) continue
      const item = create('li')
      const title = create('strong')
      title.textContent = `${ref.library}/${ref.id}`
      const source = create('small')
      source.textContent = 'Not used: missing from the library or replaced by a local entry'
      item.append(
        title,
        source,
        button(`Remove shared ${single} ${ref.id}`, () => {
          draft[key]?.splice(index, 1)
          controls.markEdited()
          render()
        }),
      )
      list.append(item)
    }

    const empty = create('p')
    empty.className = 'help'
    empty.textContent = `No shared ${plural} are used.`

    // Long shared lists stay folded so the encounter's own fields remain within reach.
    const folded = create('details')
    const count = create('summary')
    const total = list.children.length
    count.textContent = `${total} shared ${total === 1 ? single : plural} in use`
    folded.append(count, list)

    rows.push(
      group(
        `Shared ${plural}`,
        total ? folded : empty,
        select(
          `Shared ${kind} to import`,
          choice,
          choices,
          (value) => {
            choice = value
          },
          false,
        ),
        button(
          `Import shared ${kind}`,
          () => {
            if (!choice) return
            const [library, id] = choice.split('/')

            if (!library || !id) return
            ;(draft[key] ??= []).push({ library, id })
            controls.markEdited()
            render()
          },
          !choices.length,
        ),
      ),
    )
  }

  if (usedLibraries.size) {
    const help = create('p')
    help.className = 'help'
    help.textContent = 'Shared entries are read-only here. Change them in their library.'
    rows.push(
      help,
      ...[...usedLibraries].map((library) =>
        button(`Edit library ${library}`, () => openLibrary(library)),
      ),
    )
  }

  if (resolved.issues.length) {
    const errors = create('p')
    errors.setAttribute('role', 'alert')
    errors.textContent = resolved.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    rows.push(errors)
  }

  return group('Shared combat definitions', ...rows)
}
