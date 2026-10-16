import './style.css'

const app = document.querySelector<HTMLElement>('#app')

if (!app) {
  throw new Error('The application root is missing')
}

const heading = document.createElement('h1')
heading.textContent = 'Ancadeba Editor'

const description = document.createElement('p')
description.textContent = 'The editor workspace is ready.'

app.append(heading, description)
