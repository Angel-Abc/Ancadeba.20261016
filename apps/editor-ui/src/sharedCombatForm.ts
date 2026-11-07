import { resolveCombatSource, type CombatSource } from '@ancadeba/schemas'
import type { EditorCommand, ProjectView } from '@ancadeba/editor-core'
import { ruleFormControls, type RuleFormControls } from './ruleFormControls.js'

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
  const resolved = resolveCombatSource(draft, libraries)
  const rows: HTMLElement[] = []

  for (const kind of ['moves', 'statuses'] as const) {
    const key = kind === 'moves' ? 'sharedMoves' : 'sharedStatuses'
    const refs = draft[key] ?? []

    const choices = [...libraries].flatMap(([library, data]) =>
      Object.keys(data[kind]).map((id) => `${library}/${id}`),
    )

    let choice = choices[0] ?? ''
    rows.push(
      select(
        `Shared ${kind} to import`,
        choice,
        choices,
        (value) => {
          choice = value
        },
        false,
      ),
    )
    rows.push(
      button(`Import shared ${kind}`, () => {
        if (!choice) return
        const [library, id] = choice.split('/')

        if (!library || !id) return
        ;(draft[key] ??= []).push({ library, id })
        controls.markEdited()
        render()
      }),
    )

    for (const [index, ref] of refs.entries()) {
      const entry = libraries.get(ref.library)?.[kind][ref.id]
      const description = create('p')

      const name =
        (entry?.labelKey && view.translations?.[entry.labelKey]) || entry?.label || ref.id

      const text =
        (entry?.descriptionKey && view.translations?.[entry.descriptionKey]) ||
        entry?.description ||
        ''

      description.textContent = `${name}: ${text} (read-only; combat-libraries/${ref.library}.json)`
      rows.push(
        group(
          `Shared ${kind}: ${ref.library}/${ref.id}`,
          description,
          button(`Edit library ${ref.library}`, () => openLibrary(ref.library)),
          button(`Remove import ${kind} ${ref.id}`, () => {
            draft[key]?.splice(index, 1)
            controls.markEdited()
            render()
          }),
        ),
      )
    }

    for (const [id, origin] of Object.entries(resolved.origins[kind])) {
      if (!origin.library) continue
      const library = origin.library
      let localId = `${id}-local`
      const summary = create('p')
      summary.textContent = `${kind}: ${id} from ${library}${kind === 'statuses' && !refs.some((ref) => ref.library === library && ref.id === id) ? ' (automatic ability dependency)' : ''}`
      rows.push(
        group(
          `Resolved shared ${kind}: ${id}`,
          summary,
          copyControls.input(`Local copy ID for ${kind} ${id}`, localId, (value) => {
            localId = value.trim()
          }),
          button(`Make local copy of ${kind} ${id}`, () =>
            copy({
              type: 'combat.copySharedEntry',
              encounterId: draft.id,
              kind,
              reference: { library, id },
              localId,
            }),
          ),
        ),
      )
    }
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
