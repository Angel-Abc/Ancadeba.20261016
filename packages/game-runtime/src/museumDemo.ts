import { getMapMovementCostMs } from '@ancadeba/schemas'
import type { ActionOutcome, GameActionHandler } from './actions.js'
import type { EngineRuntimeServices } from './engine.js'
import type { GameData } from './gameData.js'
import { GameLifecycle, type IGameLifecycle } from './gameLifecycle.js'
import type { IGameInventory } from './inventory.js'

const letter = 'folded-letter'
const chart = 'harbour-chart'
const displayCase = 'display-case'
const minuteMs = 60_000

const messages = {
  en: {
    letter: 'Folded letter',
    empty: 'Nothing to pick up.',
    pickup: 'Picked up the folded letter.',
    clue: '“At the east display case, press the heron beneath the crown. The keyhole is a decoy.”',
    read: 'Read the letter and found a clue to the display case.',
    caseLabel: 'Locked display case',
    caseLocked:
      'At the far end, the display case bears a brass crest with two raised symbols, a crown and a heron. The folded letter might explain how the case opens.',
    wrongSymbol: 'The crown clicks under your finger. The case stays locked.',
    caseOpenLabel: 'Open display case',
    caseOpen:
      'The heron sinks into the crest and the lid springs open. Inside is a chart of the old harbour with a safe passage marked through the shoals.',
    opened: 'Opened the display case and uncovered an old harbour chart.',
    chart: 'Harbour chart',
    caseEmpty:
      'The display case stands open. A pale rectangle on the velvet marks where the chart lay.',
    chartPickup: 'Took the harbour chart from the display case.',
    chartDetails:
      'A red line threads the shoals from the old harbour to a landing below the north cliffs.',
    chartRead: 'Traced the safe route marked on the harbour chart.',
    lobby: 'Entered the museum lobby.',
    gallery: 'Entered the east gallery.',
  },
  nl: {
    letter: 'Gevouwen brief',
    empty: 'Niets om op te pakken.',
    pickup: 'Je hebt de gevouwen brief opgepakt.',
    clue: '‘Druk bij de oostelijke vitrine op de reiger onder de kroon. Het sleutelgat is een afleidingsmanoeuvre.’',
    read: 'Je leest de brief en ontdekt een aanwijzing voor de vitrine.',
    caseLabel: 'Afgesloten vitrine',
    caseLocked:
      'Aan het einde staat een vitrine met een koperen wapen waarop twee symbolen uitsteken, een kroon en een reiger. Misschien staat in de gevouwen brief hoe de vitrine opengaat.',
    wrongSymbol: 'De kroon klikt onder je vinger. De vitrine blijft op slot.',
    caseOpenLabel: 'Open vitrine',
    caseOpen:
      'De reiger zakt in het wapen en het deksel springt open. Binnenin ligt een kaart van de oude haven met een veilige route door de ondiepten.',
    opened: 'Je opent de vitrine en ontdekt een kaart van de oude haven.',
    chart: 'Havenkaart',
    caseEmpty:
      'De vitrine staat open. Een lichte rechthoek op het fluweel laat zien waar de kaart lag.',
    chartPickup: 'Je haalt de havenkaart uit de vitrine.',
    chartDetails:
      'Een rode lijn loopt tussen de ondiepten door, van de oude haven naar een aanlegplaats onder de noordelijke kliffen.',
    chartRead: 'Je volgt de veilige route op de havenkaart.',
    lobby: 'Je bent de museumhal binnengegaan.',
    gallery: 'Je bent de oostgalerij binnengegaan.',
  },
}

