# Tides and the Three Seals

Open this sample in the editor or engine. Start a new game, then choose an
encounter from the harbour. All encounters belong to the same game and share
player health. New game resets health, meters, phases and rewards.

## Water battle

The diver has stamina and exhaustion meters. Water adds 10 exhaustion at the
start of each player turn. At 60 exhaustion, Exhausted intensity 1 reduces the AP
budget from 3 to 2 and deals 3 damage at turn start. At 90, intensity 2 reduces it
to 1 AP and deals 6 damage. Fatigue bypasses defense and Guard.

- Q: Quick thrust, 1 AP, 10 stamina, +12 exhaustion.
- W: Power stroke, 2 AP, 30 stamina, +30 exhaustion.
- E: Float and recover, 1 AP, -30 exhaustion and +25 stamina.
- A: Find swimming rhythm, 1 AP and 10 stamina; adds a defense stack, up to three.
- R: Undo; T: Clear; B: End turn.
- D: Escape; V: Continue after an outcome.

Stamina recovers by 10 at round end. Dropping below 60 exhaustion removes the
Exhausted status. Recovery happens when its action resolves, after that turn's
fatigue damage. Meters clamp to 0–100. Costs are reserved while planning; future
recovery is not assumed when deciding whether another action can be queued.
Swimming rhythm grants +1 defense per stack for three affected turns. Adding
stacks preserves its remaining duration. The badge shows its current strength.
Exhaustion intensity drops back to 1 below 90, then disappears below 60. Recovery
always fits the remaining AP budget, including at intensity 2.

## Three-seal guardian

Q channels 25 seal energy for 1 AP. B resolves the round. Fill the gauge to 100
three times: each fill resets energy to zero and increments Seals broken. The
first two breaks change the named phase and the guardian's next action choices.
The third declares victory through a trigger, even though the guardian still has
500 health. Final victory grants three Seals released exactly once.

W braces for 1 AP. R undoes, T clears, D escapes and V continues after an outcome.

## Shared underwater rules

The harbour also offers Reef and Deep water. Both use the `underwater` ruleset
from `combat-libraries/environments.json`, with the `swimmer` role bound to each
encounter's player ID. Reef inherits 100 stamina and +10 exhaustion per player
turn and the same AP-reduction fatigue as Water. Deep water overrides stamina to
60/80 and pressure to +20 exhaustion. Its local Exhausted status increases every
action cost by 1 AP at 60 exhaustion or 2 AP at 90, with 1/2 fatigue damage, while
retaining the 3 AP budget. Recovery costs 2/3 AP and remains affordable. Heavy
attacks may become unaffordable; the controls explain their current cost.
Their resources, plans and active effects remain independent. Each fight has its
own eel health; player health is shared with the rest of the game.

Edit the library's underwater ruleset to update inherited settings across both
fights. Edit Deep water's effective mechanics to change just that fight. Its
source stores only `ruleset` and the changed `mechanicsOverrides` fields.
Reset an override to inherit the current shared setting again. Both fights use
the same Q/W/E/A, R/T and B controls as the original water example. Deep water's
status replacement is local, so editing it does not change the shared rule or Reef.

The library also contains reusable `three-seals` boss mechanics and their enemy
moves. The original water and boss examples remain inline definitions for
comparison.

## Conditional enemy choices

All three water fights give the eel ordered AI rules. At two or more Swimming
rhythm stacks it uses **Break swimming rhythm**, removing one stack. This costs
1 AP and has a one-round cooldown. At exhaustion 60 or above (50 in Deep water) it prefers
**Exploit exhaustion**, a 2 AP lunge dealing 5–7 damage. If the higher-priority
rhythm removal leaves only 1 AP, the lunge cannot fit; the eel uses its normal
Guard/Bite rotation instead. On the cooldown round the lunge can take priority.
Building three rhythm stacks leaves two after the eel's disruption.

