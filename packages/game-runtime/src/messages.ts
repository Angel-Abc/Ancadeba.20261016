import type { GameData } from './gameData.js'
import type { VirtualInput } from './input.js'
import type { TimerWakeup } from './timers.js'

export interface EngineMessages {
  'input.virtual': VirtualInput
  'timer.wakeup': TimerWakeup
  'engine.starting': undefined
  'engine.started': { game: GameData }
  'engine.failed': { error: unknown }
  'engine.stopped': undefined
}
