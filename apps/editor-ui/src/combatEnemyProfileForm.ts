import {
  resolveCombatEnemyAI,
  resolveCombatSource,
  cloneCombatRules,
  diffCombatAI,
  previewCombatAIOverrides,
  type CombatActorSource,
  type CombatSource,
  type CombatMechanicsDefinition,
} from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { combatEnemyAIForm } from './combatEnemyAIForm.js'
import { ruleFormControls, type RuleFormControls } from './ruleFormControls.js'

export function combatEnemyProfileForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: CombatSource,
  enemy: CombatActorSource,
  mechanics: CombatMechanicsDefinition | undefined,
  statuses: readonly string[],
  render: () => void,
): HTMLElement {
  const { group, select, button, create, t } = controls
  const text = (key: string) => t(`combat.aiProfiles.${key}`)
  const libraries = new Map(Object.entries(view.combatLibraries ?? {}))
  const actors = [draft.player, ...draft.enemies]
  const reference = enemy.aiProfile
  const resolved = resolveCombatEnemyAI(enemy, actors, libraries)
  const profile = reference && libraries.get(reference.library)?.aiProfiles?.[reference.id]

  const edit = (action: () => void) => () => {
    action()
    controls.markEdited()
    render()
  }

  const picker = select(
    text('select'),
    reference ? `${reference.library}/${reference.id}` : '',
    [
      ['', text('inline')],
      ...[...libraries].flatMap(([library, data]) =>
        Object.entries(data.aiProfiles ?? {}).map(
          ([id, profile]) =>
            [
              `${library}/${id}`,
              `${(profile.labelKey && view.translations?.[profile.labelKey]) || profile.label || id} (${library}/${id})`,
            ] as const,
        ),
      ),
    ],
    (value) => {
      if (!value) {
        const source = resolveCombatSource(draft, libraries, undefined, view.inventory)

        for (const kind of ['moves', 'statuses'] as const) {
          const key = kind === 'moves' ? 'sharedMoves' : 'sharedStatuses'

          for (const [id, origin] of Object.entries(source.origins[kind]))
            if (
              origin.library &&
              !draft[key]?.some((ref) => ref.library === origin.library && ref.id === id)
            )
              (draft[key] ??= []).push({ library: origin.library, id })
        }

        enemy.ai = resolved.ai ? cloneCombatRules(resolved.ai) : undefined
        enemy.aiProfile = null
        enemy.aiOverrides = undefined
      } else {
        const [library, id] = value.split('/')

        if (!library || !id) return
        const roles = libraries.get(library)?.aiProfiles?.[id]?.actors ?? []
        enemy.aiProfile = {
          library,
          id,
          actors: Object.fromEntries(
            roles.map((role, index) => [
              role,
              actors.find((actor) => actor.id === role)?.id ??
                actors.filter((actor) => actor.id !== enemy.id)[index]?.id ??
                draft.player.id,
            ]),
          ),
        }
        enemy.ai = undefined
        enemy.aiOverrides = {}
      }

      render()
    },
  )

  if (!reference)
    return group(
      text('encounter'),
      picker,
      combatEnemyAIForm(controls, enemy, actors, mechanics, statuses, render),
    )
  const help = create('p')
  help.textContent = text('inheritHelp')
  const alerts = create('p')
  alerts.setAttribute('role', 'alert')
  alerts.textContent = resolved.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n')

  const bindings = (profile?.actors ?? []).map((role) =>
    select(
      t('combat.aiProfiles.bindActor', { role }),
      reference.actors?.[role] ?? role,
      actors.map((actor) => [actor.id, actor.label || actor.id] as const),
      (value) => {
        reference.actors = { ...reference.actors, [role]: value }
        render()
      },
    ),
  )

  const reset = button(
    text('resetAll'),
    edit(() => {
      enemy.aiOverrides = {}
    }),
  )

  if (!resolved.base) return group(text('encounter'), picker, help, ...bindings, alerts, reset)
  const base = resolved.base

  const editable = {
    ...enemy,
    ai: cloneCombatRules(resolved.ai ?? previewCombatAIOverrides(base, enemy.aiOverrides)),
  }

  const sync = () => {
    enemy.aiOverrides = diffCombatAI(base, editable.ai)
  }

  const local = ruleFormControls(
    create('div').ownerDocument,
    () => {
      sync()
      controls.markEdited()
    },
    t,
  )

  const localRender = () => {
    sync()
    render()
  }

  const rows = create('ul')

  for (const id of new Set([
    ...base.rules.map((rule) => rule.id),
    ...Object.keys(enemy.aiOverrides?.rules ?? {}),
  ])) {
    const row = create('li')
    const patch = enemy.aiOverrides?.rules?.[id]
    const label = create('span')
    label.textContent = `${id}: ${patch === null ? text('excluded') : patch ? text('overridden') : text('inherited')} `
    row.append(label)
    row.append(
      patch !== undefined
        ? button(
            t('combat.aiProfiles.resetRule', { id }),
            edit(() => {
              delete enemy.aiOverrides?.rules?.[id]
            }),
          )
        : button(
            t('combat.aiProfiles.excludeRule', { id }),
            edit(() => {
              enemy.aiOverrides ??= {}
              ;(enemy.aiOverrides.rules ??= {})[id] = null

              if (enemy.aiOverrides.ruleOrder)
                enemy.aiOverrides.ruleOrder = enemy.aiOverrides.ruleOrder.filter(
                  (entry) => entry !== id,
                )
            }),
          ),
    )
    rows.append(row)
  }

  const settings = (['fallback', 'ruleOrder'] as const)
    .filter((key) => enemy.aiOverrides?.[key] !== undefined)
    .map((key) =>
      button(
        t('combat.aiProfiles.resetSetting', { setting: key }),
        edit(() => {
          delete enemy.aiOverrides?.[key]
        }),
      ),
    )

  return group(
    text('encounter'),
    picker,
    help,
    ...bindings,
    alerts,
    rows,
    ...settings,
    reset,
    combatEnemyAIForm(local, editable, actors, mechanics, statuses, localRender, {
      allowRemoval: false,
    }),
  )
}