The guardian braces when the first seal gauge reaches 50, uses up to two pulses
per turn in the second phase, and uses Angry surge in the final phase. The phase
rules run before its fallback rotation. Breaking a seal during the player's turn
changes the guardian's choices in that same round.

Enemy plans are previews of current conditions. AI chooses again before each
action using live resources, status stacks/intensity, health and phase, including
turn-start triggers and earlier actions. Previewing never simulates future gains
or advances randomness. Each rule's usage limit resets on the enemy's next turn.
In the editor, expand an enemy's **Conditional enemy AI** to edit priorities,
conditions, move choices, usage limits and rotation/wait fallback.

## Shared enemy AI profiles

Reef and Deep water both link to `environments/eel-hunter` in the combat library's
`aiProfiles` section. The `swimmer` role binds to `diver` in Reef and `swimmer` in
Deep water. `self` automatically refers to the eel using the profile. The shared
rules disrupt rhythm, lunge at exhaustion 60, and brace once when the eel has 20
health or less, before falling back to its encounter-specific rotation.

Deep water stores a sparse `aiOverrides` patch on its enemy: only the
`exploit-fatigue` rule's conditions change, lowering the threshold to 50. All
other fields continue following the library. Reef has no AI overrides. The
profile's Ambush/Disrupt definitions are imported automatically; each fight keeps
its own cooldowns, rotation cursor and per-turn rule counts.

In the editor's combat library, edit **Reusable enemy AI profiles** to change the
shared behavior. In an enemy's **Enemy AI profile**, bind roles and edit the
effective rules to create local overrides. Reset a rule or all AI overrides to
inherit again. Choosing **Inline enemy AI** detaches a copy of the effective
behavior and retains explicit imports for its moves/statuses. The original Water
and guardian fights keep inline AI for comparison.

## Simulating and debugging these encounters

Open the Combat editor and select an encounter. **Combat simulation and
debugging** tests the current encounter draft with saved libraries and the game's
starting values; no game state or source documents are changed. Click
**Start/reset simulation**, queue moves and resolve a round, or repeat the queued
plan for several rounds. Starting-condition edits apply on the next Start/reset.

For a water diagnostic:

1. Select **water** and set **Starting resource · exhaustion** to `55`.
2. Choose the `rhythm` starting status, with `2` stacks and `3` turns, then add it.
3. Start/reset and resolve an empty player round.
4. Inspect enemy decisions: rhythm removal is selected first. On the next
   decision, its cooldown/use limit blocks it; the exhaustion lunge matches at
   `65` but costs `2` AP while only `1` remains. Guard is selected as fallback.
5. Inspect action/event steps to see fatigue damage, the removed rhythm stack,
   resource changes and cooldown expiry. Resolve another round to see the lunge.

For inherited behavior, select Reef or Deep water and start at exhaustion `40`.
After water pressure, Reef reaches `50` and keeps its rotation. Deep water reaches
`60` and lunges using its locally overridden threshold of `50`. The inspector
shows the actual resource value and each matched/failed comparison.

For the guardian, select **boss**, start/reset, queue **channel** three times and
repeat that plan for `4` rounds. The seal gauge fills three times and victory is
reported while the guardian remains alive. Filter **Events and triggers** to
inspect `seal-filled`, `second-seal`, `third-seal` and `victory`. Filter enemy
decisions to see phases change its actions during the same round. To isolate one
transition, restart with seal energy `75`, queue one channel, and resolve once.

**Simulation report (JSON)** contains the resolved definition, starting setup,
seed, actual round inputs, final state and trace, so you can copy a reproducible
report. Trace collection is capped at 500 frames; inputs and final state remain
available after that limit. Repeated plans keep their targets and omit moves
that are currently unavailable. This combat sandbox does not consume inventory
items, deliver rewards or advance the world clock.

## Saved regression scenarios

Each combat source now includes `simulationScenarios`. Open **Saved combat
scenarios** in the Combat editor and select a test, then replay it or run all saved
tests for that encounter. Results can be inspected in the existing debugger.

