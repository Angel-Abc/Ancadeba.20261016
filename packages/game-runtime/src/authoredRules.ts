import {
  sceneEntrance,
  ruleStateType,
  type GameRulesDefinition,
  type RuleText,
  type RuleValue,
} from '@ancadeba/schemas'
import type { ILogger } from '@ancadeba/utilities'
import type { ActionOutcome, GameRules } from './actions.js'
import { sceneEntranceCost } from './sceneNavigation.js'
import type { GameData } from './gameData.js'
import type { GameInstance, IGameLifecycle } from './gameLifecycle.js'
import type { IGameInventory } from './inventory.js'
import { matchesConditions } from './storyConditions.js'
import { MapStoryState } from './storyState.js'
import { preparePatrolWarnings } from './mapMovement.js'
import { MapStateTransactions } from './stateTransactions.js'
import { prepareInventoryCollection } from './inventoryCollection.js'
import type { GameSave } from '@ancadeba/schemas'
import type { GameMessageHistory } from './messageHistory.js'

type Scalar = string | number | boolean

type State = Map<string, State | Scalar>

function parent(state: State, path: readonly string[]): State {
  let node = state

  for (const segment of path.slice(0, -1)) {
    const current = node.get(segment)
    const child = current instanceof Map ? current : new Map<string, State | Scalar>()

    if (child !== current) node.set(segment, child)
    node = child
  }

  return node
}

function set(state: State, path: readonly string[], value: Scalar): void {
  parent(state, path).set(path.at(-1)!, value)
}

function read(state: State, path: string[]): State | Scalar | undefined {
  let value: State | Scalar | undefined = state

  for (const segment of path) value = value instanceof Map ? value.get(segment) : undefined

  return value
}

