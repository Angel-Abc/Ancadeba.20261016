import {
  Engine,
  GameLoader,
  type EngineMessages,
  type IEngine,
  type IEngineHost,
} from '@ancadeba/game-runtime'
import {
  JsonResourceLoader,
  MessageBus,
  type Factories,
  type ILogger,
  type IMessageBus,
} from '@ancadeba/utilities'
import { EditorPreviewController, type PreviewStateListener } from '../../previewController.js'
import { EditorWorkspaceResources } from '../../workspaceResources.js'

export interface PreviewDependencies {
  fetcher: typeof fetch
  host: IEngineHost
  logger: ILogger
  onPreviewStateChange: PreviewStateListener
}

export interface PreviewServices {
  createMessageBus: () => IMessageBus<EngineMessages>
  createPreviewEngine: (folder: string) => IEngine
  previewController: EditorPreviewController
}

export const previewFactories = {
  createMessageBus: () => () => new MessageBus<EngineMessages>(),
  createPreviewEngine: (resolver) => {
    const fetcher = resolver.resolve('fetcher')
    const host = resolver.resolve('host')
    const logger = resolver.resolve('logger')
    const createMessageBus = resolver.resolve('createMessageBus')
    return (folder: string) =>
      new Engine(
        new GameLoader(
          new JsonResourceLoader(new EditorWorkspaceResources(folder, fetcher), logger),
        ),
        host,
        logger,
        createMessageBus,
      )
  },
  previewController: (resolver) =>
    new EditorPreviewController(
      resolver.resolve('createPreviewEngine'),
      resolver.resolve('onPreviewStateChange'),
    ),
} satisfies Factories<PreviewServices, PreviewServices & PreviewDependencies>
