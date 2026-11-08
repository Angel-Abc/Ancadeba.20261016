import { Container } from '@ancadeba/utilities'
import { editorFactories, type EditorDependencies, type EditorServices } from './factories/index.js'

export interface IContainerBuilder {
  build(): Container<EditorServices>
}

export class ContainerBuilder implements IContainerBuilder {
  constructor(private readonly dependencies: EditorDependencies) {}

  build(): Container<EditorServices> {
    return new Container<EditorServices>({
      ...editorFactories,
      fetcher: () => this.dependencies.fetcher,
      host: () => this.dependencies.host,
      createHost: () => this.dependencies.createHost,
      runtime: () => this.dependencies.runtime,
      onPreviewStateChange: () => this.dependencies.onPreviewStateChange,
      getPreferredGameLanguages: () => this.dependencies.getPreferredGameLanguages,
      gameLanguagePreferences: () => this.dependencies.gameLanguagePreferences,
      createGameSaveStore: () => this.dependencies.createGameSaveStore,
      download: () => this.dependencies.download,
      onExportStateChange: () => this.dependencies.onExportStateChange,
    })
  }
}
