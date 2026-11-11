import {
  Engine,
  GameLoader,
  type EngineMessages,
  type IEngine,
  type IEngineHost,
  type EngineRuntimeServices,
  type GameLanguagePreferences,
  type GameSaveStore,
} from '@ancadeba/game-runtime'
import {
  JsonResourceLoader,
  MessageBus,
  type Factories,
  type ILogger,
  type IMessageBus,
  type IResourceSource,
} from '@ancadeba/utilities'
import { EditorPreviewController, type PreviewStateListener } from '../../previewController.js'
import { EditorWorkspaceResources } from '../../workspaceResources.js'

export interface PreviewDependencies {
  fetcher: typeof fetch
  host: IEngineHost
  createHost?: (source: IResourceSource) => IEngineHost
  runtime: EngineRuntimeServices
  logger: ILogger
  onPreviewStateChange: PreviewStateListener
  confirmPreview?: () => boolean
  getPreferredGameLanguages?: () => readonly string[]
  gameLanguagePreferences?: GameLanguagePreferences
  createGameSaveStore?: (folder: string) => GameSaveStore
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
    const runtime = resolver.resolve('runtime')
    const getPreferredLanguages = resolver.resolve('getPreferredGameLanguages')
    const languagePreferences = resolver.resolve('gameLanguagePreferences')

    return (folder: string) => {
      const source = new EditorWorkspaceResources(folder, fetcher)

      return new Engine(
        new GameLoader(
          new JsonResourceLoader(source, logger),
          getPreferredLanguages?.() ?? [],
          languagePreferences,
        ),
        resolver.resolve('createHost')?.(source) ?? host,
        logger,
        createMessageBus,
        {
          ...runtime,
          ...(resolver.resolve('createGameSaveStore')
            ? { saveStore: resolver.resolve('createGameSaveStore')!(folder) }
            : {}),
        },
      )
    }
  },
  previewController: (resolver) =>
    new EditorPreviewController(
      resolver.resolve('createPreviewEngine'),
      resolver.resolve('onPreviewStateChange'),
      resolver.resolve('confirmPreview'),
    ),
} satisfies Factories<PreviewServices, PreviewServices & PreviewDependencies>
