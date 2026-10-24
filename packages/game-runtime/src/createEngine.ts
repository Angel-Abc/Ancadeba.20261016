import {
  Container,
  JsonResourceLoader,
  type IJsonResourceLoader,
  type ILogger,
  type IResourceSource,
} from '@ancadeba/utilities'
import { Engine, type IEngine, type IEngineHost } from './engine.js'

export interface EngineOptions {
  resourceSource: IResourceSource
  host: IEngineHost
  logger: ILogger
}

interface EngineServices extends EngineOptions {
  jsonResourceLoader: IJsonResourceLoader
  engine: IEngine
}

export function createEngine(options: EngineOptions): IEngine {
  const container = new Container<EngineServices>({
    resourceSource: () => options.resourceSource,
    host: () => options.host,
    logger: () => options.logger,
    jsonResourceLoader: (resolver) =>
      new JsonResourceLoader(resolver.resolve('resourceSource'), resolver.resolve('logger')),
    engine: (resolver) =>
      new Engine(
        resolver.resolve('jsonResourceLoader'),
        resolver.resolve('host'),
        resolver.resolve('logger'),
      ),
  })
  return container.resolve('engine')
}
