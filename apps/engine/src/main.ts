import './styling/main.css'
import type { IEngine } from '@ancadeba/game-runtime'
import { ContainerBuilder } from './ioc/containerBuilder'
import { loadRuntimeConfig } from './config'
import { DomEngineHost } from './engineHost'

const app = document.querySelector<HTMLElement>('#app')

if (!app) {
  throw new Error('The application root is missing')
}

const applicationUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href
let engine: IEngine | undefined
let disposed = false

import.meta.hot?.dispose(() => {
  disposed = true
  engine?.stop()
})

try {
  const config = await loadRuntimeConfig(applicationUrl, fetch)
  if (!disposed) {
    const container = new ContainerBuilder(
      config,
      applicationUrl,
      fetch,
      new DomEngineHost(app),
    ).build()
    engine = container.resolve('engine')
    await engine.start()
  }
} catch (error) {
  if (!disposed) {
    app.textContent =
      'Unable to start the engine. Check config.json, game.json, and the browser console.'
    throw error
  }
}
