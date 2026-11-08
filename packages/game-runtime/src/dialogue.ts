import type { DialogueDefinition, DialogueCommand, RuleText } from '@ancadeba/schemas'
import type { GameInstance, IGameLifecycle, SceneInstance } from './gameLifecycle.js'
import type { IGameNearby, NearbySelection } from './nearbyContext.js'
import type { IGameBindings, BindingValue, GameBinding } from './gameBindings.js'
import type { IGameQuests, StoryCapture } from './quests.js'
import type { IMessageBus } from '@ancadeba/utilities'
import type { EngineMessages } from './messages.js'
import type { ActionOrigin } from './actions.js'
import { resolveText } from './textBindings.js'
import { matchesConditions, notifyStory } from './storyConditions.js'
import type { GameSave } from '@ancadeba/schemas'

interface TranscriptEntry {
  readonly node: string
  readonly line?: number | undefined
  readonly choice?: string | undefined
  readonly values: ReadonlyMap<string, BindingValue>
}

interface Conversation {
  readonly dialogue: string
  node: string
  page: number
  version: number
  finished: boolean
  transcript: readonly TranscriptEntry[]
}

interface Participant {
  readonly scene: SceneInstance
  readonly panel: string
  readonly selection: NearbySelection
  readonly key: string
}

export interface DialogueRequest {
  readonly scene: SceneInstance
  readonly panel: string
  readonly command: DialogueCommand
  readonly capture: StoryCapture
  readonly origin: ActionOrigin
}

export interface DialogueReply {
  readonly id: string
  readonly label: string
  readonly enabled: boolean
  readonly reason: string | undefined
}

export interface IGameDialogue {
  reply(scene: SceneInstance, panel: string, position: number): DialogueReply | undefined
  reason(scene: SceneInstance, panel: string, command: DialogueCommand): string | undefined
  capture(scene: SceneInstance, panel: string, command: DialogueCommand): StoryCapture
  request(
    scene: SceneInstance,
    panel: string,
    command: DialogueCommand,
    capture?: StoryCapture,
    origin?: ActionOrigin,
  ): void
  text(scene: SceneInstance, panel: string): string
  subscribeChanges(listener: () => void): () => void
}

/** Resumable conversations store definition references and captured scalar substitutions. */
export class GameDialogue implements IGameDialogue {
  private readonly conversations = new Map<string, Conversation>()
  private active: Participant | undefined
  private readonly displayed = new WeakMap<SceneInstance, Map<string, string>>()
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[] = []
  private readonly selections = new WeakMap<NearbySelection, number>()
  private nextSelection = 0
  private disposed = false

  save(): GameSave['dialogue'] {
    return Object.fromEntries(
      [...this.conversations].map(([key, conversation]) => [
        key,
        {
          ...conversation,
          transcript: conversation.transcript.map((entry) => ({
            ...entry,
            values: [...entry.values],
          })),
        },
      ]),
    )
  }

  restore(save: GameSave['dialogue']): void {
    for (const [key, conversation] of Object.entries(save)) {
      const definition = this.game.data.dialogues?.get(conversation.dialogue)

      if (
        !definition?.nodes[conversation.node] ||
        conversation.transcript.length > definition.transcriptCapacity
      )
        throw new Error('Invalid saved conversation')

      for (const entry of conversation.transcript) {
        const node = definition.nodes[entry.node]

        if (
          !node ||
          (entry.line !== undefined && !node.lines[entry.line]) ||
          (entry.choice !== undefined && !node.choices.some(({ id }) => id === entry.choice))
        )
          throw new Error('Invalid saved transcript')
      }

      this.conversations.set(key, {
        ...conversation,
        transcript: conversation.transcript.map((entry) => ({
          ...entry,
          values: new Map(entry.values),
        })),
      })
    }
  }

  activePanel(): string | undefined {
    return this.active?.panel
  }

  resume(scene: SceneInstance, panel: string): void {
    const participant = this.participant(scene, panel)

    if (!participant || !this.conversations.has(participant.key)) return
    this.active = participant
    this.displayed.set(scene, new Map([[panel, participant.key]]))
    notifyStory(this.listeners)
  }