function clockText(startMinute: number, worldTimeMs: number): string {
  const minute = (startMinute + Math.floor(worldTimeMs / 60_000)) % 1440

  return [Math.floor(minute / 60), minute % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

function rejected(reason: string): ActionOutcome {
  return { status: 'rejected', reason }
}

function carriedOwner(inventory: IGameInventory | undefined, item: string): string | undefined {
  const placement = inventory?.snapshot.find(({ id }) => id === item)?.placement

  return placement?.type === 'carried' ? placement.owner : undefined
}

function completeCommittedEffect<T>(
  apply: () => T,
  committed: () => boolean,
  logger: ILogger,
): T | undefined {
  try {
    return apply()
  } catch (error) {
    if (!committed()) throw error
    // Inventory and scene observers can throw after the underlying effect has committed.
    logger.error('AuthoredRules', 'Rule effect committed but a notification failed', error)

    return undefined
  }
}

export class AuthoredPlaythrough {
  readonly state: State = new Map()
  private readonly entries: string[] = []

  save(): Pick<GameSave, 'state' | 'log'> {
    return {
      state: this.rules.state.flatMap((field) => {
        const { path } = field
        const value = read(this.state, path)

        if (value === undefined && 'type' in field && field.value === undefined) return []

        if (typeof value !== ruleStateType(field) || value === undefined || value instanceof Map)
          throw new Error('Invalid authored state')

        return [{ path: [...path], value }]
      }),
      log: [...this.entries],
    }
  }

  restore(save: Pick<GameSave, 'state' | 'log' | 'progression'>): void {
    if (
      save.state.length > this.rules.state.length ||
      save.log.length > (this.rules.log?.capacity ?? 0)
    )
      throw new Error('Incompatible authored state')
    const fields = new Map(save.state.map((field) => [JSON.stringify(field.path), field]))

    if (fields.size !== save.state.length) throw new Error('Duplicate saved state field')

    for (const field of this.rules.state) {
      const key = JSON.stringify(field.path)
      const saved = fields.get(key)

      if (!saved && 'type' in field && field.value === undefined) {
        parent(this.state, field.path).delete(field.path.at(-1)!)
        continue
      }

      if (!saved || typeof saved.value !== ruleStateType(field))
        throw new Error('Incompatible state field')
      set(this.state, field.path, saved.value)
      fields.delete(key)
    }

    if (fields.size) throw new Error('Unknown saved state field')

    this.entries.splice(0, this.entries.length, ...save.log)

    if (this.rules.log) set(this.state, this.rules.log.path, this.entries.join('\n'))
    this.updateClock(save.progression.worldTimeMs)
  }

  get stateTransactions(): MapStateTransactions {
    return new MapStateTransactions(
      this.state,
      this.rules.state
        .filter((field) => typeof field.value === 'number')
        .map((field) => field.path),
    )
  }

  get storyState(): MapStoryState {
    return new MapStoryState(
      this.state,
      this.rules.state
        .filter(
          (field) =>
            ![this.rules.log?.path, this.rules.clock?.path].some(
              (path) => JSON.stringify(path) === JSON.stringify(field.path),
            ),
        )
        .map((field) => field.path),
      {
        prepare: (entries) => {
          const log = this.rules.log

          if (!log) return
          const before = [...this.entries]
          const clock = this.rules.clock && read(this.state, this.rules.clock.path)

          const messages = entries.map((text) =>
            typeof clock === 'string' ? `${clock}  ${text}` : text,
          )

          return {
            isCurrent: () => JSON.stringify(this.entries) === JSON.stringify(before),
            commit: () => {
              this.appendMessages(messages)
            },
          }
        },
      },
    )
  }

  constructor(
    private readonly rules: GameRulesDefinition,
    private readonly data: GameData,
    readonly history?: GameMessageHistory,
  ) {
    for (const { path, value } of rules.state) {
      if (value === undefined) parent(this.state, path)
      else set(this.state, path, this.resolve(value))
    }

    this.updateClock(0)

    if (rules.log)
      this.append(
        rules.log.initial.map((value) => this.resolve(value)),
        0,
      )
  }

  prepareFormWrites(
    writes: readonly { path: string[]; value: RuleValue }[],
    logs: readonly { text: RuleText }[],
  ) {
    const resolved = writes.map((write) => ({ path: write.path, value: this.resolve(write.value) }))
    const entries = logs.map((entry) => this.resolve(entry.text))

    return {
      values: new Map(resolved.map((write) => [JSON.stringify(write.path), write.value])),
      commit: (time: number) => {
        for (const write of resolved) set(this.state, write.path, write.value)

        if (entries.length) this.append(entries, time)
      },
    }
  }

  private resolve(value: RuleText): string
  private resolve(value: RuleValue): Scalar
  private resolve(value: RuleValue): Scalar {
    if (typeof value !== 'object') return value
    const { textKey } = value
    const translation = this.data.ruleTranslation

    if (translation && Object.hasOwn(translation.messages, textKey))
      return translation.messages[textKey]!

    if (translation && Object.hasOwn(translation.fallback, textKey))
      return translation.fallback[textKey]!
    throw new Error(`Missing default translation: ${textKey}`)
  }

  updateClock(worldTimeMs: number): void {
    const clock = this.rules.clock

    if (clock) set(this.state, clock.path, clockText(clock.startMinute, worldTimeMs))
  }

  private append(texts: string[], worldTimeMs: number): void {
    const clock = this.rules.clock
    const prefix = clock ? `${clockText(clock.startMinute, worldTimeMs)}  ` : ''

    this.appendMessages(texts.map((text) => prefix + text))
  }

  private appendMessages(messages: readonly string[]): void {
    const log = this.rules.log!

    for (const text of messages) this.entries.unshift(text)
    this.entries.length = Math.min(log.capacity, this.entries.length)
    set(this.state, log.path, this.entries.join('\n'))
    this.history?.append('narration', messages)
  }

  createRules(
    data: GameData,
    game: GameInstance,
    lifecycle: IGameLifecycle,
    logger: ILogger,
  ): GameRules {
    return {
      handlers: new Map(
        Object.entries(this.rules.actions).map(([id, branches]) => [
          id,
          (request, { progression }) => {
            const inventory = game.inventory
            const scene = lifecycle.activeScene?.data.id

            const branch = branches.find(({ when }) =>
              when.every((condition) => {
                switch (condition.type) {
                  case 'state-compare':
                  case 'item-owned-by':
                  case 'quest-outcome':
                  case 'quest-state':
                  case 'combat-outcome':
                    return matchesConditions([condition], { game, scene: lifecycle.activeScene })
                  case 'scene-is':
                    return scene === condition.scene
                  case 'state-is':
                    return read(this.state, condition.path) === condition.value
                  case 'payload-is-item':
                    return request.payload === condition.item
                  case 'payload-is-target':
                    return request.payload === condition.target
                  case 'item-carried-by':
                    return carriedOwner(inventory, condition.item) === condition.owner
                }
              }),
            )

            if (!branch) return rejected(`No matching branch for action ${id}`)

            const warnPatrols = preparePatrolWarnings(branch.effects, game.mapMovement)

            if (
              branch.effects.some(
                (effect) => effect.type === 'start-quest' || effect.type === 'complete-quest',
              )
            ) {
              const origin = lifecycle.activeScene

              if (
                !origin ||
                branch.effects.some(
                  (effect) =>
                    effect.type === 'move-map-object' ||
                    effect.type === 'move-item' ||
                    effect.type === 'collect-items' ||
                    effect.type === 'enter-scene',
                )
              )
                return rejected('Quest transactions cannot include movement effects')

              const effects = branch.effects.filter(
                (effect) =>
                  effect.type !== 'move-map-object' &&
                  effect.type !== 'warn-patrol' &&
                  effect.type !== 'move-item' &&
                  effect.type !== 'collect-items' &&
                  effect.type !== 'enter-scene',
              )

              const prepared = game.quests?.prepareEffects(origin, effects)

              if (!prepared?.isCurrent()) return rejected('Quest transaction is unavailable')
              prepared.commit()
              warnPatrols()
              completeCommittedEffect(
                () => prepared.notify(),
                () => true,
                logger,
              )

              return {
                status: 'applied',
                worldTimeCostMs: 0,
                spendsPlayerTurn: branch.spendsPlayerTurn === true,
              }
            }

            let cost = 0

            const external = branch.effects.find(
              (effect) =>
                effect.type === 'move-map-object' ||
                effect.type === 'move-item' ||
                effect.type === 'collect-items' ||
                effect.type === 'enter-scene',
            )

            const step =
              external?.type === 'move-map-object'
                ? game.mapMovement?.prepareObjectStep(
                    external.map,
                    external.object,
                    external.direction,
                  )
                : undefined

            if (external?.type === 'move-map-object' && !step?.isCurrent())
              return rejected('Map object cannot enter that tile')

            if (external?.type === 'enter-scene') {
              const destination = data.scenes.get(external.scene)

              if (destination?.type !== 'game') return rejected('Invalid destination scene')

              if (external.mapView !== undefined) {
                const tileCost = sceneEntranceCost(data, external, game.mapMovement)

                if (tileCost === undefined) return rejected('The destination is not reachable')
                cost = tileCost
              }
            }

            const nextTime = progression.worldTimeMs + cost

            if (!Number.isSafeInteger(nextTime))
              return rejected('World time would exceed its supported range')

            const writes: { path: string[]; value: Scalar }[] = []
            const entries: string[] = []

            for (const effect of branch.effects) {
              if (effect.type === 'set-state')
                writes.push({ path: effect.path, value: this.resolve(effect.value) })

              if (effect.type === 'append-log') entries.push(this.resolve(effect.text))
            }

            if (external?.type === 'move-item') {
              if (!inventory || carriedOwner(inventory, external.item) === undefined)
                return rejected('Item is not carried')

              const result = completeCommittedEffect(
                () => inventory.move(external.item, { type: 'carried', owner: external.owner }),
                () => carriedOwner(inventory, external.item) === external.owner,
                logger,
              )

              if (result?.status === 'rejected') return result
            } else if (external?.type === 'enter-scene') {
              completeCommittedEffect(
                () => lifecycle.enterScene(external.scene, sceneEntrance(external)),
                () => {
                  const scene = lifecycle.activeScene

                  if (scene?.data.id !== external.scene) return false

                  if (!external.position || !external.mapView) return true
                  const position = game.mapMovement?.getPosition(scene, external.mapView)

                  return (
                    position?.x === external.position.x &&
                    position.y === external.position.y &&
                    (!external.map || game.mapMovement?.playerMap === external.map)
                  )
                },
                logger,
              )
            }

            const collection =
              external?.type === 'collect-items'
                ? prepareInventoryCollection(inventory, external.items, external.owner)
                : undefined

            if (external?.type === 'collect-items' && !collection?.isCurrent())
              return rejected('Inventory pickup is unavailable')
            step?.commit()
            collection?.commit()
            warnPatrols()

            for (const { path, value } of writes) set(this.state, path, value)

            if (entries.length) this.append(entries, nextTime)

            this.updateClock(nextTime)

            if (step)
              completeCommittedEffect(
                () => step.notify(),
                () => true,
                logger,
              )

            if (collection)
              completeCommittedEffect(
                () => collection.notify(),
                () => true,
                logger,
              )

            return {
              status: 'applied',
              worldTimeCostMs: cost,
              spendsPlayerTurn: branch.spendsPlayerTurn === true,
            }
          },
        ]),
      ),
    }
  }
}
