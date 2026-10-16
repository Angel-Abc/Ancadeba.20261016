import { ConsoleLogger } from '../../logger/console.js'
import type { IConsole, ILogger } from '../../logger/index.js'
import type { Factories } from '../index.js'

export interface LoggerServices {
  logger: ILogger
}

export interface LoggerDependencies {
  console: IConsole
}

export const loggerFactories = {
  logger: (context) => new ConsoleLogger(context.resolve('console')),
} satisfies Factories<LoggerServices, LoggerDependencies>
