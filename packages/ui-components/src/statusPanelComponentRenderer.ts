import { resolveStatusValue, statusBarFill } from '@ancadeba/game-runtime'
import type { StatusPanelComponentDefinition } from '@ancadeba/schemas'
import { GraphicComponentRenderer } from './graphicComponentRenderer.js'
import { renderStatusEffect } from './statusEffectRenderer.js'
import type {
  ComponentRenderContext,
  IComponentRenderer,
  RenderedComponent,
} from './componentRendering.js'

/** Presents bound status values; game rules remain responsible for changing them. */
export class StatusPanelComponentRenderer implements IComponentRenderer<StatusPanelComponentDefinition> {
  constructor(private readonly graphics = new GraphicComponentRenderer()) {}

  render(
    component: StatusPanelComponentDefinition,
    context: ComponentRenderContext,
  ): RenderedComponent {
    const { document, bindings } = context
    const root = document.createElement('section')
    root.className = 'ancadeba-status-panel'
    root.setAttribute('aria-label', component.label)
    const title = document.createElement('h2')
    title.textContent = component.label
    root.append(title)
    const cleanups: (() => void)[] = []
    let active = true

    const graphic = (visual: string, alt = '') =>
      this.graphics.render(
        {
          id: visual,
          type: 'graphic',
          placement: component.placement,
          visual,
          alt,
          fit: 'contain',
          appearance: { colors: {}, slots: {}, visible: true },
        },
        { ...context, bindings: undefined },
      )

    try {
      if (component.portrait) {
        const portrait = graphic(component.portrait, component.name || component.label)
        portrait.element.classList.add('ancadeba-status-portrait')
        root.append(portrait.element)
        cleanups.push(() => portrait.dispose())
      }

      if (component.name) {
        const name = document.createElement('p')
        name.className = 'ancadeba-status-name'
        name.textContent = component.name
        root.append(name)
      }

      const rows = component.rows.map((row) => {
        const element = document.createElement('div')
        element.className = `ancadeba-status-row ancadeba-status-row--${row.type}`
        element.dataset.statusRow = row.id
        const line = document.createElement('div')
        line.className = 'ancadeba-status-row-label'
        const label = document.createElement('span')
        label.textContent = `${row.label} `
        const value = document.createElement('span')
        value.className = 'ancadeba-status-value'
        line.append(label, value)
        element.append(line)
        const meter = document.createElement('div')
        const fill = document.createElement('div')
        const unavailable = document.createElement('div')

        if (row.type === 'bar') {
          meter.className = 'ancadeba-status-meter'
          meter.setAttribute('role', 'meter')
          meter.setAttribute('aria-label', row.label)
          fill.className = 'ancadeba-status-fill'
          unavailable.className = 'ancadeba-status-meter ancadeba-status-meter--unavailable'
          unavailable.setAttribute('aria-hidden', 'true')

          if (row.color) meter.style.setProperty('--ge-status-color', row.color)
          meter.append(fill)
          element.append(meter, unavailable)
        }

        root.append(element)

        return { row, value, meter, fill, unavailable }
      })

      const effects = component.effects.map((effect) => {
        const icon = effect.icon ? graphic(effect.icon) : undefined
        icon?.element.classList.add('ancadeba-status-effect-icon')
        const rendered = renderStatusEffect(effect, context, icon)
        root.append(rendered.element)
        cleanups.push(() => rendered.dispose())

        return { effect, rendered }
      })

      const update = () => {
        if (!active) return
        const issues: string[] = []

        for (const { row, value, meter, fill, unavailable } of rows) {
          const current = resolveStatusValue(row.value, bindings, row.type === 'bar')

          if (current.issue) issues.push(`${row.id}: ${current.issue}`)

          if (row.type === 'value') {
            value.textContent = String(current.value ?? '—')
            continue
          }

          const maximum = resolveStatusValue(row.maximum, bindings, true)

          if (maximum.issue) issues.push(`${row.id} maximum: ${maximum.issue}`)
          const percentage = statusBarFill(current.value, maximum.value)

          if (percentage === undefined && !current.issue && !maximum.issue)
            issues.push(`${row.id}: Maximum must be greater than zero`)
          value.textContent = `${current.value ?? '—'} / ${maximum.value ?? '—'}`
          meter.hidden = percentage === undefined
          unavailable.hidden = percentage !== undefined

          if (
            percentage !== undefined &&
            typeof maximum.value === 'number' &&
            typeof current.value === 'number'
          ) {
            meter.setAttribute('aria-valuemin', '0')
            meter.setAttribute('aria-valuemax', String(maximum.value))
            meter.setAttribute(
              'aria-valuenow',
              String(Math.max(0, Math.min(maximum.value, current.value))),
            )
            meter.setAttribute('aria-valuetext', `${row.label} ${value.textContent}`)
            fill.style.setProperty('--ge-status-fill', `${percentage}%`)
          }
        }

        for (const { effect, rendered } of effects) {
          const result = effect.visibleWhen && bindings?.read(effect.visibleWhen)

          if (
            effect.visibleWhen &&
            (!result || result.status !== 'resolved' || typeof result.value !== 'boolean')
          )
            issues.push(`${effect.id}: Expected a resolved boolean visibility binding`)
          rendered.setVisible(
            !effect.visibleWhen || (result?.status === 'resolved' && result.value === true),
          )
        }

        root.dataset.bindingStatus = issues.length ? 'unresolved' : 'resolved'

        if (context.bindingMode === 'editor') root.title = issues.join('\n')
      }

      update()
      const unsubscribe = bindings?.subscribeChanges(update)

      if (unsubscribe) cleanups.push(unsubscribe)
    } catch (error) {
      for (const cleanup of cleanups.reverse()) cleanup()
      root.remove()
      throw error
    }

    return {
      element: root,
      dispose() {
        if (!active) return
        active = false

        for (const cleanup of cleanups.reverse()) cleanup()
        root.remove()
      },
    }
  }
}
