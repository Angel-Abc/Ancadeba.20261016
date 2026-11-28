import {
  inventoryOwner,
  questRewardItemId,
  ruleStateType,
  type QuestDefinition,
  type QuestOperation,
  type StoryEffect,
  type RuleText,
  type InventoryItem,
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
  readonly outcome?: string | undefined
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

interface QuestRequestOptions {
  readonly capture?: StoryCapture | undefined
  readonly origin?: ActionOrigin | undefined
  readonly outcome?: string | undefined
}

export interface QuestRequest {
  readonly scene: SceneInstance
  readonly quest: string
  readonly outcome?: string | undefined
  readonly operation: QuestOperation
  readonly capture: StoryCapture
  readonly origin: ActionOrigin
}

interface ProposedFormState {
  readonly answers: ReadonlyMap<string, BindingValue>
  readonly pendingStart: () => boolean
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
  reason(
    scene: SceneInstance,
    quest: string,
    operation: QuestOperation,
    outcome?: string,
  ): string | undefined
  capture(scene: SceneInstance): StoryCapture
  request(
    scene: SceneInstance,
    quest: string,
    operation: QuestOperation,
    options?: QuestRequestOptions,
  ): void
  prepareEffects(
    scene: SceneInstance,
    effects: readonly StoryEffect[],
    proposal?: ProposedFormState,
  ): PreparedStory | undefined
  text(id: string): string
  settlementText(quest: QuestDefinition, outcome?: QuestDefinition['outcomes'][number]): string
  onChooseOutcome(listener: (scene: SceneInstance, quest: string) => void): () => void
  subscribeChanges(listener: () => void): () => void
}

interface QuestRecord {
  readonly index: number
  readonly completed: boolean
  readonly outcome?: string | undefined
}

/** Playthrough-owned quest progression and atomic hand-in/reward transactions. */
export class GameQuests implements IGameQuests {
  private records = new Map<string, QuestRecord>()
  private readonly choosers = new Set<(scene: SceneInstance, quest: string) => void>()
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

      if (
        (record.completed && record.index !== quest.stages.length - 1) ||
        (record.outcome !== undefined &&
          (!record.completed || !quest.outcomes.some(({ id }) => id === record.outcome))) ||
        (record.completed && quest.outcomes.length && !record.outcome)
      )
        throw new Error('Invalid saved quest outcome')
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
    inventory?: ReadonlyMap<string, InventoryItem>,
  ) {
    return {
      game: this.game,
      scene,
      ...(values && { values }),
      ...(inventory && { inventory }),
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
                : this.status(definition, records, scene, values, inventory),
              outcome: record?.outcome,
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
    inventory?: ReadonlyMap<string, InventoryItem>,
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
          matchesConditions(objective.when, this.facts(scene, records, values, inventory)) &&
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
    inventory?: ReadonlyMap<string, InventoryItem>,
  ): QuestSnapshot['status'] {
    const record = records.get(definition.id)

    if (!record) return 'not-started'

    if (record.completed) return 'completed'
    const items = inventory ?? new Map(this.game.inventory?.snapshot.map((item) => [item.id, item]))
    this.evaluating.add(definition.id)

    try {
      return record.index === definition.stages.length - 1 &&
        this.objectives(definition, record, scene, records, values, items).every(
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
      outcome: record?.outcome,
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
            ['outcome', record?.outcome ?? ''],
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

  private canHandIn(
    items: ReadonlyMap<string, InventoryItem>,
    entry: QuestDefinition['handIns'][number],
  ): boolean {
    const item = items.get(entry.item)

    return Boolean(
      item &&
      inventoryOwner(items, entry.item) === entry.owner &&
      item.placement.type !== 'equipped' &&
      !this.game.inventory?.isReserved?.(entry.item) &&
      ![...items.values()].some(
        (child) => child.placement.type === 'inside' && child.placement.container === entry.item,
      ),
    )
  }

  reason(
    scene: SceneInstance,
    id: string,
    operation: QuestOperation,
    outcome?: string,
  ): string | undefined {
    const definition = this.definition(id)

    if (!definition || !this.validScene(scene))
      return runtimeText(this.game.data, 'quest.unavailable')
    const status = this.status(definition)

    if (outcome !== undefined && operation !== 'turn-in') return definition.messages.unavailable

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

    if (definition.outcomes.length && !outcome) return
    const ending = definition.outcomes.find((entry) => entry.id === outcome)

    if (outcome && !ending) return definition.messages.unavailable

    if (ending && !matchesConditions(ending.when, this.facts(scene)))
      return ending.unavailableText
        ? this.resolveText(ending.unavailableText)
        : definition.messages.requirements
    const items = new Map(this.game.inventory?.snapshot.map((item) => [item.id, item]))

    if (
      [...definition.handIns, ...(ending?.handIns ?? [])].some(
        (entry) => !this.canHandIn(items, entry),
      )
    )
      return definition.messages.inventory

    return this.prepareEffects(scene, [{ type: 'complete-quest', quest: id, outcome }])
      ? undefined
      : definition.messages.rewards
  }

  request(
    scene: SceneInstance,
    quest: string,
    operation: QuestOperation,
    {
      capture = this.capture(scene),
      origin = { type: 'direct' },
      outcome,
    }: QuestRequestOptions = {},
  ): void {
    if (!this.validScene(scene)) return
    this.messages.publish('quest.request', { scene, quest, operation, capture, origin, outcome })
  }

  private execute(request: QuestRequest): void {
    const { scene, quest, operation, capture, outcome } = request

    if (
      !this.validScene(scene) ||
      this.capture(scene).signature !== capture.signature ||
      this.reason(scene, quest, operation, outcome)
    )
      return

    if (operation === 'track' || operation === 'untrack') {
      this.tracked = operation === 'track' ? quest : undefined
      this.revision++
      notifyStory([this.invalidate, ...this.listeners])

      return
    }

    if (operation === 'turn-in' && !outcome && this.definition(quest)?.outcomes.length) {
      for (const listener of this.choosers) listener(scene, quest)

      return
    }

    const prepared = this.prepareEffects(scene, [
      operation === 'start'
        ? { type: 'start-quest', quest }
        : { type: 'complete-quest', quest, outcome },
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

  prepareEffects(
    scene: SceneInstance,
    effects: readonly StoryEffect[],
    proposal?: ProposedFormState,
  ): PreparedStory | undefined {
    const currentScene = () =>
      this.validScene(scene) ||
      (scene.type === 'stand-alone' &&
        !scene.disposed &&
        !this.game.disposed &&
        !this.disposed &&
        !this.lifecycle.currentGame &&
        proposal?.pendingStart() === true)

    if (!currentScene()) return
    const records = new Map(this.records)
    const values = new Map(proposal?.answers)
    const items = new Map(this.game.inventory?.snapshot.map((item) => [item.id, item]))
    const paths = new Map<string, readonly string[]>()
    const originals = new Map<string, BindingValue | undefined>()
    const stats = new Set<string>()
    const create: InventoryItemSnapshot[] = []
    const remove: string[] = []
    const transfers: { item: string; destination: { type: 'carried'; owner: string } }[] = []
    const logs: string[] = []

    const isCounter = (value: BindingValue | undefined): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

    const assign = (
      path: readonly string[],
      value: BindingValue,
      operation: 'set-state' | 'reward',
    ) => {
      const key = JSON.stringify(path)
      const field = this.game.data.rules?.state.find((entry) => JSON.stringify(entry.path) === key)
      const before = this.bindings.read({ source: 'game.state', path })
      const stat = field && 'type' in field
      const original = before.status === 'resolved' ? before.value : undefined

      if (
        !field ||
        ruleStateType(field) !== typeof value ||
        (before.status !== 'resolved' && (!stat || field.value !== undefined)) ||
        (before.status === 'resolved' && typeof before.value !== typeof value) ||
        [this.game.data.rules?.clock?.path, this.game.data.rules?.log?.path].some(
          (reserved) => reserved && JSON.stringify(reserved) === key,
        ) ||
        (typeof value === 'number' && !Number.isFinite(value)) ||
        (operation === 'reward' && !stat && (!isCounter(original) || !isCounter(value)))
      )
        return false

      if (stat) stats.add(key)
      originals.set(key, original)
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
            'set-state',
          )
        )
          return
      } else if (effect.type === 'append-log') logs.push(this.resolveText(effect.text))
      else {
        const quest = this.definition(effect.quest)

        if (!quest) return
        // Effect-order checks may inspect provisional progress without retaining its cursors.
        const provisional = new Map(records)
        this.advance(provisional, scene, values, items)

        if (effect.type === 'start-quest') {
          if (
            records.has(quest.id) ||
            !matchesConditions(quest.when, this.facts(scene, provisional, values, items))
          )
            return
          records.set(quest.id, { index: 0, completed: false })
          continue
        }

        if (
          this.status(quest, provisional, scene, values, items) !== 'ready' ||
          !matchesConditions(quest.turnInWhen, this.facts(scene, provisional, values, items))
        )
          return

        const ending = quest.outcomes.find(({ id }) => id === effect.outcome)

        if ((quest.outcomes.length || effect.outcome) && !ending) return

        if (
          ending &&
          !matchesConditions(ending.when, this.facts(scene, provisional, values, items))
        )
          return

        const parts = ending ? [quest, ending] : [quest]

        for (const entry of parts.flatMap((part) => part.handIns)) {
          if (!this.canHandIn(items, entry)) return
          const item = items.get(entry.item)!

          if (entry.operation === 'consume') {
            remove.push(item.id)
            items.delete(item.id)
          } else if (entry.recipient) {
            transfers.push({
              item: item.id,
              destination: { type: 'carried', owner: entry.recipient },
            })
            items.set(item.id, { ...item, placement: { type: 'carried', owner: entry.recipient } })
          }
        }

        for (const part of parts) {
          for (const reward of part.rewards.numeric) {
            const key = JSON.stringify(reward.field.path)
            const before = this.bindings.read(reward.field)

            const current =
              values.get(key) ?? (before.status === 'resolved' ? before.value : undefined)

            if (
              reward.field.source !== 'game.state' ||
              typeof current !== 'number' ||
              !assign(reward.field.path.map(String), current + reward.amount, 'reward')
            )
              return
          }

          for (const reward of part.rewards.items) {
            if (!part.rewards.recipient) return

            const item: InventoryItemSnapshot = {
              id: questRewardItemId(quest.id, reward.id, part === quest ? undefined : part.id),
              itemType: reward.itemType,
              colors: { ...reward.colors },
              placement: { type: 'carried', owner: part.rewards.recipient },
            }

            if (items.has(item.id)) return
            create.push(item)
            items.set(item.id, item)
          }
        }

        records.set(quest.id, {
          index: quest.stages.length - 1,
          completed: true,
          ...(ending && { outcome: ending.id }),
        })
      }
    }

    const usesNumericAdapter = (key: string, value: number) =>
      !stats.has(key) && isCounter(originals.get(key)) && isCounter(value)

    const numeric = [...values].flatMap(([key, value]) =>
      paths.has(key) && typeof value === 'number' && usesNumericAdapter(key, value)
        ? [{ path: paths.get(key)!, expected: Number(originals.get(key)), value }]
        : [],
    )

    const scalars: StoryStateWrite[] = [...values].flatMap(([key, value]) =>
      paths.has(key) && (typeof value !== 'number' || !usesNumericAdapter(key, value))
        ? [{ path: paths.get(key)!, expected: originals.get(key), value }]
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
    const finalValues = new Map(values)

    for (const [path, value] of state?.values ?? []) finalValues.set(path, value)
    // Only completed transaction facts can advance the cursors that will be committed.
    this.advance(records, scene, finalValues, items)
    const signature = this.capture(scene).signature
    let committed = false
    let notified = false

    const current = () =>
      !committed &&
      currentScene() &&
      this.capture(scene).signature === signature &&
      (state?.isCurrent() ?? true) &&
      (scalar?.isCurrent() ?? true) &&
      (inventory?.isCurrent() ?? true)

    return {
      values: finalValues,
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
    inventory?: ReadonlyMap<string, InventoryItem>,
  ): void {
    for (const [id, original] of records) {
      const definition = this.definition(id)

      if (!definition || original.completed) continue
      let index = original.index

      while (
        index < definition.stages.length - 1 &&
        this.objectives(
          definition,
          { index, completed: false },
          scene,
          records,
          values,
          inventory,
        ).every((entry) => entry.complete)
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

    const ending = quest.outcomes.find(({ id }) => id === snapshot.outcome)

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
      ending?.label,
      ending?.description,
      this.settlementText(quest, ending),
      snapshot.reason,
    ]
      .filter(Boolean)
      .join('\n')
  }
  settlementText(quest: QuestDefinition, outcome?: QuestDefinition['outcomes'][number]): string {
    return (outcome ? [quest, outcome] : [quest])
      .flatMap((part) => [
        ...(part.handIns.length
          ? [
              quest.messages.handIn,
              ...part.handIns.map((entry) => {
                const type =
                  this.game.inventory?.snapshot.find((item) => item.id === entry.item)?.itemType ??
                  this.game.data.inventory?.items[entry.item]?.itemType

                return (type && this.game.data.inventory?.itemTypes[type]?.label) || entry.item
              }),
            ]
          : []),
        ...(part.rewards.items.length || part.rewards.numeric.length
          ? [
              quest.messages.reward,
              ...part.rewards.numeric.map((entry) => `${entry.label}: ${entry.amount}`),
              ...part.rewards.items.map(
                (entry) =>
                  this.game.data.inventory?.itemTypes[entry.itemType]?.label ?? entry.itemType,
              ),
            ]
          : []),
      ])
      .join('\n')
  }
  onChooseOutcome(listener: (scene: SceneInstance, quest: string) => void): () => void {
    this.choosers.add(listener)

    return () => this.choosers.delete(listener)
  }
  subscribeChanges(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }
  dispose(): void {
    this.disposed = true
    this.cleanups.splice(0).forEach((cleanup) => cleanup())
    this.choosers.clear()
    this.listeners.clear()
    this.records.clear()
  }
}
