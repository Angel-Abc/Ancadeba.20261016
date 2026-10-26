import type { Factories } from '@ancadeba/utilities'
import { EditorExportController, type ExportStateListener } from '../../exportController.js'

export interface ExportDependencies {
  fetcher: typeof fetch
  download: (archive: Blob, fileName: string) => void
  onExportStateChange: ExportStateListener
}

export interface ExportServices {
  exportController: EditorExportController
}

export const exportFactories = {
  exportController: (resolver) =>
    new EditorExportController(
      resolver.resolve('fetcher'),
      resolver.resolve('download'),
      resolver.resolve('onExportStateChange'),
    ),
} satisfies Factories<ExportServices, ExportDependencies>
