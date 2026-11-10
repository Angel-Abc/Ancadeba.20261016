import { numericRewardSchema, type CombatDefinition } from '@ancadeba/schemas'
import type { ProjectView } from '@ancadeba/editor-core'
import { type RuleFormControls, translationChoices } from './ruleFormControls.js'

export function combatRewardsForm(
  controls: RuleFormControls,
  view: ProjectView,
  draft: CombatDefinition,
  render: () => void,
): HTMLElement {
  const { group, select, input, button, translation, t } = controls
  const owners = Object.keys(view.inventory?.owners ?? {})

  const fields = (view.rules?.state ?? [])
    .filter((field) => typeof field.value === 'number')
    .map(
      (field) =>
        [JSON.stringify({ source: 'game.state', path: field.path }), field.path.join('.')] as const,
    )

  const keys = translationChoices(view)

  const root = group(
    t('combat.victoryRewards'),
    select(t('combat.enableRewards'), draft.rewards ? 'yes' : 'no', ['no', 'yes'], (value) => {
      draft.rewards = value === 'yes' ? { recipient: owners[0], numeric: [], drops: [] } : undefined
      render()
    }),
  )

  const rewards = draft.rewards

  if (!rewards) return root
  root.append(
    select(t('combat.rewardRecipient'), rewards.recipient ?? '', ['', ...owners], (value) => {
      rewards.recipient = value || undefined
    }),
    select(t('combat.lootOwner'), rewards.lootOwner ?? '', ['', ...owners], (value) => {
      rewards.lootOwner = value || undefined
    }),
  )
  rewards.numeric.forEach((entry, index) =>
    root.append(
      group(
        t('form.numericReward', { number: index + 1 }),
        input(t('combat.rewardId', { number: index + 1 }), entry.id, (value) => {
          entry.id = value.trim()
        }),
        input(t('combat.rewardLabel', { number: index + 1 }), entry.label, (value) => {
          entry.label = value
        }),
        translation(
          t('combat.rewardLabelTranslation', { number: index + 1 }),
          entry.labelKey ?? '',
          keys,
          (value) => {
            entry.labelKey = value || undefined
          },
        ),
        select(
          t('combat.rewardField', { number: index + 1 }),
          JSON.stringify(entry.field),
          fields,
          (value) => {
            entry.field = numericRewardSchema.shape.field.parse(JSON.parse(value))
          },
        ),
        input(
          t('combat.rewardAmount', { number: index + 1 }),
          String(entry.amount),
          (value) => {
            entry.amount = Number(value)
          },
          'number',
        ),
        button(t('combat.removeNumericReward', { number: index + 1 }), () => {
          rewards.numeric.splice(index, 1)
          controls.markEdited()
          render()
        }),
      ),
    ),
  )
  root.append(
    button(t('form.addNumericReward'), () => {
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
        t('combat.lootDrop', { number: index + 1 }),
        input(t('combat.dropId', { number: index + 1 }), drop.id, (value) => {
          drop.id = value.trim()
        }),
        select(
          t('combat.dropItemType', { number: index + 1 }),
          drop.itemType,
          Object.keys(view.inventory?.itemTypes ?? {}),
          (value) => {
            drop.itemType = value
            render()
          },
        ),
        input(
          t('combat.dropChance', { number: index + 1 }),
          String(drop.chance),
          (value) => {
            drop.chance = Number(value)
          },
          'number',
        ),
        ...Object.entries(drop.colors).flatMap(([channel]) => [
          input(
            t('combat.dropDye', { number: index + 1, channel }),
            drop.colors[channel]!,
            (value) => {
              drop.colors[channel] = value
            },
          ),
          button(t('combat.removeDropDye', { number: index + 1, channel }), () => {
            delete drop.colors[channel]
            controls.markEdited()
            render()
          }),
        ]),
        select(
          t('combat.dropNewDye', { number: index + 1 }),
          channel,
          ['', ...channels.filter((channel) => !Object.hasOwn(drop.colors, channel))],
          (value) => {
            channel = value
          },
          false,
        ),
        button(
          t('combat.addDropDye', { number: index + 1 }),
          () => {
            if (!channel) return
            drop.colors[channel] = '#ffffff'
            controls.markEdited()
            render()
          },
          !channels.some((channel) => !Object.hasOwn(drop.colors, channel)),
        ),
        button(t('combat.removeLootDrop', { number: index + 1 }), () => {
          rewards.drops.splice(index, 1)
          controls.markEdited()
          render()
        }),
      ),
    )
  })
  root.append(
    button(t('combat.addLootDrop'), () => {
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
