import { combatMoveRequirementIssue } from './combatRequirements.js'
import { combatActorMoves, validateCombatEquipment } from './combatEquipment.js'
import type { CombatEquipment } from '@ancadeba/schemas'
import type { InventoryDefinition, CombatSimulationLoadout } from '@ancadeba/schemas'
import { applyCombatSimulationLoadout } from './combatSimulationLoadout.js'
import { combatValueContext } from './combatValues.js'
import { combatMoveRestriction, combatMoveRestrictionText } from './combatRestrictions.js'
import {
  cloneCombatRules,
  combatDefinitionSchema,
  freezeCombatDefinition,
  combatBonusesSchema,
  type CombatDefinition,
  type CombatBonuses,
} from '@ancadeba/schemas'
import {
  combatActorEconomy,
  combatActionCost,
  combatEconomySnapshot,
} from './combatActionEconomy.js'
import {
  combatMoveTarget,
  combatStunned,
  cooldownRemaining,
  type CombatStatuses,
  type CombatCooldowns,
} from './combatEffects.js'
import {
  combatResourceIssue,
  initialCombatMechanics,
  validateCombatMechanicsState,
} from './combatMechanics.js'
import { validateActiveCombatStatus } from './combatStatusStacking.js'
import {
  planEnemies,
  resolveCombatRound,
  combatOutcome,
  type PlannedMove,
} from './combatResolution.js'
import type { CombatDebugFrame, EnemyDecisionTrace } from './combatDebug.js'

export interface CombatSimulationSetup {
  readonly loadout?: CombatSimulationLoadout | undefined
  readonly equipmentContext?:
    | {
        readonly inventory: InventoryDefinition
        readonly baseStats: Readonly<Record<string, CombatBonuses>>
        readonly level?: number | undefined
      }
    | undefined
  readonly equipment?: CombatEquipment | undefined
  readonly health: Readonly<Record<string, number>>
  readonly maximumHealth: Readonly<Record<string, number>>
  readonly stats?: Readonly<Record<string, CombatBonuses>>
  readonly availableMoves?: readonly string[]
  readonly resources?: Readonly<Record<string, number>>
  readonly phase?: string
  readonly statuses?: CombatStatuses
  readonly cooldowns?: CombatCooldowns
  readonly seed?: number
  readonly round?: number
}

export type CombatSimulationState = ReturnType<typeof initialState>

function initialState(definition: CombatDefinition, setup: CombatSimulationSetup) {
  validateCombatEquipment(definition, setup.equipment)
  const actors = [definition.player, ...definition.enemies]
  const ids = new Set(actors.map((actor) => actor.id))
  const seed = setup.seed ?? definition.seed
  const round = setup.round ?? 1

  if (
    !Number.isSafeInteger(seed) ||
    seed < 1 ||
    seed > 0xffffffff ||
    !Number.isSafeInteger(round) ||
    round < 1
  )
    throw new Error('Invalid simulation seed or round')

  for (const actor of actors) {
    const hp = setup.health[actor.id]
    const maximum = setup.maximumHealth[actor.id]

    if (
      maximum === undefined ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      hp === undefined ||
      !Number.isSafeInteger(hp) ||
      hp < 0 ||
      hp > maximum
    )
      throw new Error(`Invalid simulation health: ${actor.id}`)

    if (setup.stats?.[actor.id]) combatBonusesSchema.parse(setup.stats[actor.id])
  }

  for (const [id, statuses] of Object.entries(setup.statuses ?? {})) {
    if (!ids.has(id) || new Set(statuses.map((status) => status.id)).size !== statuses.length)
      throw new Error('Invalid simulation status owner or duplicate')

    for (const active of statuses) {
      const status = definition.statuses?.[active.id]

      if (!status || !ids.has(active.source)) throw new Error('Invalid simulation status reference')
      validateActiveCombatStatus(status, active)
    }
  }

  for (const [actor, moves] of Object.entries(setup.cooldowns ?? {}))
    for (const [move, until] of Object.entries(moves))
      if (!ids.has(actor) || !definition.moves[move] || !Number.isSafeInteger(until) || until < 0)
        throw new Error('Invalid simulation cooldown')
  const mechanics = initialCombatMechanics(definition)

  if (mechanics) {
    for (const [id, value] of Object.entries(setup.resources ?? {})) {
      if (!Object.hasOwn(mechanics.resources, id))
        throw new Error(`Unknown simulation resource: ${id}`)
      mechanics.resources[id] = value
    }

    if (setup.phase !== undefined) mechanics.phase = setup.phase
  } else if (setup.phase !== undefined || Object.keys(setup.resources ?? {}).length)
    throw new Error('Encounter has no simulation mechanics')
  validateCombatMechanicsState(definition, mechanics)
  combatEconomySnapshot(definition, setup.statuses ?? {}, mechanics?.resources)
  const statuses = cloneCombatRules(setup.statuses ?? {})
  const cooldowns = cloneCombatRules(setup.cooldowns ?? {})
  const health = { ...setup.health }

  const enemies = planEnemies(
    definition,
    health,
    {},
    round,
    statuses,
    cooldowns,
    mechanics,
    undefined,
    setup.maximumHealth,
    setup.equipment,
  )

  const guard: Record<string, number> = {}
  const plan: PlannedMove[] = []

  return {
    round,
    seed,
    health,
    guard,
    statuses,
    cooldowns,
    mechanics,
    enemies,
    plan,
    outcome: combatOutcome(definition, health),
  }
}

