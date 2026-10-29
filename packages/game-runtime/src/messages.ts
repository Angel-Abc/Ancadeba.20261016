import type { GameData } from './gameData.js'
import type { VirtualInput } from './input.js'
import type { TimerWakeup } from './timers.js'
import type {
  ActionRequest,
  ActionApplied,
  ActionRejected,
  ActionFailed,
  ProgressionAdvanced,
} from './actions.js'
import type { TurnStarted, TurnTransition } from './turns.js'

export interface EngineMessages {
  'turn.started': TurnStarted
  'turn.ended': TurnTransition
  'turn.phaseChanged': TurnTransition
  'turn.roundAdvanced': TurnTransition
  'action.requested': ActionRequest
  'action.applied': ActionApplied
  'action.rejected': ActionRejected
  'action.failed': ActionFailed
  'turn.advanced': ProgressionAdvanced
  'world-time.advanced': ProgressionAdvanced
  'input.virtual': VirtualInput
  'timer.wakeup': TimerWakeup
  'engine.starting': undefined
  'engine.started': { game: GameData }
  'engine.failed': { error: unknown }
  'engine.stopped': undefined
}
