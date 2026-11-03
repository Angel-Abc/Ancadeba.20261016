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
} from './gameData.js'

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
