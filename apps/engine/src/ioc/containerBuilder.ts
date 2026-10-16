import { Container } from '@ancadeba/utilities'
import { engineFactories, type EngineServices } from './factories'

export interface IContainerBuilder {
  build(): Container<EngineServices>
}

const category = 'ContainerBuilder'
export class ContainerBuilder implements IContainerBuilder {
  build(): Container<EngineServices> {
    const container = new Container<EngineServices>(engineFactories)
    const logger = container.resolve('logger')
    logger.info(category, 'Container built successfully.')
    return container
  }
}
