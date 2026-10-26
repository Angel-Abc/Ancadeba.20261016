import {
  Container,
  JsonResourceLoader,
  MessageBus,
  type IJsonResourceLoader,
  type ILogger,
  type IResourceSource,
  type IMessageBus,
} from '@ancadeba/utilities'
import { Engine, type IEngine, type IEngineHost } from './engine.js'
import type { EngineMessages } from './messages.js'

export interface EngineOptions {
  resourceSource: IResourceSource
  host: IEngineHost
  logger: ILogger
  /** Return a fresh bus for each session. Omit to use the standard queued bus. */
  createMessageBus?: () => IMessageBus<EngineMessages>
}

interface EngineServices extends EngineOptions {
  createMessageBus: () => IMessageBus<EngineMessages>
  jsonResourceLoader: IJsonResourceLoader
  engine: IEngine
}

export function createEngine(options: EngineOptions): IEngine {
  const container = new Container<EngineServices>({
    resourceSource: () => options.resourceSource,
    host: () => options.host,
    logger: () => options.logger,
    createMessageBus: () => options.createMessageBus ?? (() => new MessageBus<EngineMessages>()),
    jsonResourceLoader: (resolver) =>
      new JsonResourceLoader(resolver.resolve('resourceSource'), resolver.resolve('logger')),
    engine: (resolver) =>
      new Engine(
        resolver.resolve('jsonResourceLoader'),
        resolver.resolve('host'),
        resolver.resolve('logger'),
        resolver.resolve('createMessageBus'),
      ),
  })
  return container.resolve('engine')
}
