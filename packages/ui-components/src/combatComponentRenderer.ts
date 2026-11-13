import {
  combatDamageProfile,
  combatTypedDamage,
  combatRestrictionProfile,
  combatStatusImmune,
  combatMoveRestriction,
  combatMoveRestrictionText,
  type CombatDamageProfile,
} from '@ancadeba/game-runtime'
import {
  combatValueContext,
  combatResourceCosts,
  combatActionCost,
  combatActorEconomy,
  statusContributions,
} from '@ancadeba/game-runtime'
import {
  combatMoveValues,
  combatAbilityEffectValues,
  combatStunned,
  combatStatusParts,
  combatStatusAmount,
  scaledCombatModifiers,
  type SceneComponentData,
  type PlannedMove,
  type CombatSnapshot,
} from '@ancadeba/game-runtime'
import { temporaryModifierNames } from '@ancadeba/schemas'
import { StatusPanelComponentRenderer } from './statusPanelComponentRenderer.js'
import { renderStatusEffect } from './statusEffectRenderer.js'
import { GraphicComponentRenderer } from './graphicComponentRenderer.js'
import type {
  IComponentRenderer,
  ComponentRenderContext,
  RenderedComponent,
} from './componentRendering.js'

type CombatComponent = Extract<SceneComponentData, { type: 'combat' }>

