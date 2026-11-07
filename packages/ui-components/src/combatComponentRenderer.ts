import {
  combatMoveValues,
  type SceneComponentData,
  type PlannedMove,
  type CombatSnapshot,
} from '@ancadeba/game-runtime'
import { StatusPanelComponentRenderer } from './statusPanelComponentRenderer.js'
import type {
  IComponentRenderer,
  ComponentRenderContext,
  RenderedComponent,
} from './componentRendering.js'

type CombatComponent = Extract<SceneComponentData, { type: 'combat' }>

/** Presents encounter snapshots; all combat controls route through the shared service. */
export class CombatComponentRenderer implements IComponentRenderer<CombatComponent> {
  constructor(private readonly statuses = new StatusPanelComponentRenderer()) {}
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
    root.append(heading, phase, actors, description, log)
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
        const target = document.createElement('button')
        target.type = 'button'
        target.textContent = `${definition.messages.target}: ${actor.label}`
        target.dataset.combatTarget = actor.id
        const select = () => combat.selectTarget(scene, component.id, actor.id)
        target.addEventListener('click', select)
        cleanups.push(() => target.removeEventListener('click', select))
        const plan = document.createElement('ol')
        plan.className = 'ancadeba-combat-plan'
        box.append(status.element, resources)

        if (actor.id !== definition.player.id) box.append(target)
        box.append(plan)
        actors.append(box)

        return { actor, resources, target, plan }
      })

      const moveText = (queued: PlannedMove, actor: string, snapshot: CombatSnapshot) => {
        const move = definition.moves[queued.move]!

        const target =
          [definition.player, ...definition.enemies].find((actor) => actor.id === queued.target)
            ?.label ?? queued.target

        let values

        try {
          values = combatMoveValues(
            move,
            snapshot.stats[actor],
            snapshot.stats[queued.target]?.defense ?? 0,
          )
        } catch {
          return definition.messages.unavailable
        }

        return `${move.label} · ${move.apCost} ${definition.messages.ap} · ${target} · ${move.type === 'attack' ? `${values.min}–${values.max}` : `${definition.messages.guard} +${values.guard}`}`
      }

      const update = () => {
        const snapshot = combat.snapshot(scene, component.id)

        if (!snapshot) return
        phase.textContent = `${definition.messages.round} ${snapshot.round} · ${snapshot.outcome ? definition.messages[snapshot.outcome] : definition.messages.planning}`

        for (const { actor, target, plan, resources } of views) {
          const queued =
            actor.id === definition.player.id
              ? snapshot.plan
              : (snapshot.enemyPlans[actor.id]?.moves ?? [])

          const remaining =
            actor.id === definition.player.id
              ? snapshot.remainingAp
              : actor.ap -
                queued.reduce((sum, move) => sum + definition.moves[move.move]!.apCost, 0)

          resources.textContent = `${definition.messages.ap} ${remaining}/${actor.ap} · ${definition.messages.guard} ${snapshot.guard[actor.id] ?? 0}`
          const focused = document.activeElement === target
          target.disabled = snapshot.phase !== 'planning' || !(snapshot.health[actor.id]! > 0)
          target.setAttribute('aria-pressed', String(snapshot.target === actor.id))

          if (focused && target.disabled) context.onActionBarFocusLost?.()
          const lines = queued.map((move) => moveText(move, actor.id, snapshot))

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
