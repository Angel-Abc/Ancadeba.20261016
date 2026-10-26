import type { Game } from '@ancadeba/schemas'

export interface EngineMessages {
  'engine.starting': undefined
  'engine.started': { game: Game }
  'engine.failed': { error: unknown }
  'engine.stopped': undefined
}
