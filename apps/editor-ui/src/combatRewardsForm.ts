import { numericRewardSchema, type CombatDefinition } from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import type { RuleFormControls } from './ruleFormControls.js'

export function combatRewardsForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: CombatDefinition,
  render: () => void,
): HTMLElement {
  const { group, select, input, button } = controls
  const owners = Object.keys(view.inventory?.owners ?? {})

  const fields = (view.rules?.state ?? [])
    .filter((field) => typeof field.value === 'number')
    .map(
      (field) =>
        [JSON.stringify({ source: 'game.state', path: field.path }), field.path.join('.')] as const,
    )

  const keys = ['', ...(view.translationKeys ?? [])]

  const root = group(
    'Victory rewards',
    select('Enable victory rewards', draft.rewards ? 'yes' : 'no', ['no', 'yes'], (value) => {
      draft.rewards = value === 'yes' ? { recipient: owners[0], numeric: [], drops: [] } : undefined
      render()
    }),
  )

  const rewards = draft.rewards

  if (!rewards) return root
  root.append(
    select('Reward recipient owner', rewards.recipient ?? '', ['', ...owners], (value) => {
      rewards.recipient = value || undefined
    }),
    select('Reward loot owner', rewards.lootOwner ?? '', ['', ...owners], (value) => {
      rewards.lootOwner = value || undefined
    }),
  )
  rewards.numeric.forEach((entry, index) =>
    root.append(
      group(
        `Numeric reward ${index + 1}`,
        input(`Reward ${index + 1} ID`, entry.id, (value) => {
          entry.id = value.trim()
        }),
        input(`Reward ${index + 1} label`, entry.label, (value) => {
          entry.label = value
        }),
        select(`Reward ${index + 1} label translation`, entry.labelKey ?? '', keys, (value) => {
          entry.labelKey = value || undefined
        }),
        select(`Reward ${index + 1} field`, JSON.stringify(entry.field), fields, (value) => {
          entry.field = numericRewardSchema.shape.field.parse(JSON.parse(value))
        }),
        input(
          `Reward ${index + 1} amount`,
          String(entry.amount),
          (value) => {
            entry.amount = Number(value)
          },
          'number',
        ),
        button(`Remove numeric reward ${index + 1}`, () => {
          rewards.numeric.splice(index, 1)
          controls.markEdited()
          render()
        }),
      ),
    ),
  )
  root.append(
    button('Add numeric reward', () => {
      let id = 'reward'
      let index = 1

      while (rewards.numeric.some((entry) => entry.id === id)) id = `reward-${index++}`
      rewards.numeric.push({
        id,
        label: 'Gold',
        field: {
          source: 'game.state',
          path: view.rules?.state.find((field) => typeof field.value === 'number')?.path ?? [
            'gold',
          ],
        },
        amount: 1,
      })
      controls.markEdited()
      render()
    }),
  )
  rewards.drops.forEach((drop, index) => {
    const type = view.inventory?.itemTypes[drop.itemType]
    const icon = type?.icon && (view.assets?.images[type.icon] ?? view.assets?.parts[type.icon])
    const part = type?.wornPart && view.assets?.parts[type.wornPart]

    const channels = [
      ...new Set([
        ...Object.keys(icon ? icon.colors : {}),
        ...Object.keys(part ? part.colors : {}),
      ]),
    ]

    let channel = channels.find((channel) => !Object.hasOwn(drop.colors, channel)) ?? ''
    root.append(
      group(
        `Loot drop ${index + 1}`,
        input(`Drop ${index + 1} ID`, drop.id, (value) => {
          drop.id = value.trim()
        }),
        select(
          `Drop ${index + 1} item type`,
          drop.itemType,
          Object.keys(view.inventory?.itemTypes ?? {}),
          (value) => {
            drop.itemType = value
            render()
          },
        ),
        input(
          `Drop ${index + 1} chance (0–10000)`,
          String(drop.chance),
          (value) => {
            drop.chance = Number(value)
          },
          'number',
        ),
        ...Object.entries(drop.colors).flatMap(([channel]) => [
          input(`Drop ${index + 1} dye ${channel}`, drop.colors[channel]!, (value) => {
            drop.colors[channel] = value
          }),
          button(`Remove drop ${index + 1} dye ${channel}`, () => {
            delete drop.colors[channel]
            controls.markEdited()
            render()
          }),
        ]),
        select(
          `Drop ${index + 1} new dye channel`,
          channel,
          ['', ...channels.filter((channel) => !Object.hasOwn(drop.colors, channel))],
          (value) => {
            channel = value
          },
          false,
        ),
        button(
          `Add drop ${index + 1} dye`,
          () => {
            if (!channel) return
            drop.colors[channel] = '#ffffff'
            controls.markEdited()
            render()
          },
          !channels.some((channel) => !Object.hasOwn(drop.colors, channel)),
        ),
        button(`Remove loot drop ${index + 1}`, () => {
          rewards.drops.splice(index, 1)
          controls.markEdited()
          render()
        }),
      ),
    )
  })
  root.append(
    button('Add loot drop', () => {
      let id = 'drop'
      let index = 1

      while (rewards.drops.some((entry) => entry.id === id)) id = `drop-${index++}`
      rewards.drops.push({
        id,
        itemType: Object.keys(view.inventory?.itemTypes ?? {})[0] ?? '',
        colors: {},
        chance: 10000,
      })
      controls.markEdited()
      render()
    }),
  )

  return root
}