/** Combat-only sandbox: candidates, history and RNG are separate from any live game or documents. */
export class CombatSimulation {
  readonly definition: CombatDefinition
  private readonly setup: CombatSimulationSetup
  private current: CombatSimulationState
  private frames: CombatDebugFrame[] = []
  private truncated = false
  private inputs: { round: number; plan: PlannedMove[]; escape: boolean }[] = []

  constructor(
    definition: CombatDefinition,
    setup: CombatSimulationSetup,
    private readonly traceLimit = 500,
  ) {
    if (!Number.isInteger(traceLimit) || traceLimit < 1 || traceLimit > 2000)
      throw new Error('Simulation trace limit must be 1–2000')
    this.definition = freezeCombatDefinition(combatDefinitionSchema.parse(definition))
    this.setup = applyCombatSimulationLoadout(this.definition, cloneCombatRules(setup))
    this.current = initialState(this.definition, this.setup)
  }

  snapshot() {
    return cloneCombatRules(this.current)
  }
  get completedRounds() {
    return this.inputs.length
  }
  trace() {
    return cloneCombatRules(this.frames)
  }
  reset() {
    this.current = initialState(this.definition, this.setup)
    this.frames = []
    this.inputs = []
    this.truncated = false
  }

  preview() {
    const decisions: EnemyDecisionTrace[] = []

    if (this.current.outcome) return decisions

    const cursors = Object.fromEntries(
      Object.entries(this.current.enemies).map(([id, plan]) => [
        id,
        plan.startCursor ?? plan.cursor,
      ]),
    )

    planEnemies(
      this.definition,
      this.current.health,
      cursors,
      this.current.round,
      this.current.statuses,
      this.current.cooldowns,
      this.current.mechanics,
      (decision) => {
        if (decisions.length < this.traceLimit) decisions.push(decision)
      },
      this.setup.maximumHealth,
      this.setup.equipment,
    )

    return cloneCombatRules(decisions)
  }

