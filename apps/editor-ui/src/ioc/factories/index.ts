import { loggerFactories, type Factories, type LoggerServices } from '@ancadeba/utilities'
import { consoleFactory, type ConsoleServices } from './console.js'
import { previewFactories, type PreviewDependencies, type PreviewServices } from './preview.js'
import { exportFactories, type ExportDependencies, type ExportServices } from './export.js'

export type EditorDependencies = Omit<PreviewDependencies, 'logger'> & ExportDependencies

export type EditorServices = EditorDependencies &
  ConsoleServices &
  LoggerServices &
  PreviewServices &
  ExportServices

export const editorFactories = {
  ...consoleFactory,
  ...loggerFactories,
  ...previewFactories,
  ...exportFactories,
} satisfies Factories<
  ConsoleServices & LoggerServices & PreviewServices & ExportServices,
  EditorServices
>