| Encounter  | Scenario          | Verifies                                                                                                     |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Water      | `rhythm-pressure` | Exhaustion reaches 65, fatigue removes 3 HP, the eel removes one rhythm stack.                               |
| Water      | `recover-fatigue` | Float reduces exhaustion to 45 and clears Exhausted.                                                         |
| Reef       | `shared-pressure` | Shared water pressure reaches exhaustion 50 after one round.                                                 |
| Deep water | `shared-pressure` | Local pressure reaches exhaustion 60 after one round.                                                        |
| Boss       | `phase-response`  | Channeling from seal energy 75 enters phase two and fires its trigger in one round.                          |
| Boss       | `three-seals`     | Three channels per round produce three gauge fills and victory in four rounds while the guardian has 500 HP. |

To try a regression, change the boss's Channel seal energy effect from `25` to
`20` in the encounter draft, then replay `three-seals`. The checks show planning
instead of victory and two broken seals instead of three. Restore `25` and rerun
to pass. The test always resolves the latest encounter draft and saved shared
rules/AI profiles, including local overrides.

To save a new test, run a manual simulation and choose **Capture simulation as
new scenario** with an unused ID. Edit its script and expected results, or
explicitly capture the simulated final state, then save. Existing tests retain
their expectations until you edit them. Scenario saves change only the test data
and do not deliver rewards, change live state or invalidate gameplay saves.

## Authoring

In **Combat → Resources, triggers and phases**, configure meters, event filters,
conditions, ordered effects, phase entry effects and enemy rotations. Ability
effects include `change-resource`; moves can also declare resource costs.
The combat view displays meters and the active phase. Pause and return preserves
the current plan, meters, phase, status stacks/intensity and one-shot trigger history. Save/load preserves
the same state.

The JSON files under `combat/` are complete examples. See the repository README's
"Custom combat resources, triggers and phases" section for event ordering and
transaction semantics.

## Shared expressions and lifecycle examples

Water fatigue thresholds use percentages of maximum exhaustion. Moderate fatigue
uses AND with NOT severe fatigue; eel AI uses OR between high exhaustion and a
low-health exhausted swimmer. The same expressions work in the shared Underwater
ruleset and Eel hunter profile, including bound swimmer roles and local overrides.

Replay Water's `emergency-float` scenario: at 20/80 HP and exhaustion 40, water
pressure adds 10. Before `rest`, a low-health AND NOT-buoyant condition applies
Emergency buoyancy. Its status-applied hook removes 5 exhaustion, then rest removes
30, leaving 15. Buoyancy grants defense; its eventual status-expired hook restores
5 stamina. Rest's exhaustion effect is individually conditional on exhaustion
being above 0%.

Replay Boss's `last-resolve` scenario: channeling at 20/80 HP outside the final
phase applies Last resolve before the action. After the normal 25 energy,
a status condition grants 5 more energy and removes Last resolve. A conditional
trigger effect suppresses this bonus if the normal channel entered the final
phase. The original `three-seals` scenario still verifies three complete fills;
its fill threshold is now 100% and guardian protection uses AND/NOT/OR phases.

Open the condition type picker to build nested AND/OR/NOT groups and select the
threshold unit. Ability and trigger effects expose **Add effect condition**.
The simulator's enemy inspector expands child comparisons and shows observed
percentages with current/maximum values. Event frames include lifecycle filters,
matched/failed trigger expressions, and status IDs for diagnosing hook order.

## Underwater guardian: composed rulesets

Choose **Underwater guardian (composed rules)** in the harbour. This encounter's
`rulesets` array combines `environments/underwater` and `environments/three-seals`,
with independent swimmer and boss actor bindings. The original fights continue
using their existing single-ruleset or inline definitions.

Press Q to channel (+25 seal energy, 10 stamina) and E to float (−30 exhaustion,
+25 stamina). An encounter-local after-action trigger adds 15 exhaustion per
channel. Sparse overrides reduce water pressure to 5 per turn and start stamina
at 60. Inherited fatigue reduces AP at 60%/90% exhaustion; inherited seal triggers
reset the gauge and advance phases three times for victory.

