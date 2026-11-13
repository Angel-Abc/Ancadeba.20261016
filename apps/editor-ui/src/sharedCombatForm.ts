import { resolveCombatSource, type CombatSource } from '@ancadeba/schemas'
import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import { ruleFormControls, type RuleFormControls } from './ruleFormControls.js'

/** Lists shared library entries once each, with import, removal and local-copy actions. */
export function sharedCombatForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: CombatSource,
  render: () => void,
  openLibrary: (id: string) => void,
  copy: (command: EditorCommand) => void,
): HTMLElement {
  const { group, select, button, create, t } = controls
  const copyControls = ruleFormControls(create('div').ownerDocument, () => {}, t)
  const libraries = new Map(Object.entries(view.combatLibraries ?? {}))
  const resolved = resolveCombatSource(draft, libraries, undefined, view.inventory)
  const usedLibraries = new Set<string>()

  for (const enemy of draft.enemies) if (enemy.aiProfile) usedLibraries.add(enemy.aiProfile.library)
  const rows: HTMLElement[] = []

  for (const kind of ['moves', 'statuses'] as const) {
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
      source.textContent = `${library}/${id}${index < 0 ? t(origin.ruleset ? 'combat.rulesets.dependency' : 'combat.shared.dependency') : ''}`
      const description = create('p')
      description.className = 'help'
      description.textContent = text
      const local = create('details')
      const summary = create('summary')
      summary.textContent = t('combat.shared.localCopy')
      local.append(
        summary,
        copyControls.input(t(`combat.shared.localCopyId.${kind}`, { id }), localId, (value) => {
          localId = value.trim()
        }),
        button(t(`combat.shared.makeLocalCopy.${kind}`, { id }), () =>
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
          button(t(`combat.shared.remove.${kind}`, { id }), () => {
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
      source.textContent = t('combat.shared.unused')
      item.append(
        title,
        source,
        button(t(`combat.shared.remove.${kind}`, { id: ref.id }), () => {
          draft[key]?.splice(index, 1)
          controls.markEdited()
          render()
        }),
      )
      list.append(item)
    }

    const empty = create('p')
    empty.className = 'help'
    empty.textContent = t(`combat.shared.none.${kind}`)

    // Long shared lists stay folded so the encounter's own fields remain within reach.
    const folded = create('details')
    const count = create('summary')
    const total = list.children.length
    count.textContent = t(`combat.shared.${total === 1 ? 'inUseOne' : 'inUse'}.${kind}`, {
      count: total,
    })
    folded.append(count, list)

    rows.push(
      group(
        t(`combat.shared.title.${kind}`),
        total ? folded : empty,
        select(
          t(`combat.shared.toImport.${kind}`),
          choice,
          choices,
          (value) => {
            choice = value
          },
          false,
        ),
        button(
          t(`combat.shared.import.${kind}`),
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
    help.textContent = t('combat.shared.readOnly')
    rows.push(
      help,
      ...[...usedLibraries].map((library) =>
        button(t('combat.shared.editLibrary', { library }), () => openLibrary(library)),
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

  return group(t('combat.shared.heading'), ...rows)
}
