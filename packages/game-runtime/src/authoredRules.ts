import {
  getMapMovementCostMs,
  type GameRulesDefinition,
  type RuleText,
  type RuleValue,
} from '@ancadeba/schemas'
import type { ILogger } from '@ancadeba/utilities'
import type { ActionOutcome, GameRules } from './actions.js'
import type { GameData } from './gameData.js'
import type { GameInstance, IGameLifecycle } from './gameLifecycle.js'
import type { IGameInventory } from './inventory.js'
import { MapTradeState } from './tradeState.js'

type Scalar = string | number | boolean

type State = Map<string, State | Scalar>

function set(state: State, path: string[], value: Scalar): void {
  let node = state

  for (const segment of path.slice(0, -1)) {
    const current = node.get(segment)
    const child = current instanceof Map ? current : new Map<string, State | Scalar>()

    if (child !== current) node.set(segment, child)
    node = child
  }

  node.set(path.at(-1)!, value)
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

  get tradeState(): MapTradeState {
    return new MapTradeState(
      this.state,
      this.rules.state
        .filter((field) => typeof field.value === 'number')
        .map((field) => field.path),
    )
  }

  constructor(
    private readonly rules: GameRulesDefinition,
    private readonly data: GameData,
  ) {
    for (const { path, value } of rules.state) set(this.state, path, this.resolve(value))
    this.updateClock(0)

    if (rules.log)
      this.append(
        rules.log.initial.map((value) => this.resolve(value)),
        0,
      )
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
    const log = this.rules.log!
    const clock = this.rules.clock
    const prefix = clock ? `${clockText(clock.startMinute, worldTimeMs)}  ` : ''

    for (const text of texts) this.entries.unshift(prefix + text)
    this.entries.length = Math.min(log.capacity, this.entries.length)
    set(this.state, log.path, this.entries.join('\n'))
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

            let cost = 0

            const external = branch.effects.find(
              (effect) => effect.type === 'move-item' || effect.type === 'enter-scene',
            )

            if (external?.type === 'enter-scene') {
              const destination = data.scenes.get(external.scene)

              if (destination?.type !== 'game') return rejected('Invalid destination scene')

              if (external.mapView !== undefined) {
                const view = destination.components.find(({ id }) => id === external.mapView)

                const tileCost =
                  view?.type === 'map-view' && view.playerSpawn
                    ? getMapMovementCostMs(view.map, view.playerSpawn)
                    : undefined

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
                () => lifecycle.enterScene(external.scene),
                () => lifecycle.activeScene?.data.id === external.scene,
                logger,
              )
            }

            for (const { path, value } of writes) set(this.state, path, value)

            if (entries.length) this.append(entries, nextTime)

            this.updateClock(nextTime)

            return { status: 'applied', worldTimeCostMs: cost }
          },
        ]),
      ),
    }
  }
}
