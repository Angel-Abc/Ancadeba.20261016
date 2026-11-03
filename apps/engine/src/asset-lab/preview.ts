import {
  graphicAppearanceSchema,
  graphicComponentSchema,
  type AssetCatalog,
} from '@ancadeba/schemas'
import {
  GraphicComponentRenderer,
  type IGraphicResources,
  type RenderedGraphic,
} from '@ancadeba/ui-components'
import type { Appearance } from './appearance'

export interface PreviewTargets {
  character: HTMLElement
  tunic: HTMLElement
  sword: HTMLElement
}

/** The workshop is a consumer of the supported catalogue and renderer. */
export class AppearancePreview {
  private readonly character: RenderedGraphic
  private readonly tunic: RenderedGraphic
  private readonly sword: RenderedGraphic

  constructor(targets: PreviewTargets, catalog: AssetCatalog, graphics: IGraphicResources) {
    const renderer = new GraphicComponentRenderer()

    const mount = (target: HTMLElement, visual: string, alt: string) => {
      const component = graphicComponentSchema.parse({
        id: visual,
        type: 'graphic',
        visual,
        alt,
        placement: { row: 1, column: 1 },
      })

      const rendered = renderer.render(component, {
        document: target.ownerDocument,
        assets: catalog,
        graphics,
        bindingMode: 'editor',
      })

      target.replaceChildren(rendered.element)

      return rendered
    }

    this.character = mount(
      targets.character,
      'paper-doll',
      'Adventurer with customizable equipment',
    )
    this.tunic = mount(targets.tunic, 'tunic', 'Tunic item preview')
    this.sword = mount(targets.sword, 'sword', 'Sword item preview')
  }

  update(appearance: Appearance): void {
    const tunic = { colors: appearance.tunic.palette }
    const sword = { palette: appearance.sword.material.id }
    this.character.setAppearance(
      graphicAppearanceSchema.parse({
        slots: {
          tunic: { ...tunic, part: appearance.tunic.equipped ? 'tunic-part' : null },
          sword: { ...sword, part: appearance.sword.equipped ? 'sword-part' : null },
          cloak: { part: appearance.cloak ? 'cloak' : null },
        },
      }),
    )
    this.tunic.setAppearance(graphicAppearanceSchema.parse(tunic))
    this.sword.setAppearance(graphicAppearanceSchema.parse(sword))
  }

  dispose(): void {
    this.character.dispose()
    this.tunic.dispose()
    this.sword.dispose()
  }
}