  constructor(
    private readonly game: GameInstance,
    private readonly lifecycle: IGameLifecycle,
    private readonly nearby: IGameNearby,
    private readonly bindings: IGameBindings,
    private readonly quests: IGameQuests,
    private readonly messages: IMessageBus<EngineMessages>,
  ) {
    this.cleanups.push(
      nearby.subscribeChanges(() => this.prune()),
      lifecycle.subscribeSceneChanges(() => this.prune()),
      bindings.subscribeChanges(() => this.prune()),
      quests.subscribeChanges(() => notifyStory(this.listeners)),
      messages.subscribe('dialogue.request', (request) => this.execute(request)),
    )
  }
  private participant(scene: SceneInstance, panel: string): Participant | undefined {
    if (
      this.disposed ||
      scene.disposed ||
      scene !== this.lifecycle.activeScene ||
      scene.type !== 'game' ||
      scene.game !== this.game
    )
      return
    const selection = this.nearby.getSelection(scene, panel)
    const entry = selection && this.nearby.getEntry(scene, panel, selection.entry)

    if (!selection || !entry?.dialogue || !this.game.data.dialogues?.has(entry.dialogue)) return

    const key = entry.conversationId
      ? JSON.stringify(['shared', entry.conversationId])
      : JSON.stringify([scene.data.id, panel, selection.entry, entry.dialogue])

    return { scene, panel, selection, key }
  }
  private current(scene: SceneInstance, panel: string) {
    const participant = this.participant(scene, panel)
    const active = this.active

    if (
      !participant ||
      !active ||
      active.scene !== scene ||
      active.panel !== panel ||
      active.selection !== participant.selection ||
      active.key !== participant.key
    )
      return
    const conversation = this.conversations.get(participant.key)
    const definition = conversation && this.game.data.dialogues?.get(conversation.dialogue)

    if (conversation && definition) return { participant, conversation, definition }
  }
  private pageSize(scene: SceneInstance, panel: string): number {
    const positions = scene.data.components.flatMap((component) =>
      component.type === 'action-bar'
        ? Object.values(component.slots).flatMap((slot) =>
            slot.action.type === 'dialogue-action' &&
            slot.action.nearby === panel &&
            slot.action.command.type === 'choose'
              ? [slot.action.command.position]
              : [],
          )
        : [],
    )

    return Math.max(1, ...positions)
  }
  reply(scene: SceneInstance, panel: string, position: number): DialogueReply | undefined {
    const current = this.current(scene, panel)

    if (!current || current.conversation.finished) return
    const { definition, conversation } = current

    const choice =
      definition.nodes[conversation.node]?.choices[
        conversation.page * this.pageSize(scene, panel) + position - 1
      ]

    if (!choice || !matchesConditions(choice.visibleWhen, { game: this.game, scene })) return

    const enabled =
      matchesConditions(choice.when, { game: this.game, scene }) &&
      Boolean(this.quests.prepareEffects(scene, choice.effects))

    return Object.freeze({
      id: choice.id,
      label: choice.label,
      enabled,
      reason: enabled
        ? undefined
        : choice.unavailableText
          ? this.resolve(choice.unavailableText)
          : definition.messages.unavailable,
    })
  }
  reason(scene: SceneInstance, panel: string, command: DialogueCommand): string | undefined {
    const participant = this.participant(scene, panel)
    const current = this.current(scene, panel)
    const unavailable = current?.definition.messages.unavailable ?? 'Conversation is unavailable.'

    if (!participant) return unavailable

    if (command.type === 'start')
      return current && !current.conversation.finished ? unavailable : undefined

    if (!current) return unavailable

    if (command.type === 'end') return undefined

    if (current.conversation.finished) return unavailable

    if (command.type === 'choose')
      return (
        this.reply(scene, panel, command.position)?.reason ??
        (this.reply(scene, panel, command.position)?.enabled ? undefined : unavailable)
      )

    if (command.type === 'previous-page')
      return current.conversation.page > 0 ? undefined : unavailable

    return (current.conversation.page + 1) * this.pageSize(scene, panel) <
      (current.definition.nodes[current.conversation.node]?.choices.length ?? 0)
      ? undefined
      : unavailable
  }
  capture(scene: SceneInstance, panel: string, command: DialogueCommand): StoryCapture {
    const participant = this.participant(scene, panel)

    if (participant && !this.selections.has(participant.selection))
      this.selections.set(participant.selection, ++this.nextSelection)
    const conversation = participant && this.conversations.get(participant.key)

    return Object.freeze({
      signature: JSON.stringify([
        participant?.key,
        participant && this.selections.get(participant.selection),
        this.active?.key,
        conversation?.node,
        conversation?.page,
        conversation?.version,
        command.type === 'choose' ? this.reply(scene, panel, command.position)?.id : command.type,
        this.quests.capture(scene).signature,
      ]),
    })
  }
  request(
    scene: SceneInstance,
    panel: string,
    command: DialogueCommand,
    capture = this.capture(scene, panel, command),
    origin: ActionOrigin = { type: 'direct' },
  ): void {
    if (this.disposed) return
    this.messages.publish('dialogue.request', { scene, panel, command, capture, origin })
  }
  private capturedLines(
    definition: DialogueDefinition,
    node: string,
    values?: ReadonlyMap<string, BindingValue>,
  ): TranscriptEntry[] {
    return (definition.nodes[node]?.lines ?? []).map((line, index) => {
      const captured = new Map<string, BindingValue>()

      for (const binding of Object.values(line.bindings ?? {})) {
        const pending =
          binding.source === 'game.state' ? values?.get(JSON.stringify(binding.path)) : undefined

        const result = this.bindings.read(binding)

        if (pending !== undefined) captured.set(this.bindingKey(binding), pending)
        else if (result.status === 'resolved') captured.set(this.bindingKey(binding), result.value)
      }

      return Object.freeze({ node, line: index, values: captured })
    })
  }
  private execute(request: DialogueRequest): void {
    const { scene, panel, command, capture } = request

    if (
      this.capture(scene, panel, command).signature !== capture.signature ||
      this.reason(scene, panel, command)
    )
      return
    const participant = this.participant(scene, panel)

    if (!participant) return

    if (command.type === 'start') {
      let conversation = this.conversations.get(participant.key)

      if (!conversation || conversation.finished) {
        const entry = this.nearby.getEntry(scene, panel, participant.selection.entry)
        const definition = entry?.dialogue && this.game.data.dialogues?.get(entry.dialogue)

        if (!definition) return
        conversation = {
          dialogue: definition.id,
          node: definition.entry,
          page: 0,
          version: (conversation?.version ?? 0) + 1,
          finished: definition.nodes[definition.entry]?.terminal ?? false,
          transcript: this.capturedLines(definition, definition.entry).slice(
            -definition.transcriptCapacity,
          ),
        }
        this.conversations.set(participant.key, conversation)
      }

      this.active = participant
      const displayed = this.displayed.get(scene) ?? new Map<string, string>()
      displayed.set(panel, participant.key)
      this.displayed.set(scene, displayed)
      notifyStory(this.listeners)

      return
    }

    const current = this.current(scene, panel)

    if (!current) return
    const { conversation, definition } = current

    if (command.type === 'end') {
      conversation.finished = true
      conversation.version++
      this.active = undefined
      notifyStory(this.listeners)

      return
    }

    if (command.type === 'previous-page' || command.type === 'next-page') {
      conversation.page += command.type === 'previous-page' ? -1 : 1
      conversation.version++
      notifyStory(this.listeners)

      return
    }

    if (command.type !== 'choose') return

    const choice =
      definition.nodes[conversation.node]?.choices[
        conversation.page * this.pageSize(scene, panel) + command.position - 1
      ]

    if (!choice) return
    const effects = this.quests.prepareEffects(scene, choice.effects)

    if (!effects?.isCurrent()) return

    const transcript = [
      ...conversation.transcript,
      Object.freeze({
        node: conversation.node,
        choice: choice.id,
        values: new Map<string, BindingValue>(),
      }),
    ].slice(-definition.transcriptCapacity)

    const destination = choice.scene && this.game.data.scenes.get(choice.scene)

    if (choice.scene && (!destination || destination.type !== 'game')) return
    effects.commit()
    conversation.node = choice.next ?? conversation.node
    conversation.page = 0
    conversation.finished =
      choice.end || Boolean(choice.next && definition.nodes[choice.next]?.terminal)
    conversation.transcript = [
      ...transcript,
      ...(choice.next ? this.capturedLines(definition, choice.next) : []),
    ].slice(-definition.transcriptCapacity)
    conversation.version++
    notifyStory([
      () => effects.notify(),
      ...this.listeners,
      () => {
        if (choice.scene) this.lifecycle.enterScene(choice.scene)
      },
    ])
  }
  private bindingKey(binding: GameBinding): string {
    return JSON.stringify([binding.source, binding.path])
  }
  private resolve(value: RuleText): string {
    if (typeof value === 'string') return value

    return (
      this.game.data.ruleTranslation?.messages[value.textKey] ??
      this.game.data.ruleTranslation?.fallback[value.textKey] ??
      ''
    )
  }
  text(scene: SceneInstance, panel: string): string {
    const key = this.displayed.get(scene)?.get(panel)
    const conversation = key && this.conversations.get(key)
    const definition = conversation && this.game.data.dialogues?.get(conversation.dialogue)

    if (!conversation || !definition) return ''

    return [
      definition.label,
      ...conversation.transcript.map((entry) => {
        const node = definition.nodes[entry.node]

        if (entry.choice) {
          const choice = node?.choices.find((choice) => choice.id === entry.choice)

          return choice ? `${definition.messages.player}: ${choice.label}` : ''
        }

        const line = entry.line !== undefined && node?.lines[entry.line]

        if (!line) return ''

        const resolution = resolveText(
          { text: this.resolve(line.text), ...(line.bindings && { bindings: line.bindings }) },
          {
            read: (binding) => {
              const value = entry.values.get(this.bindingKey(binding))

              return value !== undefined
                ? { status: 'resolved', value }
                : {
                    status: 'unresolved',
                    diagnostic: {
                      source: binding.source,
                      path: binding.path,
                      reason: 'missing-path',
                    },
                  }
            },
            subscribeChanges: () => () => {},
          },
        )

        return `${line.speaker ? `${this.resolve(line.speaker)}: ` : ''}${resolution.text}${resolution.diagnostics.length ? ` (${definition.messages.missingBinding})` : ''}`
      }),
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  private prune(): void {
    const active = this.active

    if (active && this.participant(active.scene, active.panel)?.selection !== active.selection)
      this.active = undefined
    notifyStory(this.listeners)
  }
  subscribeChanges(listener: () => void): () => void {
    if (this.disposed) return () => {}

    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }
  dispose(): void {
    this.disposed = true
    this.cleanups.splice(0).forEach((cleanup) => cleanup())
    this.conversations.clear()
    this.listeners.clear()
    this.active = undefined
  }
}
