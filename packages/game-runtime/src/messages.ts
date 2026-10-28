import type { GameData } from './gameData.js'
import type { VirtualInput } from './input.js'

export interface EngineMessages {
  'input.virtual': VirtualInput
  'engine.starting': undefined
  'engine.started': { game: GameData }
  'engine.failed': { error: unknown }
  'engine.stopped': undefined
}