The saved `three-seals-underwater` scenario wins in six rounds with the boss still
at 500 HP. Its plan is three channels, then two rounds of recover/channel/channel,
one round of recover/channel, then two rounds of recover/channel/channel. The
shorter round respects the AP budget already reduced by exhaustion at planning.
`recover-before-seal` starts with exhaustion 55 and seal energy 75, recovers and
channels, and verifies exhaustion 45, no Exhausted status and phase two.

In the Combat editor, inspect the two layers, reorder them and edit encounter
mechanics without copying either shared ruleset. Existing overrides stay sparse;
resets inherit the composed values. Duplicate mechanic IDs require explicit
replacement on the later layer. The effective preview identifies each entry's
provider. Trigger-defined victory stays active even if the environmental layer
is moved after the boss layer.

## Dynamic values and percentage bonuses

Water and Underwater guardian add S **Flow strike**, F **Reviving breath**, and G
**Focus current**. Flow strike damage is 4–6 plus 10% of stamina after payment,
minus 2 per Exhausted intensity. Its base AP cost gains 0.02 per exhaustion,
rounded up (capped at 3 before percentage modifiers). Its stamina cost is 10 plus
5 per Exhausted intensity. It adds 10 exhaustion after dealing damage.

Reviving breath heals 4 plus 10% of stamina after its 10-stamina cost, minus 2 per
Exhausted intensity. Focus current applies Current focus at intensity two, giving
+50% damage, +40% healing and −50% AP cost. Percentages apply after flat modifiers;
AP costs always round up to at least one. Damage/healing round down.

In the underwater guardian's final phase, Pressure surge scales its 3–4 base
damage by exhaustion percentage plus 10% per target Exhausted intensity. At 95
exhaustion and intensity two, its range becomes 6–8 before mitigation. Its water
type meets the diver's 50% water resistance, reducing this to 3–4. After the
six-point fatigue tick, `pressure-surge-scaling` leaves the diver at 70–71 HP.

Replay Water's `scaled-current` to strike under fatigue, recover and heal with
percentage bonuses. `scaled-last-seal` heals the diver from 37 to 46 HP after
fatigue and then breaks the last seal. `pressure-surge-scaling` checks the boss
at 95 exhaustion. The original water and six-round three-seal replays still pass.

In the editor, inspect move **AP cost scaling**, **Resource cost scaling**, and
**Effect value scaling**, plus the Current focus status's **Percentage modifiers**.
You can edit sources, coefficients, additive/percentage mode and optional
bounds/rounding, or disable scaling to use fixed values again.

## Typed damage and temporary defenses

Water and Underwater guardian add Z **Tidal bolt** (12 water), X **Arc bolt**
(12 lightning) and C **Venom dart** (4 poison plus two turns of Venom, 4 poison
per tick). Each costs 1 AP and 5 stamina.

The cave eel has 50% water resistance, 50% lightning vulnerability and poison
immunity. Water's `typed-damage` replay uses all three: 6 water + 18 lightning +
0 poison leave the eel at 66/90 HP. Venom still applies, but its first tick deals
zero; damage immunity does not block statuses.

The underwater guardian resists fire by 75%, is 50% vulnerable to lightning and
is immune to water/poison. Its `typed-damage` replay leaves 482/500 HP. Entering
the second seal applies the imported **Tidal shell** defense-only composite at
intensity two for two turns. Each intensity adds 25% lightning resistance, and
the ward grants fire immunity. Net lightning resistance/vulnerability cancel,
so `seal-shell` channels from 75 energy then hits for 12 lightning damage,
leaving 488 HP and one remaining turn of the intensity-two ward. Once it expires,
lightning again deals 18. The diver permanently resists water by 50%, including
the boss's dynamically scaled Pressure surge.

