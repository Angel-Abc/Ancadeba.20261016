import type { GameSaveFile } from '@ancadeba/game-runtime'

/** Owns the download URL for one mounted game view. */
export class BrowserGameSaveDownload {
  private url: string | undefined

  constructor(private readonly document: Document) {}

  download(file: GameSaveFile): void {
    this.dispose()
    const view = this.document.defaultView

    if (!view) throw new Error('Save downloads require a browser window')
    this.url = view.URL.createObjectURL(new view.Blob([file.text], { type: 'application/json' }))
    const link = this.document.createElement('a')
    link.href = this.url
    link.download = file.fileName
    link.hidden = true
    this.document.body.append(link)

    try {
      link.click()
    } finally {
      link.remove()
    }
  }

  dispose(): void {
    if (this.url) this.document.defaultView?.URL.revokeObjectURL(this.url)
    this.url = undefined
  }
}
