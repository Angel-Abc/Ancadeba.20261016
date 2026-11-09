import type { ProjectView } from '@ancadeba/editor-core'
import type { Translate } from '@ancadeba/utilities'

export interface ProjectTreeNode {
  key: string
  label: string
  section: string
  kind: string
  id?: string
  parentId?: string
  detail?: string
  children?: ProjectTreeNode[]
}

/** New systems supply a section and handle its selections in the workspace. */
export interface ProjectTreeSection {
  id: string
  labelKey: string
  nodes(view: ProjectView, t: Translate): ProjectTreeNode[]
}

/** Metadata uses its assigned default-language translation before the literal fallback. */
export function gameTitle(view: ProjectView): string {
  const game = view.game

  return (game?.titleKey ? view.translations?.[game.titleKey] : undefined) ?? game?.title ?? ''
}

export function sceneTitle(view: ProjectView, scene: ProjectView['scenes'][number]): string {
  return (
    ((scene.titleKey ? view.translations?.[scene.titleKey] : undefined) ?? scene.title) || scene.id
  )
}

/** The tree label for a scene; the ID is added when another scene shows the same title. */
export function sceneTreeLabel(view: ProjectView, scene: ProjectView['scenes'][number]): string {
  const title = sceneTitle(view, scene)

  const shared = view.scenes.some(
    (other) => other.id !== scene.id && sceneTitle(view, other) === title,
  )

  return shared && title !== scene.id ? `${title} (${scene.id})` : title
}

/** Rule files open in the rules editor; selecting one switches the file being edited. */
export const ruleFileNodes = (view: ProjectView): ProjectTreeNode[] =>
  (view.game?.rules ?? []).map((id) => ({
    key: `rule-file:${id}`,
    section: 'rules',
    kind: 'rule-file',
    id,
    label: id,
  }))

export const mapFileNodes = (view: ProjectView, t: Translate): ProjectTreeNode[] => [
  ...(view.game?.maps ?? []).map((id): ProjectTreeNode => ({
    key: `map:${id}`,
    section: 'maps',
    kind: 'map',
    id,
    label: id,
    detail: view.maps?.[id] ? `${view.maps[id].width} × ${view.maps[id].height}` : '',
  })),
  { key: 'map-new', section: 'maps', kind: 'new-map', label: t('maps.new') },
]

/** Game data without an editor yet is listed for reference and shown read-only. */
/** One group of game files listed under Data files, with the section that edits them. */
interface DataFileGroup {
  id: string
  ids: (game: NonNullable<ProjectView['game']>) => readonly string[] | undefined
  content: (view: ProjectView, id: string) => unknown
  editSection?: string
}

const dataFileGroups: readonly DataFileGroup[] = [
  {
    id: 'maps',
    ids: (game) => game.maps,
    content: (view, id) => view.maps?.[id],
    editSection: 'maps',
  },
  {
    id: 'inventories',
    ids: (game) => game.inventory,
    content: (view, id) => view.inventoryFiles?.[id],
    editSection: 'items',
  },
  {
    id: 'leveling',
    ids: (game) => game.leveling,
    content: (view, id) => view.leveling?.[id],
    editSection: 'leveling',
  },
  {
    id: 'combat',
    ids: (game) => game.combat,
    content: (view, id) => view.combatSources?.[id] ?? view.combat?.[id],
    editSection: 'combat',
  },
  {
    id: 'combatLibraries',
    ids: (game) => game.combatLibraries,
    content: (view, id) => view.combatLibraries?.[id],
    editSection: 'combat',
  },
  {
    id: 'dialogues',
    ids: (game) => game.dialogues,
    content: (view, id) => view.dialogues?.[id],
    editSection: 'story',
  },
  {
    id: 'quests',
    ids: (game) => game.quests,
    content: (view, id) => view.quests?.[id],
    editSection: 'story',
  },
]

/** The parsed file behind a Data files node, and the section that edits it, if any. */
export function dataFileContent(
  view: ProjectView,
  node: ProjectTreeNode,
): { content: unknown; editSection?: string | undefined } | undefined {
  const group = dataFileGroups.find(({ id }) => id === node.parentId)

  if (node.kind !== 'data-file' || !group || !node.id) return undefined
  const content = group.content(view, node.id)

  return content === undefined ? undefined : { content, editSection: group.editSection }
}

