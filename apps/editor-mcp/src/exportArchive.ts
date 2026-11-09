import { EditorApiError } from './editorApiError.js'
import { maxExportBytes } from './operationSupport.js'

export interface ExportArchive {
  fileName: string
  mimeType: 'application/zip'
  size: number
  dataBase64: string
}

export async function readExportArchive(response: Response): Promise<ExportArchive> {
  const fail = (code: string, message: string) =>
    new EditorApiError(code, message, [], 'not_applied', response.status)

  const tooLarge = () =>
    fail('export_too_large', 'The game ZIP exceeds the MCP export limit of 6 MiB')

  if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/zip') {
    await response.body?.cancel()
    throw fail('invalid_response', 'The editor did not return a game ZIP')
  }

  const declaredLength = response.headers.get('content-length')
  const length = declaredLength === null ? undefined : Number(declaredLength)

  if (length !== undefined && (!Number.isSafeInteger(length) || length < 1)) {
    await response.body?.cancel()
    throw fail('invalid_response', 'The editor returned an invalid ZIP length')
  }

  if (length !== undefined && length > maxExportBytes) {
    await response.body?.cancel()
    throw tooLarge()
  }

  const reader = response.body?.getReader()

  if (!reader) throw fail('invalid_response', 'The editor returned an empty ZIP')
  const chunks: Uint8Array[] = []
  let size = 0

  try {
    while (true) {
      const { value, done } = await reader.read()

      if (done) break
      size += value.byteLength

      if (size > maxExportBytes) throw tooLarge()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  const bytes = Buffer.concat(chunks, size)

  if (size < 4 || (length !== undefined && size !== length) || bytes.readUInt32LE(0) !== 0x04034b50)
    throw fail('invalid_response', 'The editor returned an incomplete or invalid game ZIP')

  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1]
  const fileName = name && /^[a-zA-Z0-9_-]+\.zip$/.test(name) ? name : 'game.zip'

  return { fileName, mimeType: 'application/zip', size, dataBase64: bytes.toString('base64') }
}
