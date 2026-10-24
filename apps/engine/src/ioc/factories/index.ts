import {
  loggerFactories,
  type Factories,
  type IJsonResourceLoader,
  type LoggerServices,
} from '@ancadeba/utilities'
import { consoleFactory, type ConsoleServices } from './console.js'
import type { EngineRuntimeConfig } from '@ancadeba/schemas'
import type { GameResourceService } from '../../gameResources.js'

export type EngineServices = ConsoleServices &
  LoggerServices & {
    config: EngineRuntimeConfig
    gameResources: GameResourceService
    jsonResourceLoader: IJsonResourceLoader
  }
export const engineFactories = {
  ...consoleFactory,
  ...loggerFactories,
} satisfies Factories<ConsoleServices & LoggerServices>
