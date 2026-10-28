/** Browser timing supplied explicitly by the application's composition root. */
export function createBrowserTiming(
  window: Pick<Window, 'setTimeout' | 'clearTimeout' | 'performance'>,
) {
  return {
    clock: { now: () => window.performance.now() },
    scheduler: {
      schedule(callback: () => void, delayMs: number): () => void {
        let active = true
        const id = window.setTimeout(() => {
          if (!active) return
          active = false
          callback()
        }, delayMs)
        return () => {
          if (!active) return
          active = false
          window.clearTimeout(id)
        }
      },
    },
  }
}
