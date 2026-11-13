import { runtimeText } from '@ancadeba/game-runtime'
import type { RuntimeTranslator } from '@ancadeba/schemas'
import type { ComponentRenderContext } from './componentRendering.js'

export function componentRuntimeText(context: ComponentRenderContext): RuntimeTranslator {
  return (key, values) =>
    runtimeText(
      context.localization?.current ??
        (context.scene?.type === 'game' ? context.scene.game.data : undefined),
      key,
      values,
    )
}