/** Presents encounter snapshots; all combat controls route through the shared service. */
export class CombatComponentRenderer implements IComponentRenderer<CombatComponent> {
  constructor(
    private readonly statuses = new StatusPanelComponentRenderer(),
    private readonly graphics = new GraphicComponentRenderer(),
  ) {}
  render(component: CombatComponent, context: ComponentRenderContext): RenderedComponent {
    const { document, scene } = context
    const combat = scene?.type === 'game' ? scene.game.combat : undefined
    const definition = scene && combat?.definition(scene, component.id)
    const root = document.createElement('section')
    root.className = 'ancadeba-combat'

    if (!definition || !scene || !combat) {
      root.textContent = 'Combat unavailable'

      return { element: root, dispose: () => root.remove() }
    }

    const heading = document.createElement('h2')
    heading.textContent = definition.label
    const phase = document.createElement('p')
    phase.className = 'ancadeba-combat-phase'
    const actors = document.createElement('div')
    actors.className = 'ancadeba-combat-actors'
    const description = document.createElement('p')
    const log = document.createElement('div')
    log.className = 'ancadeba-combat-log'
    log.setAttribute('role', 'log')
    const objectives = document.createElement('div')
    objectives.className = 'ancadeba-combat-resources'
    const phaseDescription = document.createElement('p')
    root.append(heading, phase, phaseDescription, objectives, actors, description, log)

    const meters = Object.entries(definition.mechanics?.resources ?? {}).map(([id, resource]) => {
      const label = document.createElement('label')
      const text = document.createElement('span')
      const meter = document.createElement('meter')
      meter.min = 0
      meter.max = resource.maximum
      label.dataset.combatResource = id
      label.title = resource.description
      label.append(text, meter)
      objectives.append(label)

      return { id, resource, text, meter }
    })

    if (Object.values(definition.moves).some((move) => move.type === 'ability')) {
      const hint = document.createElement('p')
      hint.textContent = definition.messages.conditional
      root.append(hint)
    }

    if (definition.enemies.some((actor) => actor.ai)) {
      const hint = document.createElement('p')
      hint.textContent = definition.messages.enemyConditional
      root.append(hint)
    }

    const cleanups: (() => void)[] = []

    try {
      const views = [definition.player, ...definition.enemies].map((actor) => {
        const box = document.createElement('section')
        box.dataset.combatActor = actor.id

        const status = this.statuses.render(
          {
            id: actor.id,
            type: 'status-panel',
            placement: component.placement,
            label: actor.label,
            name: '',
            ...(actor.portrait ? { portrait: actor.portrait } : {}),
            rows: [
              {
                id: 'health',
                type: 'bar',
                label: definition.messages.health,
                value: actor.health,
                maximum: actor.equipmentOwner
                  ? { source: 'game.combatStats', path: [actor.equipmentOwner, 'maximumHealth'] }
                  : actor.maximumHealth,
              },
            ],
            effects: [],
          },
          context,
        )

        cleanups.push(() => status.dispose())
        const resources = document.createElement('p')
        const defenses = document.createElement('p')
        defenses.dataset.combatDamageDefenses = actor.id
        const restrictions = document.createElement('p')
        restrictions.dataset.combatRestrictions = actor.id
        const target = document.createElement('button')
        target.type = 'button'
        target.textContent = `${definition.messages.target}: ${actor.label}`
        target.dataset.combatTarget = actor.id
        const select = () => combat.selectTarget(scene, component.id, actor.id)
        target.addEventListener('click', select)
        cleanups.push(() => target.removeEventListener('click', select))
        const plan = document.createElement('ol')
        const activeEffects = document.createElement('div')
        activeEffects.className = 'ancadeba-status-effects'
        const effectViews = new Map<string, ReturnType<typeof renderStatusEffect>>()
        cleanups.push(() => {
          for (const effect of effectViews.values()) effect.dispose()
          effectViews.clear()
        })
        plan.className = 'ancadeba-combat-plan'
        box.append(status.element, resources, defenses, restrictions)

        if (actor.id !== definition.player.id) box.append(target)
        box.append(activeEffects, plan)
        actors.append(box)

        return {
          actor,
          resources,
          defenses,
          restrictions,
          target,
          plan,
          activeEffects,
          effectViews,
        }
      })

      const damageDefenseText = (profile: CombatDamageProfile) => {
        const types = new Set([
          ...Object.keys(profile.resistances),
          ...Object.keys(profile.vulnerabilities),
          ...profile.immunities,
        ])

        return [...types]
          .flatMap((type) => [
            ...(Object.hasOwn(profile.resistances, type) && profile.resistances[type]
              ? [
                  definition.messages.damageResistance
                    .replaceAll('{damageType}', type)
                    .replaceAll('{resistance}', String(profile.resistances[type])),
                ]
              : []),
            ...(Object.hasOwn(profile.vulnerabilities, type) && profile.vulnerabilities[type]
              ? [
                  definition.messages.damageVulnerability
                    .replaceAll('{damageType}', type)
                    .replaceAll('{vulnerability}', String(profile.vulnerabilities[type])),
                ]
              : []),
            ...(profile.immunities.includes(type)
              ? [definition.messages.damageImmunity.replaceAll('{damageType}', type)]
              : []),
          ])
          .join(' · ')
      }

      const damageText = (values: {
        min?: number
        max?: number
        damageType?: string
        immune?: boolean
      }) =>
        values.immune
          ? definition.messages.damageImmunity.replaceAll(
              '{damageType}',
              values.damageType ?? 'physical',
            )
          : values.damageType
            ? definition.messages.typedDamagePreview
                .replaceAll('{amount}', `${values.min}–${values.max}`)
                .replaceAll('{damageType}', values.damageType)
            : `${values.min}–${values.max}`

      const moveText = (queued: PlannedMove, actor: string, snapshot: CombatSnapshot) => {
        try {
          const move = definition.moves[queued.move]!
          const restriction = combatMoveRestriction(definition, actor, move, snapshot.statuses)

          if (restriction) return combatMoveRestrictionText(definition, actor, move, restriction)

          const valueContext = combatValueContext(
            definition,
            snapshot.resources,
            snapshot.statuses,
            actor,
            queued.target,
          )

          const contributions = statusContributions(definition, snapshot.statuses[actor] ?? [])

          const actorDefinition = [definition.player, ...definition.enemies].find(
            (entry) => entry.id === actor,
          )!

          const apCost = combatActionCost(
            move,
            combatActorEconomy(definition, actorDefinition, snapshot.statuses[actor]),
            valueContext,
          )

          const costs = Object.entries(combatResourceCosts(move, valueContext))
            .map(([resource, amount]) =>
              definition.messages.resourceCost
                .replaceAll(
                  '{resource}',
                  definition.mechanics?.resources[resource]?.label || resource,
                )
                .replaceAll('{amount}', String(amount)),
            )
            .join(' · ')

          const costText = costs ? ` · ${costs}` : ''

          const target =
            [definition.player, ...definition.enemies].find((actor) => actor.id === queued.target)
              ?.label ?? queued.target

          if (move.type === 'ability') {
            const effects = move.effects.map((effect) => {
              const recipient = effect.target === 'self' ? actor : queued.target

              const name =
                [definition.player, ...definition.enemies].find((a) => a.id === recipient)?.label ??
                recipient

              const values = combatAbilityEffectValues(
                effect,
                snapshot.stats[actor],
                snapshot.stats[recipient]?.defense ?? 0,
                valueContext,
                contributions,
                combatDamageProfile(definition, recipient, snapshot.statuses),
              )

              const status =
                effect.type === 'apply-status' || effect.type === 'remove-status'
                  ? definition.statuses?.[effect.status]
                  : undefined

              const text =
                effect.type === 'change-resource'
                  ? definition.messages.resourceEffect
                      .replaceAll(
                        '{resource}',
                        definition.mechanics?.resources[effect.resource]?.label || effect.resource,
                      )
                      .replaceAll('{amount}', `${effect.amount >= 0 ? '+' : ''}${effect.amount}`)
                  : effect.type === 'damage'
                    ? damageText(values)
                    : effect.type === 'heal'
                      ? definition.messages.healing.replaceAll('{amount}', String(values.amount))
                      : effect.type === 'guard'
                        ? `${definition.messages.guard} +${values.amount}`
                        : effect.type === 'apply-status'
                          ? combatStatusImmune(
                              definition,
                              recipient,
                              effect.status,
                              snapshot.statuses,
                            )
                            ? definition.messages.statusImmune
                                .replaceAll('{target}', name)
                                .replaceAll('{status}', status?.label ?? effect.status)
                            : `${status?.label} · ${definition.messages.turnsRemaining.replaceAll('{turns}', String(status?.duration))}`
                          : effect.type === 'remove-status' && effect.stacks !== undefined
                            ? definition.messages.removeStacks
                                .replaceAll('{stacks}', String(effect.stacks))
                                .replaceAll('{status}', status?.label ?? '')
                            : definition.messages.statusRemoved
                                .replaceAll('{target}', name)
                                .replaceAll('{status}', status?.label ?? '')

              return `${name}: ${text}${effect.conditions?.length ? ` (${definition.messages.conditionalEffect})` : ''}`
            })

            return `${move.label} · ${apCost} ${definition.messages.ap}${costText} · ${effects.join(' · ')}`
          }

          let values

          try {
            values = combatMoveValues(
              move,
              snapshot.stats[actor],
              snapshot.stats[queued.target]?.defense ?? 0,
              valueContext,
              contributions,
              combatDamageProfile(definition, queued.target, snapshot.statuses),
            )
          } catch {
            return definition.messages.unavailable
          }

          return `${move.label} · ${apCost} ${definition.messages.ap}${costText} · ${target} · ${move.type === 'attack' ? damageText(values) : `${definition.messages.guard} +${values.guard}`}`
        } catch {
          return definition.messages.unavailable
        }
      }

      const update = () => {
        const snapshot = combat.snapshot(scene, component.id)

        if (!snapshot) return
        phase.textContent = `${definition.messages.round} ${snapshot.round} · ${snapshot.outcome ? definition.messages[snapshot.outcome] : definition.messages.planning}`
        const bossPhase = definition.mechanics?.phases[snapshot.bossPhase ?? '']
        phaseDescription.textContent = bossPhase
          ? `${bossPhase.label || snapshot.bossPhase}${bossPhase.description ? ` · ${bossPhase.description}` : ''}`
          : ''
        phaseDescription.hidden = !bossPhase

        for (const { id, resource, text, meter } of meters) {
          const amount = snapshot.resources[id] ?? resource.initial

          const owner = [definition.player, ...definition.enemies].find(
            (actor) => actor.id === resource.actor,
          )

          const name = `${owner ? `${owner.label} · ` : ''}${resource.label || id}`
          text.textContent = `${name}: ${amount}/${resource.maximum} `
          meter.value = amount
          meter.setAttribute('aria-label', name)
        }

        for (const {
          actor,
          target,
          plan,
          resources,
          defenses,
          restrictions,
          activeEffects,
          effectViews,
        } of views) {
          const profile = combatDamageProfile(definition, actor.id, snapshot.statuses)
          defenses.textContent = damageDefenseText(profile)
          defenses.hidden = !defenses.textContent

          const restrictionProfile = combatRestrictionProfile(
            definition,
            actor.id,
            snapshot.statuses,
          )

          const immunityText = (ids: readonly string[]) =>
            definition.messages.statusImmunities.replaceAll(
              '{statuses}',
              ids.map((id) => definition.statuses?.[id]?.label ?? id).join(', '),
            )

          const blockedText = (ids: readonly string[]) =>
            definition.messages.blockedMoveCategories.replaceAll('{categories}', ids.join(', '))

          restrictions.textContent = [
            ...(restrictionProfile.statusImmunities.length
              ? [immunityText(restrictionProfile.statusImmunities)]
              : []),
            ...(restrictionProfile.blockedMoveCategories.length
              ? [blockedText(restrictionProfile.blockedMoveCategories)]
              : []),
          ].join(' · ')
          restrictions.hidden = !restrictions.textContent

          const queued =
            actor.id === definition.player.id
              ? snapshot.plan
              : (snapshot.enemyPlans[actor.id]?.moves ?? [])

          const remaining =
            actor.id === definition.player.id
              ? snapshot.remainingAp
              : Math.max(
                  0,
                  (snapshot.ap[actor.id] ?? actor.ap) -
                    queued.reduce(
                      (sum, move) =>
                        sum +
                        (snapshot.moveCosts[actor.id]?.[move.move] ??
                          definition.moves[move.move]!.apCost),
                      0,
                    ),
                )

          resources.textContent = `${definition.messages.ap} ${remaining}/${snapshot.ap[actor.id] ?? actor.ap} · ${definition.messages.guard} ${snapshot.guard[actor.id] ?? 0}`
          const focused = document.activeElement === target
          target.disabled = snapshot.phase !== 'planning' || !(snapshot.health[actor.id]! > 0)
          target.setAttribute('aria-pressed', String(snapshot.target === actor.id))

          if (focused && target.disabled) context.onActionBarFocusLost?.()
          const active = snapshot.statuses[actor.id] ?? []

          for (const [id, view] of effectViews)
            if (!active.some((s) => s.id === id)) {
              if (view.element.contains(document.activeElement)) context.onActionBarFocusLost?.()
              view.dispose()
              effectViews.delete(id)
            }

          for (const status of active) {
            const data = definition.statuses?.[status.id]

            if (!data) continue
            let view = effectViews.get(status.id)

            if (!view) {
              const icon = data.icon
                ? this.graphics.render(
                    {
                      id: status.id,
                      type: 'graphic',
                      visual: data.icon,
                      alt: '',
                      placement: component.placement,
                      fit: 'contain',
                      appearance: { visible: true, slots: {}, colors: {} },
                    },
                    context,
                  )
                : undefined

              icon?.element.classList.add('ancadeba-status-effect-icon')
              view = renderStatusEffect(
                { id: status.id, label: data.label, description: data.description },
                context,
                icon,
              )
              effectViews.set(status.id, view)
              activeEffects.append(view.element)
            }

            const names = {
              attack: definition.messages.statAttack,
              defense: definition.messages.statDefense,
              guard: definition.messages.statGuard,
              ap: definition.messages.statAp,
              apCost: definition.messages.statApCost,
              damage: definition.messages.statDamage,
              healing: definition.messages.statHealing,
            }

            const parts = combatStatusParts(data)
            const modifiers = parts.modifiers ? scaledCombatModifiers(parts.modifiers, status) : {}

            const magnitude = [
              ...(data.statusImmunities?.length ? [immunityText(data.statusImmunities)] : []),
              ...(data.blockedMoveCategories?.length
                ? [blockedText(data.blockedMoveCategories)]
                : []),
              ...(['damage', 'regeneration'] as const).flatMap((type) =>
                parts[type] === undefined
                  ? []
                  : [
                      (type === 'damage'
                        ? definition.messages.periodicDamage
                        : definition.messages.regenerated
                      )
                        .replaceAll('{target}', actor.label)
                        .replaceAll('{status}', data.label)
                        .replaceAll(
                          '{amount}',
                          String(
                            type === 'damage'
                              ? combatTypedDamage(
                                  combatStatusAmount(parts[type], status),
                                  parts.damageType,
                                  profile,
                                ).amount
                              : combatStatusAmount(parts[type], status),
                          ),
                        ),
                    ],
              ),
              ...temporaryModifierNames
                .filter((stat) => modifiers[stat])
                .map(
                  (stat) =>
                    `${names[stat]} ${(modifiers[stat] ?? 0) >= 0 ? '+' : ''}${modifiers[stat]}`,
                ),
              ...Object.entries(
                statusContributions(definition, [status])[0]?.percentModifiers ?? {},
              ).map(
                ([stat, value]) =>
                  `${Object.getOwnPropertyDescriptor(names, stat)?.value ?? stat} ${(value ?? 0) >= 0 ? '+' : ''}${value ?? 0}%`,
              ),
              ...(parts.stun
                ? [definition.messages.stunned.replaceAll('{actor}', actor.label)]
                : []),
            ].join(' · ')

            const strength =
              data.stacking || data.intensity
                ? definition.messages.statusStrength
                    .replaceAll('{stacks}', String(status.stacks ?? 1))
                    .replaceAll('{intensity}', String(status.intensity ?? 1))
                : ''

            view.setText(
              [data.label, strength, String(status.remaining)].filter(Boolean).join(' · '),
              [
                data.description,
                magnitude,
                definition.messages.turnsRemaining.replaceAll('{turns}', String(status.remaining)),
              ]
                .filter(Boolean)
                .join('\n'),
            )
          }

          const lines = combatStunned(definition, active)
            ? [definition.messages.stunned.replaceAll('{actor}', actor.label)]
            : queued.map((move) => moveText(move, actor.id, snapshot))

          if (actor.id === definition.player.id && snapshot.escape)
            lines.push(definition.messages.escape)

          if (!lines.length) lines.push(definition.messages.empty)
          plan.replaceChildren(
            ...lines.map((text) => {
              const row = document.createElement('li')
              row.textContent = text

              return row
            }),
          )
        }

        description.textContent =
          definition.enemies.find((actor) => actor.id === snapshot.target)?.description ??
          definition.description
        log.textContent = combat.text(scene, component.id)
      }

      update()
      cleanups.push(combat.subscribeChanges(update))

      return {
        element: root,
        dispose() {
          for (const cleanup of cleanups.reverse()) cleanup()
          root.remove()
        },
      }
    } catch (error) {
      for (const cleanup of cleanups.reverse()) cleanup()
      root.remove()
      throw error
    }
  }
}