In the editor, use **Damage type** on attacks, damage effects and periodic
statuses. Use actor/status **Damage defenses** to add matching type IDs and
percentages or immunity. Live views and previews show effective defenses and
typed damage ranges; logs and simulator frames retain mitigation details.
All forty-two saved scenarios, including the original three-seal victory, remain
available for replay.

## Actual damage, healing and reactions

With **Focus current** (G) active, lightning damage siphons health: half of actual
HP damage, rounded down, becomes a reactive heal. Current focus's existing +40%
healing bonus then applies, capped by missing HP. A healing-received trigger
opts into reactions and removes exhaustion equal to the HP actually restored.
Overhealing provides no additional exhaustion relief. These two triggers live
in the shared Underwater ruleset and in the inline Water encounter.

Replay Water's **current-siphon**. Starting at 40 HP and exhaustion 30, focus plus
Arc bolt deals 27 lightning damage to the vulnerable eel. Half is 13; healing
bonuses increase that to 18 HP restored. Exhaustion falls from 40 after water
pressure to 22, the eel has 63 HP, and its turn leaves the diver at 54–56 HP.

Underwater guardian now gains seal energy equal to lightning HP damage actually
dealt. Resistance and Guard reduce both the HP damage and the charge; immunity
provides no charge. The original channel route remains available. The existing
**typed-damage** replay verifies 18 charge, while **seal-shell** verifies 12
charge through the intensity-two shell. While Tidal shell is active, the boss
also reflects 25% of actual lightning damage received: a 12-damage hit reflects
3 lightning damage, without recursively reflecting or rolling RNG.

Replay **lightning-three-seals**: recover then cast two Arc bolts per round for
ten rounds. Guard and the temporary ward slow the gauge, but the three fills win
with the guardian still alive. No Channel actions are used. In a live fight,
press E/X/X/B for that plan; G can enable siphon when healing is needed.

In the editor, inspect **lightning-charge**, **current-siphon**, **healing-relief**
and **shell-reflection**. Event filters select sources, recipients, types and
delivery. **Event amount formula** reads actual HP changed; event conditions
can compare amounts or immunity/reaction flags. The simulator's event frames
retain immutable effect facts even when later reactions alter the current state.

## Silence, disarm and status immunity

Click **Open control techniques** in Water or Underwater guardian. The companion
view uses the same encounter session, health, plan and resources; returning to
standard controls does not restart it. Its click-only techniques are:

- **Brine bind**: a spell that applies Silenced and Disarmed independently.
- **Clear mind**: a utility ward preventing new Silenced, Disarmed and Dazed
  applications for three affected turns.
- **Shake off**: utility cleansing that removes existing Silence and Disarm.
- **Stunning bell**: a spell that applies Dazed unless the target is immune.

Arc bolt and other spells use category `spell`; weapon attacks and Venom dart
use `weapon`. Flow strike uses both. Silence blocks spells, Disarm blocks
weapons, and either blocks Flow strike. Recovery/Guard use `utility` and remain
available. Stun still skips all actions. Categories are matching IDs rather
than inferred from an attack or ability's type.

Water's **brine-control** suppresses the eel's weapon attacks and its spell
fallback, so it braces instead. **silence-recovery** explicitly skips initially
blocked spell/weapon commands, cleanses with Shake off, then casts Arc bolt on
the next round. **status-ward** applies Clear mind; the eel tries Brine curse,
but both statuses are rejected and the diver remains at 80 HP.

The underwater guardian is permanently immune to `disarmed` and `dazed`.
**boss-silence** shows that Silence still works before its temporary shell,
while Disarm is rejected. **boss-control-immunity** starts with intensity-two
Tidal shell, which also grants Silence immunity. Brine bind and Stunning bell
apply no controls; Arc bolt still deals 12 damage and charges 12 seal energy.

Immunity blocks future applications, refreshes and added stacks; it does not
cleanse existing controls. Grant Clear mind before a curse, or use Shake off
afterward. Stacked wards combine protections without multiplying them. Damage
immunity remains independent of status immunity. Live views and status badges
show effective restrictions/protections; simulator decisions explain why an
enemy skips a restricted move. Restricted execution and immunity logs survive
save/load. The original exhaustion and lightning three-seal routes still work.

