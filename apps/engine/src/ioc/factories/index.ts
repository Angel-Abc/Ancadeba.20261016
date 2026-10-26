import {
  loggerFactories,
  type Factories,
  type IJsonResourceLoader,
  type IMessageBus,
  type LoggerServices,
} from '@ancadeba/utilities'
import { consoleFactory, type ConsoleServices } from './console.js'
import type { EngineRuntimeConfig } from '@ancadeba/schemas'
import type { GameResourceService } from '../../gameResources.js'
import type { EngineMessages, IEngine, IEngineHost } from '@ancadeba/game-runtime'

export type EngineServices = ConsoleServices &
  LoggerServices & {
    config: EngineRuntimeConfig
    gameResources: GameResourceService
    jsonResourceLoader: IJsonResourceLoader
    host: IEngineHost
    createMessageBus: () => IMessageBus<EngineMessages>
    engine: IEngine
  }
export const engineFactories = {
  ...consoleFactory,
  ...loggerFactories,
} satisfies Factories<ConsoleServices & LoggerServices>
