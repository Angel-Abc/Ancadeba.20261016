import './styling/main.css'
import '@ancadeba/ui-components/game.css'
import { withMuseumDemo, type IEngine } from '@ancadeba/game-runtime'
import { createBrowserTiming, BrowserGameLanguagePreferences } from '@ancadeba/ui-components'
import { ContainerBuilder } from './ioc/containerBuilder'
import { loadRuntimeConfig } from './config'
import { DomEngineHost } from './engineHost'
import { HttpGameResources } from './gameResources'
import { selectLanguage } from '@ancadeba/schemas'
import { createTranslator } from '@ancadeba/utilities'
import en from '../languages/en/messages.json' with { type: 'json' }
import nl from '../languages/nl/messages.json' with { type: 'json' }

const app = document.querySelector<HTMLElement>('#app')

if (!app) {
  throw new Error('The application root is missing')
}

const applicationUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href
const requestedLanguage = new URL(window.location.href).searchParams.get('language')
const preferredLanguages = requestedLanguage ? [requestedLanguage] : []
const uiLanguage = selectLanguage(['en', 'nl'], 'en', preferredLanguages)
const t = createTranslator(en, uiLanguage === 'nl' ? nl : en)

document.documentElement.lang = uiLanguage

let engine: IEngine | undefined
let disposed = false
let unsubscribeLanguage: (() => void) | undefined

import.meta.hot?.dispose(() => {
  disposed = true
  unsubscribeLanguage?.()
  engine?.stop()
})

try {
  const config = await loadRuntimeConfig(applicationUrl, fetch)

  if (!disposed) {
    const container = new ContainerBuilder(
      config,
      applicationUrl,
      fetch,
      new DomEngineHost(app, new HttpGameResources(config.gameUrl, applicationUrl, fetch)),
      withMuseumDemo(createBrowserTiming(window)),
      preferredLanguages,
      new BrowserGameLanguagePreferences(() => window.localStorage),
    ).build()

    engine = container.resolve('engine')
    await engine.start()

    const localization = engine.game?.localization

    if (!disposed && requestedLanguage && localization) {
      unsubscribeLanguage = localization.subscribe(() => {
        const url = new URL(window.location.href)
        url.searchParams.set('language', localization.current.language)
        window.history.replaceState(window.history.state, '', url)
      })
    }
  }
} catch (error) {
  if (!disposed) {
    app.textContent = t('startup.error')
    throw error
  }
}