## Diving equipment

From the harbour, open **Diving gear room**. Select the diving suit and click
**Equip**, then do the same for the rebreather. Both start carried so the original
scenarios still run without gear. The comparison shows each proposed effect.

- **Diving suit**: +25% water resistance. It reduces the eel's water bite and adds
  to the underwater guardian encounter's innate 50%, giving 75% resistance there.
- **Rebreather**: -50% positive exhaustion gains, rounded down. Water pressure
  becomes 5 instead of 10; underwater boss pressure becomes 2 instead of 5. It
  grants **Purge valve**: recover 20 exhaustion for 1 AP and 5 stamina.

Enter either gear practice scene from the gear room. **A** queues Purge valve,
**E** queues recovery, and **B** resolves the round. The other original controls
remain available. The gear action is disabled without the rebreather. The combat
panel lists equipped mechanics and combined defenses, and logs show exhaustion
gains before and after gear adjustment. Exhaustion reduction occurs before
fatigue hooks; action costs and recovery are unchanged. Lightning still charges
the boss seal gauge by actual damage dealt.

Water and Underwater boss each add two saved scenarios: `diving-gear` checks
reduced pressure, avoided fatigue and protected HP, and `rebreather-purge` checks
the equipment-granted action. Their `setup.loadout` explicitly selects both item
IDs. Change gear in **Starting equipment** to compare runs, then capture a scenario
to keep the loadout and plan. Replay reads the latest equipment definitions.

Both battles share the diver's loadout. An unfinished fight locks equipment,
including after returning to the harbour, and prevents starting the other linked
fight. Escape or finish before changing gear or encounters; **New game** resets
both battles and returns the items to carried inventory. Save/load retains gear,
plans, meters and the adjustment log.

## Action requirements

From the harbour, open **Action requirements: Water** or **Action requirements:
Underwater guardian**. These views share the original encounters and loadout
locks, while keeping the original controls available in their companion views.

**S — Rhythm dive** requires at least 20% available stamina, two Swimming rhythm
stacks and NOT Exhausted. It spends 1 AP, 8 stamina and one rhythm stack for
12 physical damage. In Water, queue **A** three times, resolve with **B**, then
try **S** twice: the eel removes one stack after your setup, the first dive
spends another, and the second queued dive is skipped without payment. A queued
buff does not unlock the dive until that buff has actually resolved.

**Z — Seal release** in the underwater boss view requires the third seal, 20%
available stamina, and Current focus intensity 2 (**G**) OR two Swimming rhythm
stacks (**A**). It costs 1 AP and 10 stamina, deals 20 base lightning damage,
and charges the seal by damage actually dealt through the existing reaction.
Hover a disabled action to see unmet requirements and current values. The
simulator shows the same reasons; action traces record execution failures.

Four saved scenarios cover these mechanics:

| Encounter       | Scenario              | Checks                                                                                |
| --------------- | --------------------- | ------------------------------------------------------------------------------------- |
| Water           | `rhythm-requirements` | First dive spends a stack; second is skipped with no extra cost.                      |
| Underwater boss | `rhythm-requirements` | The same reusable action checks stacks and stamina in a composed encounter.           |
| Underwater boss | `seal-release-ready`  | Third phase and focus permit 45 lightning damage and 45 seal charge.                  |
| Underwater boss | `seal-release-locked` | First phase blocks the finisher before AP or stamina spending, damage or seal charge. |

Moves expose **Action requirements** in both the encounter and shared library
editors. Add nested expressions or clear them without JSON edits. Requirements
are checked during planning and again before payment during resolution, including
after before-action hooks. Failed actions consume neither items nor cooldowns.
Existing unmodified moves keep their behavior.

## Shared passives from equipment and statuses

