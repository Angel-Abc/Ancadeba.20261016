import {
  createRuntimeTranslator,
  type RuntimeTextKey,
  type RuntimeTextValues,
} from '@ancadeba/schemas'
import type { GameData } from './gameData.js'

/** Read current language and catalogs at use time, including for retained runtime services. */
export function runtimeText(
  game: Pick<GameData, 'language' | 'ruleTranslation'> | undefined,
  key: RuntimeTextKey,
  values?: RuntimeTextValues,
): string {
  return createRuntimeTranslator(game?.language, game?.ruleTranslation)(key, values)
}
