import { loggerFactories, type Factories, type LoggerServices } from '@ancadeba/utilities'
import { consoleFactory, type ConsoleServices } from './console.js'
import type { EngineRuntimeConfig } from '@ancadeba/schemas'
import type { GameResourceService } from '../../gameResources.js'

export type EngineServices = ConsoleServices &
  LoggerServices & {
    config: EngineRuntimeConfig
    gameResources: GameResourceService
  }
export const engineFactories = {
  ...consoleFactory,
  ...loggerFactories,
} satisfies Factories<ConsoleServices & LoggerServices>
