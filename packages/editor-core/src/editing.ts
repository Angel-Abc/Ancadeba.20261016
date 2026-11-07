import { editLeveling } from './levelingEditing.js'
import { assetCatalogFile, gameSchema, sceneSchema } from '@ancadeba/schemas'
import { commandSchema, type EditorCommand } from './commands.js'
import { EditorError, object, type CommandResult, type ProjectSnapshot } from './project.js'
import { validateProject } from './validation.js'
import { editAssets } from './assetEditing.js'
import { editRules } from './ruleEditing.js'
import { editControls } from './controlEditing.js'
import { editStatusPanel } from './statusPanelEditing.js'
import { editComponent } from './componentEditing.js'
import { editItems } from './itemEditing.js'
import { editShop } from './shopEditing.js'
import { editCombat } from './combatEditing.js'

export function applyCommand(project: ProjectSnapshot, input: EditorCommand): CommandResult {
  const parsed = commandSchema.safeParse(input)

  if (!parsed.success) throw new EditorError(400, 'invalid_command', 'Invalid editing command')
  const command = parsed.data
  const initialDiagnostics = validateProject(project.documents, project.sourceDiagnostics)
  const repairing = command.type === 'assets.upsertImage' || command.type === 'assets.remove'
  const manifest = object(project.documents['game.json'])

  const catalog = object(
    typeof manifest.assets === 'string'
      ? project.documents[assetCatalogFile(manifest.assets)]
      : undefined,
  )

  const repairSource = repairing ? object(object(catalog.images)[command.id]).source : undefined

  const diagnostics = initialDiagnostics.filter(
    (diagnostic) =>
      (!repairing || diagnostic.file !== repairSource) &&
      (command.type !== 'game.updateRules' || diagnostic.code !== 'invalid_rules'),
  )

  if (diagnostics.length)
    throw new EditorError(
      422,
      'invalid_project',
      'Fix project diagnostics before editing',
      diagnostics,
    )
  const documents = { ...project.documents }
  const game = gameSchema.parse(documents['game.json'])
  const changedFiles: string[] = []

  if (
    command.type === 'game.upsertLeveling' ||
    command.type === 'game.removeLeveling' ||
    command.type === 'scene.upsertLevelingView' ||
    command.type === 'scene.removeLevelingView'
  ) {
    changedFiles.push(...editLeveling(documents, game, command))
  } else if (
    command.type === 'game.upsertCombat' ||
    command.type === 'game.removeCombat' ||
    command.type === 'scene.setCombat'
  ) {
    changedFiles.push(...editCombat(documents, game, command))
  } else if (command.type === 'scene.upsertShop' || command.type === 'scene.removeShop') {
    changedFiles.push(...editShop(documents, game, command))
  } else if (
    command.type === 'inventory.setItemPresentation' ||
    command.type === 'inventory.setEquipmentSlots' ||
    command.type === 'scene.setInventoryDetails' ||
    command.type === 'scene.upsertItemView' ||
    command.type === 'scene.removeItemView'
  ) {
    changedFiles.push(...editItems(documents, game, command))
  } else if (command.type === 'scene.upsertComponent') {
    changedFiles.push(...editComponent(documents, game, command))
  } else if (
    command.type === 'scene.upsertStatusPanel' ||
    command.type === 'scene.removeStatusPanel'
  ) {
    changedFiles.push(...editStatusPanel(documents, game, command))
  } else if (
    command.type === 'scene.setActionBar' ||
    command.type === 'game.updateInput' ||
    command.type === 'scene.upsertNearby'
  ) {
    changedFiles.push(...editControls(documents, game, command))
  } else if (
    command.type.startsWith('assets.') ||
    command.type === 'scene.upsertGraphic' ||
    command.type === 'scene.removeGraphic'
  ) {
    changedFiles.push(...editAssets(documents, game, command))
  } else if (
    command.type === 'game.updateRules' ||
    command.type === 'scene.upsertRuleButton' ||
    command.type === 'inventory.setRuleInspection' ||
    command.type === 'inventory.setItemActions'
  ) {
    changedFiles.push(...editRules(documents, game, command))
  } else if (command.type === 'game.updateMetadata') {
    documents['game.json'] = {
      ...object(documents['game.json']),
      title: command.title,
      description: command.description,
      version: command.version,
    }
    changedFiles.push('game.json')
  } else if (command.type === 'scene.create') {
    const file = `scenes/${command.scene.id}.json`

    if (game.scenes.includes(command.scene.id) || Object.hasOwn(documents, file)) {
      throw new EditorError(409, 'scene_exists', 'Scene ID already exists')
    }

    // Clone the validated scene, including extension properties and normalized metadata.
    documents[file] = JSON.parse(JSON.stringify(command.scene))
    documents['game.json'] = {
      ...object(documents['game.json']),
      scenes: [...game.scenes, command.scene.id],
    }
    changedFiles.push(file, 'game.json')
  } else if (command.type === 'scene.updateMetadata' || command.type === 'scene.updateLayout') {
    if (!game.scenes.includes(command.sceneId))
      throw new EditorError(404, 'scene_not_found', 'Scene does not exist')
    const file = `scenes/${command.sceneId}.json`
    const source = object(documents[file])
    sceneSchema.parse(source)

    if (command.type === 'scene.updateMetadata') {
      documents[file] = { ...source, title: command.title, description: command.description }
    } else {
      const screen = object(source.screen)
      documents[file] = {
        ...source,
        screen: {
          ...screen,
          grid: { ...object(screen.grid), rows: command.rows, columns: command.columns },
        },
      }
    }

    changedFiles.push(file)
  }

  const resultingDiagnostics = validateProject(documents)

  if (resultingDiagnostics.length)
    throw new EditorError(
      422,
      'invalid_project',
      'Change produces an invalid project',
      resultingDiagnostics,
    )

  return {
    project: { revision: project.revision, documents },
    changedFiles,
    summary:
      command.type === 'scene.create'
        ? `Created scene ${command.scene.id}`
        : command.type === 'game.updateMetadata'
          ? 'Updated game metadata'
          : command.type === 'scene.updateLayout'
            ? `Updated scene ${command.sceneId} grid to ${command.rows} x ${command.columns}`
            : command.type === 'scene.updateMetadata'
              ? `Updated scene ${command.sceneId} metadata`
              : `Applied ${command.type}`,
    diagnostics: [],
  }
}
