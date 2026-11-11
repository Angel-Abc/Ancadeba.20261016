import { projectViewSchema } from '@ancadeba/editor-core'
import { z } from 'zod'

export const editorDraftSchema = z.object({
  version: z.literal(1),
  path: z.string(),
  savedAt: z.number(),
  base: projectViewSchema,
  selection: z.string(),
  drafts: z.record(z.string(), z.unknown()),
})

export type EditorDraft = z.infer<typeof editorDraftSchema>

export interface EditorDraftStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const prefix = 'ancadeba.editor.draft.v1:'

export class EditorDraftStore {
  constructor(
    private readonly storage: () => EditorDraftStorage | undefined,
    private readonly session: string,
  ) {}

  private key(path: string): string {
    return `${prefix}${encodeURIComponent(path)}:${this.session}`
  }

  latest(path: string): { key: string; draft: EditorDraft } | undefined {
    const storage = this.storage()

    if (!storage) return undefined
    const matches: { key: string; draft: EditorDraft }[] = []

    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)

      if (!key?.startsWith(`${prefix}${encodeURIComponent(path)}:`)) continue
      const text = storage.getItem(key)

      if (!text) continue

      try {
        const draft = editorDraftSchema.parse(
          JSON.parse(text, (_key, value: unknown) => {
            if (value && typeof value === 'object' && '\u0000draft-number' in value)
              return Number(value['\u0000draft-number'])

            return value
          }),
        )

        if (draft.path === path) matches.push({ key, draft })
      } catch {
        // Leave damaged records untouched; valid drafts in other tabs remain recoverable.
      }
    }

    return matches.sort((a, b) => b.draft.savedAt - a.draft.savedAt)[0]
  }

  write(draft: EditorDraft): string {
    const storage = this.storage()

    if (!storage) throw new Error('Local recovery storage is unavailable')

    const text = JSON.stringify(draft, (_key, value: unknown) =>
      typeof value === 'number' && !Number.isFinite(value)
        ? { '\u0000draft-number': String(value) }
        : value,
    )

    if (text.length > 4 * 1024 * 1024) throw new Error('Draft exceeds local recovery capacity')
    storage.setItem(this.key(draft.path), text)

    return this.key(draft.path)
  }

  clear(path: string): void {
    this.storage()?.removeItem(this.key(path))
  }

  discard(key: string): void {
    if (key.startsWith(prefix)) this.storage()?.removeItem(key)
  }
}
