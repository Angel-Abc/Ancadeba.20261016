import { describe, expect, it, vi } from 'vite-plus/test'
import {
  GameLifecycle,
  type GameData,
  type SceneData,
  type SceneChange,
} from '@ancadeba/game-runtime'

function setup() {
  const data: GameData = {
    id: 'demo',
    title: 'Demo',
    description: '',
    version: '1',
    scenes: new Map<string, SceneData>(
      ['standard', 'inventory', 'settings'].map((id) => [
        id,
        {
          id,
          title: id,
          description: '',
          type: id === 'settings' ? 'stand-alone' : 'game',
          screen: { type: 'grid', grid: { rows: 12, columns: 12 } },
          components: [],
        },
      ]),
    ),
  }
  const disposeSceneState = vi.fn()
  const lifecycle = new GameLifecycle(data, {
    createGameState: () => undefined,
    createSceneState: () => undefined,
    disposeSceneState,
  })
  const changes = vi.fn<(change: SceneChange) => void>()
  lifecycle.subscribeSceneChanges(changes)
  return { lifecycle, changes, disposeSceneState }
}

describe('scene change notifications', () => {
  it('notifies only committed identity changes across the three scene types', () => {
    const { lifecycle, changes } = setup()
    const settings = lifecycle.enterScene('settings')
    lifecycle.enterScene('settings')
    lifecycle.startGame()
    expect(changes).toHaveBeenCalledExactlyOnceWith({ previous: undefined, current: settings })
    const standard = lifecycle.enterScene('standard')
    const inventory = lifecycle.enterScene('inventory')
    lifecycle.endGame()
    expect(
      changes.mock.calls.map(([change]) => [change.previous?.data.id, change.current?.data.id]),
    ).toEqual([
      [undefined, 'settings'],
      ['settings', 'standard'],
      ['standard', 'inventory'],
      ['inventory', undefined],
    ])
    expect(standard.disposed).toBe(true)
    expect(inventory.disposed).toBe(true)
    lifecycle.dispose()
    expect(changes).toHaveBeenCalledTimes(4)
  })

  it('reports game replacement, explicit scene exit, and disposal', () => {
    const { lifecycle, changes } = setup()
    lifecycle.startGame()
    lifecycle.enterScene('standard')
    lifecycle.startGame()
    expect(changes.mock.lastCall?.[0].current).toBeUndefined()
    lifecycle.enterScene('inventory')
    lifecycle.leaveScene()
    lifecycle.leaveScene()
    lifecycle.enterScene('settings')
    lifecycle.dispose()
    lifecycle.dispose()
    expect(changes.mock.calls.map(([{ current }]) => current?.data.id)).toEqual([
      'standard',
      undefined,
      'inventory',
      undefined,
      'settings',
      undefined,
    ])
    expect(() => lifecycle.subscribeSceneChanges(() => {})).toThrow('disposed')
  })

  it('does not notify on invalid transitions, and still notifies when old-state cleanup fails', () => {
    const { lifecycle, changes, disposeSceneState } = setup()
    lifecycle.enterScene('settings')
    expect(() => lifecycle.enterScene('standard')).toThrow('requires a current game')
    expect(() => lifecycle.enterScene('missing')).toThrow('Unknown scene')
    expect(changes).toHaveBeenCalledTimes(1)
    lifecycle.startGame()
    disposeSceneState.mockImplementationOnce(() => {
      throw new Error('Cleanup failed')
    })
    expect(() => lifecycle.enterScene('standard')).toThrow('Lifecycle cleanup failed')
    expect(changes.mock.lastCall?.[0].current).toBe(lifecycle.activeScene)
    expect(changes.mock.lastCall?.[0].previous?.disposed).toBe(true)
  })

  it('isolates observer failures, prevents reentrant transitions, and keeps the committed scene', () => {
    const { lifecycle, changes } = setup()
    lifecycle.subscribeSceneChanges(() => lifecycle.enterScene('settings'))
    const afterFailure = vi.fn()
    lifecycle.subscribeSceneChanges(afterFailure)
    expect(() => lifecycle.enterScene('settings')).toThrow('Scene change subscribers failed')
    expect(lifecycle.activeScene?.data.id).toBe('settings')
    expect(changes).toHaveBeenCalledTimes(1)
    expect(afterFailure).toHaveBeenCalledTimes(1)
  })

  it('supports independent duplicate subscriptions and unsubscription during delivery', () => {
    const { lifecycle } = setup()
    const handler = vi.fn()
    const unsubscribeFirst = lifecycle.subscribeSceneChanges(handler)
    const unsubscribeSecond = lifecycle.subscribeSceneChanges(handler)
    unsubscribeFirst()
    unsubscribeFirst()
    let unsubscribeLater = () => {}
    lifecycle.subscribeSceneChanges(() => unsubscribeLater())
    const later = vi.fn()
    unsubscribeLater = lifecycle.subscribeSceneChanges(later)
    lifecycle.enterScene('settings')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
    unsubscribeSecond()
    lifecycle.leaveScene()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('finishes the current notification before delivering disposal requested by an observer', () => {
    const { lifecycle, changes } = setup()
    const states: (string | undefined)[] = []
    lifecycle.subscribeSceneChanges(() => lifecycle.dispose())
    lifecycle.subscribeSceneChanges(({ current }) => states.push(current?.data.id))
    const scene = lifecycle.enterScene('settings')
    expect(states).toEqual(['settings', undefined])
    expect(changes).toHaveBeenCalledTimes(2)
    expect(lifecycle.disposed).toBe(true)
    expect(scene.disposed).toBe(true)
  })
})
