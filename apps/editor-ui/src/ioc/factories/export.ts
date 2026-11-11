import type { Factories } from '@ancadeba/utilities'
import { EditorExportController, type ExportStateListener } from '../../exportController.js'

export interface ExportDependencies {
  fetcher: typeof fetch
  download: (archive: Blob, fileName: string) => void
  onExportStateChange: ExportStateListener
  confirmExport?: () => boolean
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
      resolver.resolve('confirmExport'),
    ),
} satisfies Factories<ExportServices, ExportDependencies>