/** Read-only game files that have no dedicated tree entries elsewhere. */
export const dataFilesSection: ProjectTreeSection = {
  id: 'data',
  labelKey: 'tree.data',
  nodes: (view, t) =>
    dataFileGroups.flatMap((group): ProjectTreeNode[] => {
      const ids = (view.game && group.ids(view.game)) ?? []

      return ids.length
        ? [
            {
              key: `data:${group.id}`,
              section: 'data',
              kind: 'data-group',
              label: t(`tree.files.${group.id}`),
              children: ids.map((id) => ({
                key: `data-file:${group.id}:${id}`,
                section: 'data',
                kind: 'data-file',
                id,
                parentId: group.id,
                label: id,
              })),
            },
          ]
        : []
    }),
}

export const projectTreeSections: readonly ProjectTreeSection[] = [
  {
    id: 'game',
    labelKey: 'project.properties',
    nodes: () => [],
  },
  {
    id: 'scenes',
    labelKey: 'tree.scenes',
    nodes: (view, t) => [
      ...view.scenes.map((scene): ProjectTreeNode => ({
        key: `scene:${scene.id}`,
        section: 'scenes',
        kind: 'scene',
        id: scene.id,
        label: sceneTreeLabel(view, scene),
        detail: `${t(scene.type === 'game' ? 'scene.game' : 'scene.standalone')}${view.game?.['initial-scene'] === scene.id ? ` · ${t('tree.startup')}` : ''}`,
        children: [
          ...scene.components.map((component): ProjectTreeNode => ({
            key: `component:${scene.id}:${component.id}`,
            section: 'scenes',
            kind: 'component',
            id: component.id,
            parentId: scene.id,
            label: component.id,
            detail: t(`tree.${component.type}`),
          })),
          {
            key: `component-new:${scene.id}`,
            section: 'scenes',
            kind: 'new-component',
            parentId: scene.id,
            label: t('component.add'),
          },
          {
            key: `graphic-new:${scene.id}`,
            section: 'scenes',
            kind: 'new-graphic',
            parentId: scene.id,
            label: t('tree.addGraphic'),
          },
        ],
      })),
      { key: 'scene-new', section: 'scenes', kind: 'new-scene', label: t('scene.add') },
    ],
  },
  {
    id: 'assets',
    labelKey: 'assets.heading',
    nodes: (view, t) => [
      ...(['images', 'parts', 'compositions'] as const).map((kind): ProjectTreeNode => ({
        key: `assets:${kind}`,
        section: 'assets',
        kind,
        label: t(`tree.${kind}`),
        children: Object.keys(view.assets?.[kind] ?? {}).map((id) => ({
          key: `asset:${id}`,
          section: 'assets',
          kind: 'asset',
          id,
          label: id,
        })),
      })),
      { key: 'asset-import', section: 'assets', kind: 'import', label: t('assets.import') },
      { key: 'asset-new', section: 'assets', kind: 'new-asset', label: t('tree.addDefinition') },
    ],
  },
]

export function buildProjectTree(
  view: ProjectView,
  t: Translate,
  sections: readonly ProjectTreeSection[] = projectTreeSections,
): ProjectTreeNode[] {
  return sections.map((section) => ({
    key: section.id,
    section: section.id,
    kind: 'section',
    label: t(section.labelKey),
    children: section.nodes(view, t),
  }))
}

/** Filtering retains ancestors and includes a whole branch when its parent matches. */
export function filterProjectTree(
  nodes: readonly ProjectTreeNode[],
  query: string,
): ProjectTreeNode[] {
  const search = query.trim().toLocaleLowerCase()

  return nodes.flatMap((node) => {
    if (
      !search ||
      `${node.label} ${node.id ?? ''} ${node.detail ?? ''}`.toLocaleLowerCase().includes(search)
    )
      return [node]
    const children = filterProjectTree(node.children ?? [], search)

    return children.length ? [{ ...node, children }] : []
  })
}

export function flattenProjectTree(nodes: readonly ProjectTreeNode[]): ProjectTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenProjectTree(node.children ?? [])])
}
