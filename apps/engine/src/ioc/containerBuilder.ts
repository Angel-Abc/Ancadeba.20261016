import { Engine, GameLoader, type EngineMessages, type IEngineHost } from '@ancadeba/game-runtime'
import { Container, JsonResourceLoader, MessageBus } from '@ancadeba/utilities'
import { engineFactories, type EngineServices } from './factories/index.js'
import type { EngineRuntimeConfig } from '@ancadeba/schemas'
import { HttpGameResources } from '../gameResources.js'

export interface IContainerBuilder {
  build(): Container<EngineServices>
}

const category = 'ContainerBuilder'
export class ContainerBuilder implements IContainerBuilder {
  constructor(
    private readonly config: EngineRuntimeConfig,
    private readonly applicationUrl: string,
    private readonly fetcher: typeof fetch,
    private readonly host: IEngineHost,
  ) {}

  build(): Container<EngineServices> {
    const container = new Container<EngineServices>({
      ...engineFactories,
      config: () => this.config,
      host: () => this.host,
      createMessageBus: () => () => new MessageBus<EngineMessages>(),
      engine: (resolver) =>
        new Engine(
          resolver.resolve('gameLoader'),
          resolver.resolve('host'),
          resolver.resolve('logger'),
          resolver.resolve('createMessageBus'),
        ),
      gameLoader: (resolver) => new GameLoader(resolver.resolve('jsonResourceLoader')),
      jsonResourceLoader: (resolver) =>
        new JsonResourceLoader(resolver.resolve('gameResources'), resolver.resolve('logger')),
      gameResources: (resolver) =>
        new HttpGameResources(
          resolver.resolve('config').gameUrl,
          this.applicationUrl,
          this.fetcher,
        ),
    })
    const logger = container.resolve('logger')
    logger.info(category, 'Container built successfully.')
    return container
  }
}