  queueIssue(moveId: string, target?: string): string | undefined {
    const state = this.current
    const player = this.definition.player
    const move = this.definition.moves[moveId]

    if (state.outcome) return 'Combat has finished'

    if (
      !combatActorMoves(player, this.setup.equipment).includes(moveId) ||
      !(this.setup.availableMoves ?? combatActorMoves(player, this.setup.equipment)).includes(
        moveId,
      ) ||
      !move
    )
      return 'Move is unavailable or locked by level'

    if (combatStunned(this.definition, state.statuses[player.id])) return 'Player is stunned'

    const restriction = combatMoveRestriction(
      this.definition,
      player.id,
      move,
      state.statuses,
      this.setup.equipment,
    )

    if (restriction) return combatMoveRestrictionText(this.definition, player.id, move, restriction)

    if (
      combatMoveTarget(move) === 'enemy' &&
      !this.definition.enemies.some((enemy) => enemy.id === target && state.health[enemy.id]! > 0)
    )
      return 'Choose a living enemy target'

    const requirement = combatMoveRequirementIssue(
      this.definition,
      move,
      {
        health: state.health,
        maximumHealth: this.setup.maximumHealth,
        statuses: state.statuses,
        resources: state.mechanics?.resources ?? {},
        phase: state.mechanics?.phase,
        self: player.id,
        target: combatMoveTarget(move) === 'self' ? player.id : target,
      },
      state.plan,
    )

    if (requirement) return requirement

    if (cooldownRemaining(state.cooldowns, player.id, moveId, state.round))
      return 'Move is on cooldown'

    if (move.cooldown && state.plan.some((queued) => queued.move === moveId))
      return 'Cooldown move is already queued'
    const economy = combatActorEconomy(this.definition, player, state.statuses[player.id])

    const values = (target?: string) =>
      combatValueContext(
        this.definition,
        state.mechanics?.resources,
        state.statuses,
        player.id,
        target,
      )

    const spent = state.plan.reduce(
      (sum, queued) =>
        sum + combatActionCost(this.definition.moves[queued.move]!, economy, values(queued.target)),
      0,
    )

    if (
      combatActionCost(
        move,
        economy,
        values(combatMoveTarget(move) === 'self' ? player.id : target),
      ) >
      economy.ap - spent
    )
      return 'Insufficient AP'

    const resource = combatResourceIssue(
      move,
      state.mechanics?.resources ?? {},
      state.plan,
      this.definition.moves,
      values(combatMoveTarget(move) === 'self' ? player.id : target),
    )

    if (resource) return `Insufficient resource: ${resource}`
  }

  queue(move: string, target?: string) {
    const issue = this.queueIssue(move, target)

    if (issue) throw new Error(issue)
    this.current.plan.push({
      move,
      target:
        combatMoveTarget(this.definition.moves[move]!) === 'self'
          ? this.definition.player.id
          : target!,
    })
  }
  undo() {
    this.current.plan.pop()
  }
  clear() {
    this.current.plan = []
  }

  resolve(escape = false) {
    if (this.current.outcome) throw new Error('Combat has finished')

    if (escape && !this.definition.allowEscape) throw new Error('Escape is disabled')

    if (this.inputs.length >= 1000) throw new Error('Reset after 1000 simulated rounds')
    const input = { round: this.current.round, plan: cloneCombatRules(this.current.plan), escape }
    const frames: CombatDebugFrame[] = []
    let truncated = this.truncated

    const result = resolveCombatRound(
      this.definition,
      {
        ...this.current,
        escape,
        stats: this.setup.stats,
        maximumHealth: this.setup.maximumHealth,
        equipment: this.setup.equipment,
      },
      this.truncated
        ? undefined
        : (frame) => {
            if (this.frames.length + frames.length >= this.traceLimit) {
              truncated = true

              return false
            }

            frames.push(frame)
          },
    )

    const round = result.outcome ? this.current.round : this.current.round + 1

    if (!Number.isSafeInteger(round)) throw new Error('Simulation round overflow')

    const enemies = result.outcome
      ? this.current.enemies
      : planEnemies(
          this.definition,
          result.health,
          result.cursors,
          round,
          result.statuses,
          result.cooldowns,
          result.mechanics,
          undefined,
          this.setup.maximumHealth,
          this.setup.equipment,
        )

    this.current = {
      round,
      seed: result.seed,
      health: result.health,
      guard: result.guard,
      statuses: result.statuses,
      cooldowns: result.cooldowns,
      mechanics: result.mechanics,
      enemies,
      plan: [],
      outcome: result.outcome,
    }
    this.frames.push(...frames)
    this.inputs.push(input)
    this.truncated = truncated

    return cloneCombatRules(result)
  }

  /** Repeat the queued plan; reserve only the moves currently affordable in each later round. */
  run(rounds: number) {
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('Run 1–100 rounds')
    const plan = cloneCombatRules(this.current.plan)

    for (let index = 0; index < rounds && !this.current.outcome; index++) {
      if (index)
        for (const move of plan)
          if (!this.queueIssue(move.move, move.target)) this.queue(move.move, move.target)
      this.resolve()
    }

    return this.snapshot()
  }

  report() {
    return cloneCombatRules({
      version: 1,
      definition: this.definition,
      setup: this.setup,
      inputs: this.inputs,
      state: this.current,
      frames: this.frames,
      truncated: this.truncated,
    })
  }
}
