import { Container } from '@ancadeba/utilities'
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
  ) {}

  build(): Container<EngineServices> {
    const container = new Container<EngineServices>({
      ...engineFactories,
      config: () => this.config,
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
