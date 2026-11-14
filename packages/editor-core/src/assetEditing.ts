import {
  assetCatalogFile,
  assetCatalogSchema,
  sceneSchema,
  type GameDefinition,
} from '@ancadeba/schemas'
import type { EditorCommand } from './commands.js'
import { EditorError, object } from './project.js'
import { mergeGraphicAsset, mergeGraphicDefinitions } from './graphicDefinitionEditing.js'
import { mergeGraphicAppearance } from './graphicAppearanceEditing.js'

export function editAssets(
  documents: Record<string, unknown>,
  game: GameDefinition,
  command: EditorCommand,
): string[] {
  if (command.type.startsWith('assets.')) {
    const id = game.assets ?? 'catalogue'
    const file = assetCatalogFile(id)

    const catalog = assetCatalogSchema.parse(
      game.assets ? documents[file] : { 'schema-version': '1.0.0' },
    )

    if (command.type === 'assets.updateDefinitions') {
      if (!game.assets && Object.hasOwn(documents, file))
        throw new EditorError(
          409,
          'asset_catalog_exists',
          'An unlisted asset catalog already exists',
        )
      documents[file] = mergeGraphicDefinitions(
        documents[file] ?? { 'schema-version': '1.0.0', images: {} },
        command,
      )

      if (!game.assets) {
        documents['game.json'] = { ...object(documents['game.json']), assets: id }

        return [file, 'game.json']
      }

      return [file]
    }

    const next = { ...object(documents[file]) }

    if (command.type === 'assets.upsertImage') {
      const images = object(next.images)
      next.images = {
        ...images,
        [command.id]: mergeGraphicAsset(images[command.id], command.image, 'images'),
      }
    } else if (command.type === 'assets.upsertPart') {
      const parts = object(next.parts)
      next.parts = {
        ...parts,
        [command.id]: mergeGraphicAsset(parts[command.id], command.part, 'parts'),
      }
    } else if (command.type === 'assets.upsertComposition') {
      const compositions = object(next.compositions)
      next.compositions = {
        ...compositions,
        [command.id]: mergeGraphicAsset(
          compositions[command.id],
          command.composition,
          'compositions',
        ),
      }
    } else if (command.type === 'assets.remove') {
      if (!Object.hasOwn(catalog[command.kind], command.id))
        throw new EditorError(404, 'asset_not_found', 'Asset does not exist')
      const entries = { ...object(next[command.kind]) }
      delete entries[command.id]
      next[command.kind] = entries
    }

    documents[file] = { ...catalog, ...next }

    if (!game.assets) {
      documents['game.json'] = { ...object(documents['game.json']), assets: id }

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
      if (command.createOnly && index >= 0)
        throw new EditorError(409, 'component_exists', 'A component with this ID already exists')
      const before = object(components[index])

      const next = {
        ...before,
        ...command.component,
        altKey: command.component.altKey,
        placement: { ...object(before.placement), ...command.component.placement },
        appearance: mergeGraphicAppearance(before.appearance, command.component.appearance),
      }

      if (index < 0) components.push(next)
      else components[index] = next
    } else {
      if (index < 0) throw new EditorError(404, 'component_not_found', 'Graphic does not exist')
      components.splice(index, 1)
    }

    documents[file] = { ...source, components }

    return [file]
  }

  throw new EditorError(400, 'invalid_command', 'Unsupported asset command')
}
