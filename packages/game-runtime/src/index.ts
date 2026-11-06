export {
  Engine,
  type EngineState,
  type IEngine,
  type IEngineHost,
  type EngineHostSession,
  type EngineRuntimeServices,
} from './engine.js'

export type { EngineMessages } from './messages.js'

export {
  GameBindings,
  type IGameBindings,
  type GameBinding,
  type BindingValue,
  type BindingFailure,
  type BindingDiagnostic,
  type BindingResult,
} from './gameBindings.js'

export {
  resolveText,
  observeText,
  type TextTemplate,
  type TextResolution,
  type TextResolutionOptions,
  type TextBindingDiagnostic,
} from './textBindings.js'

export { GameLoader, type IGameLoader } from './gameLoader.js'

export {
  GameLocalization,
  type GameLanguagePreferences,
  type GameLanguageOption,
  type IGameLocalization,
  type LocalizedGameContent,
} from './gameLocalization.js'

export {
  assembleGameData,
  type GameData,
  type SceneData,
  type InputData,
  type TextComponentData,
  type ButtonComponentData,
  type LanguageSelectComponentData,
  type SceneComponentData,
  type GraphicComponentData,
  type MapViewComponentData,
  type InventoryComponentData,
} from './gameData.js'

export type { IGameInventory, InventoryItemSnapshot, InventoryMoveResult } from './inventory.js'

export type { PreparedInventoryTransfer } from './inventory.js'

export { GameInventory } from './inventory.js'

export {
  GameLifecycle,
  type IGameLifecycle,
  type IGameRuntime,
  type GameRuntimeFactory,
  type SceneChange,
  type SceneChangeHandler,
  type GameLifecycleFactories,
  type GameInstance,
  type SceneInstance,
} from './gameLifecycle.js'

export { InputController, type IGameInput, type VirtualInput } from './input.js'

export { GameActionBar, type IGameActionBar } from './actionBar.js'

export { GameMapMovement, type IGameMapMovement, type MapDirection } from './mapMovement.js'

export { GameNearbyContext, type IGameNearby, type NearbySelection } from './nearbyContext.js'

export { resolveStatusValue, statusBarFill, type StatusValueResolution } from './statusValues.js'

export { TimerService, type ITimerService, type TimerId, type TimerWakeup } from './timers.js'

export { ActionProcessor } from './actionProcessor.js'

export type {
  ActionRequestId,
  WorldScheduleId,
  ActionRequest,
  ActionOrigin,
  ActionContext,
  ActionOutcome,
  AppliedActionOutcome,
  ActionApplied,
  ActionRejected,
  ActionFailed,
  IGameActions,
  GameActionHandler,
  GameRules,
  GameRulesFactory,
  InputActionBinding,
  ProgressionSnapshot,
  ProgressionAdvanced,
  WorldTimePolicy,
} from './actions.js'

export type {
  TurnSnapshot,
  ActionTurnPolicy,
  TurnRules,
  ActorAttribution,
  ActionRequestOptions,
  InputActorSelector,
  TurnStarted,
  TurnTransition,
  TurnEnded,
  TurnIdle,
  TurnRosterChanged,
  RosterChanges,
  ActorRosterEntry,
  ActorRosterSnapshot,
} from './turns.js'

export * from './graphics.js'

export * from './graphicSources.js'

export * from './inventoryContext.js'

export * from './equipment.js'

export * from './itemDetails.js'

export * from './tradeState.js'

export * from './trading.js'

export * from './combat.js'

export * from './combatResolution.js'

export * from './stateTransactions.js'
