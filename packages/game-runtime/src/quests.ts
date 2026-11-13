import {
  inventoryOwner,
  questRewardItemId,
  type QuestDefinition,
  type QuestOperation,
  type StoryEffect,
  type RuleText,
} from '@ancadeba/schemas'
import type { GameInstance, IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { IGameBindings, BindingValue } from './gameBindings.js'
import type { IStateTransactions } from './stateTransactions.js'
import type { IStoryStateTransactions, StoryStateWrite } from './storyState.js'
import type { InventoryItemSnapshot } from './inventory.js'
import type { IMessageBus } from '@ancadeba/utilities'
import type { EngineMessages } from './messages.js'
import type { ActionOrigin } from './actions.js'
import { matchesConditions, notifyStory } from './storyConditions.js'
import type { GameSave } from '@ancadeba/schemas'
import { runtimeText } from './runtimeText.js'

export interface QuestSnapshot {
  readonly id: string
  readonly status: 'not-started' | 'active' | 'ready' | 'completed'
  readonly stage: string | undefined
  readonly tracked: boolean
  readonly objectives: readonly {
    readonly id: string
    readonly label: string
    readonly complete: boolean
    readonly current?: number | undefined
    readonly target?: number | undefined
  }[]
  readonly reason: string | undefined
}

export interface StoryCapture {
  readonly signature: string
}

export interface QuestRequest {
  readonly scene: SceneInstance
  readonly quest: string
  readonly operation: QuestOperation
  readonly capture: StoryCapture
  readonly origin: ActionOrigin
}

export interface PreparedStory {
  readonly values: ReadonlyMap<string, BindingValue>
  isCurrent(): boolean
  commit(): void
  notify(): void
}

export interface IGameQuests {
  snapshot(id: string): QuestSnapshot | undefined
  definition(id: string): QuestDefinition | undefined
  readonly bindingValues: ReadonlyMap<string, ReadonlyMap<string, BindingValue>>
  selected(scene: SceneInstance, journal: string): string | undefined
  select(scene: SceneInstance, journal: string, quest?: string): void
  reason(scene: SceneInstance, quest: string, operation: QuestOperation): string | undefined
  capture(scene: SceneInstance): StoryCapture
  request(
    scene: SceneInstance,
    quest: string,
    operation: QuestOperation,
    capture?: StoryCapture,
    origin?: ActionOrigin,
  ): void
  prepareEffects(scene: SceneInstance, effects: readonly StoryEffect[]): PreparedStory | undefined
  text(id: string): string
  subscribeChanges(listener: () => void): () => void
}

interface QuestRecord {
  readonly index: number
  readonly completed: boolean
}

/** Playthrough-owned quest progression and atomic hand-in/reward transactions. */
export class GameQuests implements IGameQuests {
  private records = new Map<string, QuestRecord>()
  private tracked: string | undefined
  private readonly selections = new WeakMap<SceneInstance, Map<string, string>>()
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[] = []
  private queued = false
  private disposed = false
  private revision = 0
  private inventoryVersion = 0
  private lastPublished = ''
  private readonly evaluating = new Set<string>()

  save(): GameSave['quests'] {
    return { records: Object.fromEntries(this.records), tracked: this.tracked }
  }

  restore(save: GameSave['quests']): void {
    for (const [id, record] of Object.entries(save.records)) {
      const quest = this.definition(id)

      if (!quest || record.index >= quest.stages.length)
        throw new Error('Invalid saved quest stage')
    }

    if (save.tracked && !this.definition(save.tracked)) throw new Error('Invalid tracked quest')
    this.records = new Map(Object.entries(save.records))
    this.tracked = save.tracked
  }

  constructor(
    private readonly game: GameInstance,
    private readonly lifecycle: IGameLifecycle,
    private readonly bindings: IGameBindings,
    private readonly numeric: IStateTransactions | undefined,
    private readonly scalar: IStoryStateTransactions | undefined,
    private readonly messages: IMessageBus<EngineMessages>,
    private readonly invalidate: () => void,
  ) {
    this.cleanups.push(
      bindings.subscribeChanges(() => this.schedule()),
      lifecycle.subscribeSceneChanges(() => this.schedule()),
      messages.subscribe('quests.evaluate', () => {
        this.queued = false
        this.evaluate()
      }),
      messages.subscribe('quest.request', (request) => this.execute(request)),
    )

    if (game.inventory)
      this.cleanups.push(
        game.inventory.subscribeChanges(() => {
          this.inventoryVersion++
          this.schedule()
        }),
      )
  }

  start(): void {
    const unsubscribe = this.game.combat?.subscribeChanges(() => this.schedule())

    if (unsubscribe) this.cleanups.push(unsubscribe)
    this.schedule()
  }

  definition(id: string): QuestDefinition | undefined {
    return this.game.data.quests?.get(id)
  }

  private facts(
    scene: SceneInstance | undefined,
    records = this.records,
    values?: ReadonlyMap<string, BindingValue>,
  ) {
    return {
      game: this.game,
      scene,
      ...(values && { values }),
      quest: (id: string) => {
        const definition = this.definition(id)
        const record = records.get(id)

        return definition
          ? {
              status: this.evaluating.has(id)
                ? record?.completed
                  ? 'completed'
                  : record
                    ? 'active'
                    : 'not-started'
                : this.status(definition, records, scene, values),
              stage: record && definition.stages[record.index]?.id,
            }
          : undefined
      },
    }
  }

  private objectives(
    definition: QuestDefinition,
    record: QuestRecord,
    scene?: SceneInstance,
    records = this.records,
    values?: ReadonlyMap<string, BindingValue>,
  ) {
    return (definition.stages[record.index]?.objectives ?? []).map((objective) => {
      const result = objective.progress && this.bindings.read(objective.progress.binding)

      const pending =
        objective.progress?.binding.source === 'game.state'
          ? values?.get(JSON.stringify(objective.progress.binding.path))
          : undefined

      const current =
        typeof pending === 'number'
          ? pending
          : result?.status === 'resolved' && typeof result.value === 'number'
            ? result.value
            : undefined

      return Object.freeze({
        id: objective.id,
        label: objective.label,
        complete:
          matchesConditions(objective.when, this.facts(scene, records, values)) &&
          (!objective.progress || (current !== undefined && current >= objective.progress.target)),
        ...(objective.progress && { current, target: objective.progress.target }),
      })
    })
  }

  private status(
    definition: QuestDefinition,
    records = this.records,
    scene = this.lifecycle.activeScene,
    values?: ReadonlyMap<string, BindingValue>,
  ): QuestSnapshot['status'] {
    const record = records.get(definition.id)

    if (!record) return 'not-started'

    if (record.completed) return 'completed'
    const items = new Map(this.game.inventory?.snapshot.map((item) => [item.id, item]))
    this.evaluating.add(definition.id)

    try {
      return record.index === definition.stages.length - 1 &&
        this.objectives(definition, record, scene, records, values).every(
          (entry) => entry.complete,
        ) &&
        definition.handIns.every((entry) => inventoryOwner(items, entry.item) === entry.owner)
        ? 'ready'
        : 'active'
    } finally {
      this.evaluating.delete(definition.id)
    }
  }

  snapshot(id: string): QuestSnapshot | undefined {
    const definition = this.definition(id)

    if (!definition || this.disposed) return
    const record = this.records.get(id)
    const status = this.status(definition)

    return Object.freeze({
      id,
      status,
      stage: record && definition.stages[record.index]?.id,
      tracked: this.tracked === id,
      objectives: Object.freeze(
        record ? this.objectives(definition, record, this.lifecycle.activeScene) : [],
      ),
      reason:
        status === 'ready' && this.lifecycle.activeScene
          ? this.reason(this.lifecycle.activeScene, id, 'turn-in')
          : undefined,
    })
  }

  get bindingValues(): ReadonlyMap<string, ReadonlyMap<string, BindingValue>> {
    return new Map(
      [...(this.game.data.quests?.keys() ?? [])].map((id) => {
        const definition = this.definition(id)!
        const record = this.records.get(id)

        return [
          id,
          new Map<string, BindingValue>([
            ['status', this.status(definition)],
            ['stage', record ? (definition.stages[record.index]?.id ?? '') : ''],
            ['tracked', this.tracked === id],
          ]),
        ]
      }),
    )
  }

  selected(scene: SceneInstance, journal: string): string | undefined {
    return this.selections.get(scene)?.get(journal)
  }
  select(scene: SceneInstance, journal: string, quest?: string): void {
    if (!this.validScene(scene)) return

    const component = scene.data.components.find(
      (entry) => entry.type === 'quest-log' && entry.id === journal,
    )

    if (
      component?.type !== 'quest-log' ||
      (quest &&
        (!this.definition(quest) || (component.quests && !component.quests.includes(quest))))
    )
      return
    const selections = this.selections.get(scene) ?? new Map<string, string>()

    if (quest) selections.set(journal, quest)
    else selections.delete(journal)
    this.selections.set(scene, selections)
    notifyStory(this.listeners)
  }

  private validScene(scene: SceneInstance): boolean {
    return (
      !this.disposed &&
      !scene.disposed &&
      scene === this.lifecycle.activeScene &&
      scene.type === 'game' &&
      scene.game === this.game
    )
  }

  capture(scene: SceneInstance): StoryCapture {
    const fields = [
      ...(this.game.data.rules?.state ?? []),
      ...(this.game.data.rules?.clock ? [{ path: this.game.data.rules.clock.path }] : []),
      ...(this.game.data.rules?.log ? [{ path: this.game.data.rules.log.path }] : []),
    ].map((field) => this.bindings.read({ source: 'game.state', path: field.path }))

    return Object.freeze({
      signature: JSON.stringify([
        this.revision,
        this.inventoryVersion,
        scene.disposed,
        [...(this.selections.get(scene) ?? [])],
        fields,
        this.game.inventory?.snapshot,
        this.game.inventory?.snapshot.map((item) => this.game.inventory?.isReserved?.(item.id)),
        [...(this.game.data.combat?.keys() ?? [])].map((id) => this.game.combat?.outcome?.(id)),
      ]),
    })
  }

  reason(scene: SceneInstance, id: string, operation: QuestOperation): string | undefined {
    const definition = this.definition(id)

    if (!definition || !this.validScene(scene))
      return runtimeText(this.game.data, 'quest.unavailable')
    const status = this.status(definition)

    if (operation === 'track')
      return status === 'not-started' || this.tracked === id
        ? definition.messages.unavailable
        : undefined

    if (operation === 'untrack')
      return this.tracked === id ? undefined : definition.messages.unavailable

    if (operation === 'start')
      return status === 'not-started' && matchesConditions(definition.when, this.facts(scene))
        ? undefined
        : definition.messages.accept

    if (status !== 'ready' || !matchesConditions(definition.turnInWhen, this.facts(scene)))
      return definition.messages.requirements

    return this.prepareEffects(scene, [{ type: 'complete-quest', quest: id }])
      ? undefined
      : definition.messages.rewards
  }

  request(
    scene: SceneInstance,
    quest: string,
    operation: QuestOperation,
    capture = this.capture(scene),
    origin: ActionOrigin = { type: 'direct' },
  ): void {
    if (!this.validScene(scene)) return
    this.messages.publish('quest.request', { scene, quest, operation, capture, origin })
  }

  private execute(request: QuestRequest): void {
    const { scene, quest, operation, capture } = request

    if (
      !this.validScene(scene) ||
      this.capture(scene).signature !== capture.signature ||
      this.reason(scene, quest, operation)
    )
      return

    if (operation === 'track' || operation === 'untrack') {
      this.tracked = operation === 'track' ? quest : undefined
      this.revision++
      notifyStory([this.invalidate, ...this.listeners])

      return
    }

    const prepared = this.prepareEffects(scene, [
      { type: operation === 'start' ? 'start-quest' : 'complete-quest', quest },
    ])

    if (!prepared?.isCurrent()) return
    prepared.commit()
    prepared.notify()
  }

  resolveText(value: RuleText): string {
    if (typeof value === 'string') return value
    const translation = this.game.data.ruleTranslation

    return translation?.messages[value.textKey] ?? translation?.fallback[value.textKey] ?? ''
  }

  prepareEffects(scene: SceneInstance, effects: readonly StoryEffect[]): PreparedStory | undefined {
    if (!this.validScene(scene)) return
    const records = new Map(this.records)
    const values = new Map<string, BindingValue>()
    const paths = new Map<string, readonly string[]>()
    const originals = new Map<string, BindingValue>()
    const create: InventoryItemSnapshot[] = []
    const remove: string[] = []
    const transfers: { item: string; destination: { type: 'carried'; owner: string } }[] = []
    const logs: string[] = []

    const assign = (path: readonly string[], value: BindingValue) => {
      const key = JSON.stringify(path)
      const field = this.game.data.rules?.state.find((entry) => JSON.stringify(entry.path) === key)
      const before = this.bindings.read({ source: 'game.state', path })

      if (
        !field ||
        before.status !== 'resolved' ||
        typeof before.value !== typeof value ||
        [this.game.data.rules?.clock?.path, this.game.data.rules?.log?.path].some(
          (reserved) => reserved && JSON.stringify(reserved) === key,
        ) ||
        (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0))
      )
        return false
      originals.set(key, before.value)
      paths.set(key, [...path])
      values.set(key, value)

      return true
    }

    for (const effect of effects) {
      if (effect.type === 'set-state') {
        if (
          !assign(
            effect.path,
            typeof effect.value === 'object' ? this.resolveText(effect.value) : effect.value,
          )
        )
          return
      } else if (effect.type === 'append-log') logs.push(this.resolveText(effect.text))
      else {
        const quest = this.definition(effect.quest)

        if (!quest) return

        if (effect.type === 'start-quest') {
          if (
            records.has(quest.id) ||
            !matchesConditions(quest.when, this.facts(scene, records, values))
          )
            return
          records.set(quest.id, { index: 0, completed: false })
          this.advance(records, scene, values)
          continue
        }

        if (
          this.status(quest, records, scene, values) !== 'ready' ||
          !matchesConditions(quest.turnInWhen, this.facts(scene, records, values))
        )
          return
        const inventory = new Map(this.game.inventory?.snapshot.map((item) => [item.id, item]))

        for (const entry of quest.handIns) {
          const item = inventory.get(entry.item)

          if (
            !item ||
            inventoryOwner(inventory, entry.item) !== entry.owner ||
            item.placement.type === 'equipped' ||
            this.game.inventory?.isReserved?.(item.id) ||
            [...inventory.values()].some(
              (child) => child.placement.type === 'inside' && child.placement.container === item.id,
            )
          )
            return

          if (entry.operation === 'consume') remove.push(item.id)
          else if (entry.recipient)
            transfers.push({
              item: item.id,
              destination: { type: 'carried', owner: entry.recipient },
            })
        }

        for (const reward of quest.rewards.numeric) {
          const key = JSON.stringify(reward.field.path)
          const before = this.bindings.read(reward.field)

          const current =
            values.get(key) ?? (before.status === 'resolved' ? before.value : undefined)

          if (
            reward.field.source !== 'game.state' ||
            typeof current !== 'number' ||
            !assign(reward.field.path.map(String), current + reward.amount)
          )
            return
        }

        for (const reward of quest.rewards.items) {
          if (!quest.rewards.recipient) return
          create.push({
            id: questRewardItemId(quest.id, reward.id),
            itemType: reward.itemType,
            colors: { ...reward.colors },
            placement: { type: 'carried', owner: quest.rewards.recipient },
          })
        }

        records.set(quest.id, { index: quest.stages.length - 1, completed: true })
      }
    }

    this.advance(records, scene, values)

    const numeric = [...values].flatMap(([key, value]) =>
      typeof value === 'number' && typeof originals.get(key) === 'number'
        ? [{ path: paths.get(key)!, expected: Number(originals.get(key)), value }]
        : [],
    )

    const scalars: StoryStateWrite[] = [...values].flatMap(([key, value]) =>
      typeof value !== 'number'
        ? [
            {
              path: paths.get(key)!,
              expected:
                typeof value === 'boolean'
                  ? Boolean(originals.get(key))
                  : String(originals.get(key)),
              value,
            },
          ]
        : [],
    )

    const state = numeric.length ? this.numeric?.prepare(numeric) : undefined
    const scalar = scalars.length || logs.length ? this.scalar?.prepare(scalars, logs) : undefined
    const changedInventory = Boolean(create.length || remove.length || transfers.length)

    const inventory = changedInventory
      ? this.game.inventory?.prepareTransaction?.({ create, remove, transfers })
      : undefined

    if (
      (numeric.length && !state) ||
      ((scalars.length || logs.length) && !scalar) ||
      (changedInventory && !inventory)
    )
      return
    const signature = this.capture(scene).signature
    let committed = false
    let notified = false

    const current = () =>
      !committed &&
      this.validScene(scene) &&
      this.capture(scene).signature === signature &&
      (state?.isCurrent() ?? true) &&
      (scalar?.isCurrent() ?? true) &&
      (inventory?.isCurrent() ?? true)

    return {
      values,
      isCurrent: current,
      commit: () => {
        if (!current()) return
        inventory?.commit()
        state?.commit()
        scalar?.commit()
        this.records = records
        this.revision++
        committed = true
      },
      notify: () => {
        if (!committed || notified) return
        notified = true
        notifyStory([() => inventory?.notify(), this.invalidate, ...this.listeners])
      },
    }
  }

  private advance(
    records: Map<string, QuestRecord>,
    scene?: SceneInstance,
    values?: ReadonlyMap<string, BindingValue>,
  ): void {
    for (const [id, original] of records) {
      const definition = this.definition(id)

      if (!definition || original.completed) continue
      let index = original.index

      while (
        index < definition.stages.length - 1 &&
        this.objectives(definition, { index, completed: false }, scene, records, values).every(
          (entry) => entry.complete,
        )
      )
        index++

      if (index !== original.index) records.set(id, { index, completed: false })
    }
  }

  private schedule(): void {
    if (this.disposed || this.queued) return
    this.queued = true
    this.messages.publish('quests.evaluate', {})
  }
  private evaluate(): void {
    const records = new Map(this.records)
    this.advance(records, this.lifecycle.activeScene)
    const changed = [...records].some(([id, record]) => record !== this.records.get(id))
    this.records = records

    if (changed) this.revision++

    const signature = JSON.stringify(
      [...this.bindingValues].map(([id, values]) => [id, [...values]]),
    )

    const invalidate = this.lastPublished !== signature
    this.lastPublished = signature
    notifyStory([...(invalidate ? [this.invalidate] : []), ...this.listeners])
  }

  text(id: string): string {
    const quest = this.definition(id)
    const snapshot = this.snapshot(id)

    if (!quest || !snapshot) return ''
    const stage = quest.stages.find((entry) => entry.id === snapshot.stage)

    return [
      quest.label,
      quest.description,
      quest.messages[snapshot.status],
      stage?.label,
      stage?.description,
      ...snapshot.objectives.map(
        (entry) =>
          `${entry.complete ? '✓' : '○'} ${entry.label}${entry.target !== undefined ? ` (${entry.current ?? '?'}/${entry.target})` : ''}`,
      ),
      ...(quest.handIns.length
        ? [quest.messages.handIn, ...quest.handIns.map((entry) => entry.item)]
        : []),
      ...(quest.rewards.items.length || quest.rewards.numeric.length
        ? [
            quest.messages.reward,
            ...quest.rewards.numeric.map((entry) => `${entry.label}: ${entry.amount}`),
            ...quest.rewards.items.map(
              (entry) =>
                this.game.data.inventory?.itemTypes[entry.itemType]?.label ?? entry.itemType,
            ),
          ]
        : []),
      snapshot.reason,
    ]
      .filter(Boolean)
      .join('\n')
  }
  subscribeChanges(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }
  dispose(): void {
    this.disposed = true
    this.cleanups.splice(0).forEach((cleanup) => cleanup())
    this.listeners.clear()
    this.records.clear()
  }
}
