import { assetCatalogSchema, sceneSchema } from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'

export function editAssets(documents: Record<string, unknown>, command: EditorCommand): string[] {
  const game = object(documents['game.json'])

  if (command.type.startsWith('assets.')) {
    const file = typeof game.assets === 'string' ? game.assets : 'assets.json'

    const catalog = assetCatalogSchema.parse(
      typeof game.assets === 'string' ? documents[file] : { 'schema-version': '1.0.0' },
    )

    if (command.type === 'assets.upsertImage') catalog.images[command.id] = command.image
    else if (command.type === 'assets.upsertPart') catalog.parts[command.id] = command.part
    else if (command.type === 'assets.upsertComposition')
      catalog.compositions[command.id] = command.composition
    else if (command.type === 'assets.remove') {
      if (!Object.hasOwn(catalog[command.kind], command.id))
        throw new EditorError(404, 'asset_not_found', 'Asset does not exist')
      delete catalog[command.kind][command.id]
    }

    documents[file] = { ...object(documents[file]), ...catalog }

    if (typeof game.assets !== 'string') {
      documents['game.json'] = { ...game, assets: file }

      return [file, 'game.json']
    }

    return [file]
  }

  if (command.type === 'scene.upsertGraphic' || command.type === 'scene.removeGraphic') {
    const file = `scenes/${command.sceneId}.json`
    const scene = sceneSchema.safeParse(documents[file])

    if (!scene.success) throw new EditorError(404, 'scene_not_found', 'Scene does not exist')
    const source = object(documents[file])
    const components = Array.isArray(source.components) ? [...source.components] : []
    const id = command.type === 'scene.upsertGraphic' ? command.component.id : command.componentId
    const index = components.findIndex((component) => object(component).id === id)

    if (index >= 0 && object(components[index]).type !== 'graphic')
      throw new EditorError(409, 'component_exists', 'This ID belongs to another component type')

    if (command.type === 'scene.upsertGraphic') {
      if (index < 0) components.push(command.component)
      else components[index] = { ...object(components[index]), ...command.component }
    } else {
      if (index < 0) throw new EditorError(404, 'component_not_found', 'Graphic does not exist')
      components.splice(index, 1)
    }

    documents[file] = { ...source, components }

    return [file]
  }

  throw new EditorError(400, 'invalid_command', 'Unsupported asset command')
}
