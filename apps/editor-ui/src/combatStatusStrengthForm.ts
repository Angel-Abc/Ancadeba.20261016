import type { RuleFormControls } from './ruleFormControls.js'

interface StatusStrengthDraft {
  type: 'apply-status' | 'remove-status'
  stacks?: number | undefined
  intensity?: number | undefined
  duration?: number | undefined
}

/** Shared by abilities, encounter triggers and phase entry effects. */
export function combatStatusStrengthForm(
  controls: RuleFormControls,
  effect: StatusStrengthDraft,
): HTMLElement[] {
  const { input, t } = controls

  return [
    input(
      t(
        effect.type === 'apply-status' ? 'combat.status.applyStacks' : 'combat.status.removeStacks',
      ),
      effect.stacks === undefined ? '' : String(effect.stacks),
      (value) => {
        effect.stacks = value.trim() ? Number(value) : undefined
      },
      'number',
    ),
    ...(effect.type === 'apply-status'
      ? [
          input(
            t('combat.status.applyIntensity'),
            effect.intensity === undefined ? '' : String(effect.intensity),
            (value) => {
              effect.intensity = value.trim() ? Number(value) : undefined
            },
            'number',
          ),
          input(
            t('combat.scaling.appliedDuration'),
            String(effect.duration ?? ''),
            (value) => {
              effect.duration = value.trim() ? Number(value) : undefined
            },
            'number',
          ),
        ]
      : []),
  ]
}
