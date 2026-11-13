import type { CombatSource, CombatLibrary, CombatRulesetLayer } from '@ancadeba/schemas'
import type { RuleFormControls } from './ruleFormControls.js'

/** Ordered references remain authored separately from the resolved encounter mechanics. */
export function combatRulesetLayersForm(
  controls: RuleFormControls,
  draft: CombatSource,
  libraries: ReadonlyMap<string, CombatLibrary>,
  choices: readonly (readonly [string, string])[],
  render: () => void,
  detach: () => void,
  canDetach: boolean,
): HTMLElement {
  const { group, select, button, create, t } = controls
  const text = (key: string) => t(`combat.composition.${key}`)
  const layers = draft.rulesets ?? []

  const edit = (action: () => void) => () => {
    action()
    controls.markEdited()
    render()
  }

  const actors = [draft.player, ...draft.enemies]

  const reference = (value: string): CombatRulesetLayer => {
    const [library = '', id = ''] = value.split('/')
    const roles = libraries.get(library)?.rulesets?.[id]?.actors ?? []

    return {
      library,
      id,
      actors: Object.fromEntries(
        roles.map((role, index) => [
          role,
          actors.find((actor) => actor.id === role)?.id ?? actors[index]?.id ?? role,
        ]),
      ),
    }
  }

  const available = choices.filter(
    ([identity]) => !layers.some((layer) => `${layer.library}/${layer.id}` === identity),
  )

  let addition = available[0]?.[0] ?? ''
  const help = create('p')
  help.textContent = text('help')

  return group(
    text('heading'),
    help,
    ...layers.map((layer, index) =>
      group(
        t('combat.composition.layer', { number: index + 1 }),
        select(
          text('ruleset'),
          `${layer.library}/${layer.id}`,
          choices.filter(
            ([identity]) =>
              !layers.some(
                (entry, position) =>
                  position !== index && `${entry.library}/${entry.id}` === identity,
              ),
          ),
          (value) => {
            layers[index] = {
              ...reference(value),
              ...(layer.collision ? { collision: layer.collision } : {}),
            }
            render()
          },
        ),
        ...(libraries.get(layer.library)?.rulesets?.[layer.id]?.actors ?? []).map((role) =>
          select(
            t('combat.rulesets.bindActor', { role }),
            layer.actors?.[role] ?? role,
            actors.map((actor) => [actor.id, actor.label || actor.id] as const),
            (value) => {
              layer.actors = { ...layer.actors, [role]: value }
              render()
            },
          ),
        ),
        select(
          text('collision'),
          layer.collision ?? 'error',
          [
            ['error', text('error')],
            ['replace', text('replace')],
          ],
          (value) => {
            layer.collision = value === 'error' ? undefined : value
            render()
          },
        ),
        button(
          text('up'),
          edit(() => {
            if (index) [layers[index - 1], layers[index]] = [layers[index]!, layers[index - 1]!]
          }),
          index === 0,
        ),
        button(
          text('down'),
          edit(() => {
            if (index < layers.length - 1)
              [layers[index], layers[index + 1]] = [layers[index + 1]!, layers[index]!]
          }),
          index === layers.length - 1,
        ),
        button(
          text('remove'),
          edit(() => {
            if (layers.length === 1) detach()
            else layers.splice(index, 1)
          }),
          layers.length === 1 && !canDetach,
        ),
      ),
    ),
    select(text('addChoice'), addition, available, (value) => {
      addition = value
    }),
    button(
      text('add'),
      edit(() => {
        if (!addition) return

        if (!layers.length) {
          draft.mechanics = undefined
          draft.mechanicsOverrides = {}
        }

        ;(draft.rulesets ??= []).push(reference(addition))
      }),
      !addition || layers.length >= 16,
    ),
    button(text('detach'), edit(detach), !canDetach),
  )
}