Open **Diving gear room**, select the **Tidal charm** and equip it. It starts
carried, so existing unarmored scenarios keep their original results. Then open
**Shared passives: Water** or **Shared passives: Underwater guardian** from the
harbour or gear room. Both views reuse the original encounters and loadout locks.

- **Tidal charm → Tidal relief**: recover 3 exhaustion after water damage actually
  received. Immune or fully guarded hits do not activate this received-damage
  trigger. The boss's water Pressure surge in its third phase activates it.
- **A — Attune currents → Conductive attunement → Current reserve**: while the
  three-turn status is active, direct lightning damage dealt restores half its
  actual amount as stamina, rounded down, and removes 3 exhaustion. Queue **X —
  Arc bolt** after attuning, then resolve with **B**. Cleansing or expiry removes
  the grant. The boss still receives seal charge once from actual damage.

These are shared library triggers, granted by references on the item and status.
Combat logs name both the passive and source. The simulator's event/trigger
frames identify the granting item/status and show actual event amounts.

Water and Underwater boss each add `shared-passive-grants` and `passive-expiry`.
The first equips the charm and applies attunement before lightning damage. Water
ends at exhaustion 34, stamina 64 and eel HP 72. The third-phase boss version ends
at exhaustion 29, stamina 54, guardian HP 482 and seal 18. The expiry scenario
waits for attunement to disappear, then confirms that lightning no longer restores
stamina through the passive.

Author shared definitions in **Shared combat passives**, and select them under
**Granted combat passives** on equipment or statuses. Multiple granting sources
each react once; status stacks/intensity do not multiply execution. Once-only
triggers retain history per granting source across save/load and status
reapplication. Source removal prevents later reactions, and loops use the same
bounded transaction rollback as encounter triggers.

## Shields, healing interception and rescue

Open **Interception: Water** or **Interception: Underwater guardian** from the
harbour or gear room. These views share the encounters, exhaustion, diving gear
and three-seal rules used by the other practice views.

- **A — Raise air barrier** spends 5 stamina to grant a three-turn shield. Its
  shared passive spends remaining stamina one-for-one to absorb up to 8 damage
  per hit, after defense and Guard. Exhaustion and other stamina costs still apply.
- **F — Draw brine** grants Waterlogged for two turns. Its passive halves incoming
  healing before the missing-health cap. **S — Rescue breath** heals 20 before
  this adjustment. Both effects work in water and against the guardian.
- Equip the **Rescue charm** in the gear room's charm slot before entering. Its
  once-only **Rescue instinct** preserves 1 HP on a lethal hit; a later hit can
  defeat you. Save/load preserves its spent receipt. It competes with Tidal charm.
- Boss only: **Z — Awaken conduit** grants a two-turn ward to the guardian.
  **X — Arc bolt** then redirects half its direct lightning damage to the caster,
  whose own defenses/shields apply. Only damage actually received by the guardian
  charges its seal: an 18-point bolt becomes 9 guardian damage and 9 seal charge.
  Redirected packets cannot redirect again.

Resolve with **B**. The combat log names interception operations and their source;
previews display amounts before interception. Inspect the simulator's mechanics
trace for before/after amounts, shield spending, recipient and pending event facts.

Seven saved scenarios exercise the new hooks:

| Encounter                 | Scenario                | Checks                                                                                  |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| Water and Underwater boss | `intercept-shield`      | Barrier absorbs the enemy hit and pays stamina; player remains at 80 HP.                |
| Water and Underwater boss | `intercept-healing`     | Waterlogged reduces the 20-point breath to 10 before the enemy turn.                    |
| Water and Underwater boss | `intercept-last-breath` | Rescue charm saves the first lethal hit at 1 HP; the following round defeats the diver. |
| Underwater boss           | `intercept-conduit`     | Half a lightning bolt redirects; guardian ends at 491 HP and seal charge is 9.          |

Edit these reusable triggers under **Shared combat passives**: `air-barrier`,
`waterlogged-healing`, `rescue-instinct` and `seal-conduit`. The first three
support both encounters; the last demonstrates the guardian-specific ward.
