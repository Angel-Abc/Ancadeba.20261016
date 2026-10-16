import { formatMessageForConsole } from '../formatters/formatMessage.js'
import { LogLevel, type IConsole, type ILogger } from './index.js'

function logMessage(
  console: IConsole,
  logLevel: LogLevel,
  category: string,
  message: string,
  ...args: unknown[]
): string {
  const { formattedMessage, extraArgs } = formatMessageForConsole(message, ...args)
  const formattedCategory = extraArgs.length > 0 ? category.replaceAll('%', '%%') : category
  const finalMessage = category ? `[${formattedCategory}] ${formattedMessage}` : formattedMessage

  switch (logLevel) {
    case LogLevel.debug:
      console.debug('\x1B[37m' + finalMessage + '\x1B[0m', ...extraArgs)
      break
    case LogLevel.info:
      console.info('\x1B[30m' + finalMessage + '\x1B[0m', ...extraArgs)
      break
    case LogLevel.warning:
      console.warn('\x1B[1m\x1B[33m' + finalMessage + '\x1B[0m', ...extraArgs)
      break
    case LogLevel.error:
      console.error('\x1B[1m\x1B[31m' + finalMessage + '\x1B[0m', ...extraArgs)
      break
    default:
      console.log(finalMessage, ...extraArgs)
      break
  }

  return finalMessage
}

export class ConsoleLogger implements ILogger {
  constructor(private readonly console: IConsole) {}
  debug(category: string, message: string, ...args: unknown[]): string {
    return logMessage(this.console, LogLevel.debug, category, message, ...args)
  }
  info(category: string, message: string, ...args: unknown[]): string {
    return logMessage(this.console, LogLevel.info, category, message, ...args)
  }
  warn(category: string, message: string, ...args: unknown[]): string {
    return logMessage(this.console, LogLevel.warning, category, message, ...args)
  }
  error(category: string, message: string, ...args: unknown[]): string {
    return logMessage(this.console, LogLevel.error, category, message, ...args)
  }
}
