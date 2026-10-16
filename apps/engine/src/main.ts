import './styling/main.css'
import { ContainerBuilder } from './ioc/containerBuilder'

const app = document.querySelector<HTMLElement>('#app')

if (!app) {
  throw new Error('The application root is missing')
}

const container = new ContainerBuilder().build()

const heading = document.createElement('h1')
heading.textContent = 'Ancadeba Engine'

const description = document.createElement('p')
description.textContent = 'The engine workspace is ready.'

app.append(heading, description)
container.resolve('logger').info('Engine', 'The engine workspace is ready.')
