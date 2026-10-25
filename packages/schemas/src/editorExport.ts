import { z } from 'zod'

export interface EditorExportRequest {
  path: string
}

export function parseEditorExportRequest(value: unknown): EditorExportRequest {
  return z.strictObject({ path: z.string() }).parse(value)
}
