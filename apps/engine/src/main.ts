import './styling/main.css'
import { ContainerBuilder } from './ioc/containerBuilder'
import { loadRuntimeConfig } from './config'

const app = document.querySelector<HTMLElement>('#app')

if (!app) {
  throw new Error('The application root is missing')
}

const applicationUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href
let container
try {
  const config = await loadRuntimeConfig(applicationUrl, fetch)
  container = new ContainerBuilder(config, applicationUrl, fetch).build()
  container.resolve('gameResources')
} catch (error) {
  app.textContent = 'Unable to start the engine. Check config.json and the browser console.'
  throw error
}

const heading = document.createElement('h1')
heading.textContent = 'Ancadeba Engine'

const description = document.createElement('p')
description.textContent = 'The engine workspace is ready.'

app.append(heading, description)
container.resolve('logger').info('Engine', 'The engine workspace is ready.')