function museumTime(worldTimeMs: number): string {
  const minutes = (9 * 60 + Math.floor(worldTimeMs / minuteMs)) % (24 * 60)

  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function carries(inventory: IGameInventory | undefined, item: string, owner: string): boolean {
  const placement = inventory?.snapshot.find(({ id }) => id === item)?.placement

  return placement?.type === 'carried' && placement.owner === owner
}

class MuseumPlaythrough {
  readonly player = { health: 40 }
  canTakeLetter = true
  canOpenCase = false
  canTakeChart = false
  letterClue = ''
  chartDetails = ''
  caseLabel: string
  caseDescription: string
  nearby: string
  log = ''
  clock = museumTime(0)
  private readonly entries: string[] = []
  private readonly text: (typeof messages)['en']

  constructor(
    private readonly data: GameData,
    private readonly lifecycle: () => IGameLifecycle,
  ) {
    this.text = data.language === 'nl' ? messages.nl : messages.en
    this.nearby = this.text.letter
    this.caseLabel = this.text.caseLabel
    this.caseDescription = this.text.caseLocked
    this.record(this.text.lobby)
  }

  inspectLetter(itemId: unknown, inventory: IGameInventory | undefined): ActionOutcome {
    if (itemId !== letter || !carries(inventory, letter, 'player'))
      return { status: 'rejected', reason: 'You are not carrying the letter' }

    if (!this.letterClue) {
      this.letterClue = this.text.clue
      this.canOpenCase = true
      this.record(this.text.read)
    }

    return { status: 'applied' }
  }

  inspectChart(itemId: unknown, inventory: IGameInventory | undefined): ActionOutcome {
    if (itemId !== chart || !carries(inventory, chart, 'player'))
      return { status: 'rejected', reason: 'You are not carrying the chart' }

    if (!this.chartDetails) {
      this.chartDetails = this.text.chartDetails
      this.record(this.text.chartRead)
    }

    return { status: 'applied' }
  }

  pressCrest(symbol: 'crown' | 'heron', inventory: IGameInventory | undefined): ActionOutcome {
    if (this.lifecycle().activeScene?.data.id !== 'gallery' || !this.canOpenCase)
      return { status: 'rejected', reason: 'You cannot open the display case right now' }

    if (symbol === 'crown') {
      this.caseDescription = this.text.wrongSymbol

      return { status: 'applied' }
    }

    this.canOpenCase = false
    this.canTakeChart = carries(inventory, chart, displayCase)
    this.caseLabel = this.canTakeChart
      ? `${this.text.caseOpenLabel}\n${this.text.chart}`
      : this.text.caseOpenLabel
    this.caseDescription = this.text.caseOpen
    this.record(this.text.opened)

    return { status: 'applied' }
  }

  takeChart(inventory: IGameInventory | undefined): ActionOutcome {
    if (
      !inventory ||
      this.lifecycle().activeScene?.data.id !== 'gallery' ||
      !this.canTakeChart ||
      !carries(inventory, chart, displayCase)
    )
      return { status: 'rejected', reason: 'The chart is not available here' }

    const moved = inventory.move(chart, { type: 'carried', owner: 'player' })

    if (moved.status === 'rejected') return moved

    this.canTakeChart = false
    this.caseLabel = this.text.caseOpenLabel
    this.caseDescription = this.text.caseEmpty
    this.record(this.text.chartPickup)

    return { status: 'applied' }
  }

  takeLetter(inventory: IGameInventory | undefined): ActionOutcome {
    if (this.lifecycle().activeScene?.data.id !== 'standard' || !this.canTakeLetter || !inventory)
      return { status: 'rejected', reason: 'The letter is not available here' }

    const moved = inventory.move(letter, { type: 'carried', owner: 'player' })

    if (moved.status === 'rejected') return moved

    this.canTakeLetter = false
    this.nearby = this.text.empty
    this.record(this.text.pickup)

    return { status: 'applied' }
  }

  walk(from: string, to: 'standard' | 'gallery', worldTimeMs: number): ActionOutcome {
    const lifecycle = this.lifecycle()

    if (lifecycle.activeScene?.data.id !== from)
      return { status: 'rejected', reason: 'That exit is not available here' }

    const map = this.data.scenes
      .get(to)
      ?.components.find((component) => component.type === 'map-view')

    const cost = map?.playerSpawn && getMapMovementCostMs(map.map, map.playerSpawn)

    if (cost === undefined || !Number.isSafeInteger(worldTimeMs + cost))
      return { status: 'rejected', reason: 'The destination is not reachable' }

    lifecycle.enterScene(to)
    this.clock = museumTime(worldTimeMs + cost)
    this.record(to === 'gallery' ? this.text.gallery : this.text.lobby)

    return { status: 'applied', worldTimeCostMs: cost }
  }

  private record(message: string): void {
    this.entries.unshift(`${this.clock}  ${message}`)
    this.entries.length = Math.min(this.entries.length, 8)
    this.log = this.entries.join('\n')
  }
}

/** Wire the Basic Game sample into the normal engine and editor hosts. */
export function withMuseumDemo(runtime: EngineRuntimeServices): EngineRuntimeServices {
  return {
    ...runtime,
    createGameLifecycle(data) {
      if (data.id !== 'basic-game' || !data.inventory?.items[letter] || !data.scenes.has('gallery'))
        return runtime.createGameLifecycle?.(data)

      const lifecycle: GameLifecycle<MuseumPlaythrough, undefined> = new GameLifecycle(data, {
        createGameState: () => new MuseumPlaythrough(data, () => lifecycle),
        createSceneState: () => undefined,
      })

      return lifecycle
    },
    createGameRules(data, game) {
      const state = game.state

      if (!(state instanceof MuseumPlaythrough))
        return runtime.createGameRules?.(data, game) ?? { handlers: new Map() }

      return {
        handlers: new Map<string, GameActionHandler>([
          ['take-letter', () => state.takeLetter(game.inventory)],
          ['inspect-letter', ({ payload }) => state.inspectLetter(payload, game.inventory)],
          ['take-chart', () => state.takeChart(game.inventory)],
          ['inspect-chart', ({ payload }) => state.inspectChart(payload, game.inventory)],
          ['press-crown', () => state.pressCrest('crown', game.inventory)],
          ['press-heron', () => state.pressCrest('heron', game.inventory)],
          [
            'walk-east',
            (_request, { progression }) =>
              state.walk('standard', 'gallery', progression.worldTimeMs),
          ],
          [
            'walk-west',
            (_request, { progression }) =>
              state.walk('gallery', 'standard', progression.worldTimeMs),
          ],
        ]),
      }
    },
  }
}
