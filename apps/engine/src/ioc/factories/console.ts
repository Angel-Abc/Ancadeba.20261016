import type { IConsole } from '@ancadeba/utilities'

class Console implements IConsole {
  log(message: string, ...args: unknown[]): string {
    console.log(message, ...args)
    return message
  }
  debug(message: string, ...args: unknown[]): string {
    console.debug(message, ...args)
    return message
  }
  info(message: string, ...args: unknown[]): string {
    console.info(message, ...args)
    return message
  }
  warn(message: string, ...args: unknown[]): string {
    console.warn(message, ...args)
    return message
  }
  error(message: string, ...args: unknown[]): string {
    console.error(message, ...args)
    return message
  }
}

export interface ConsoleServices {
  console: IConsole
}

export const consoleFactory = {
  console: () => new Console(),
}
