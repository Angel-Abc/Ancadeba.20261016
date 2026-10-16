import { loggerFactories, type Factories, type LoggerServices } from '@ancadeba/utilities'
import { consoleFactory, type ConsoleServices } from './console'

export type EngineServices = ConsoleServices & LoggerServices
export const engineFactories = {
  ...consoleFactory,
  ...loggerFactories,
} satisfies Factories<EngineServices>
