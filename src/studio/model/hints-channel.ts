/**
 * The channel editor window's hint table (SPEC §3.1, §3.4 "Channel editors").
 *
 * `hints-channels.ts` (plural) owns the playlist *rows* and the day card;
 * this file owns the floating editor the row's label opens. They are separate
 * tables because they are separate surfaces with separate key-scan tests —
 * one file's controls can never satisfy the other's contract.
 *
 * House rules (SPEC §9): product microcopy, sentence case, no explainer
 * prose, no trailing full stop. The *name* says what the control is; the
 * *detail* says what moving it writes.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const CHANNEL_EDITOR_HINTS: Record<string, Hint> = {
  "channel.chart": ["Curve", "drag a keyframe ↕, double-click to add one, right-click to remove"],
  "channel.series": ["Series", "which line the keyframes belong to — the other is drawn dim"],
  "channel.rose": ["Rose", "which way each season blows from — set a bearing in a season scope"],
  "channel.envelope": ["Envelope", "drag a point ↕ strength ↔ phase — the ☾ layer's dimmer, 0 to 1"],
  "channel.scope": ["Scope", "which days the knobs write for — all year, one season, or one moon"],
  "channel.stage": ["Stage", "where in the signal path this scope's layer runs"],
  "channel.offset": ["Offset", "shifts the whole curve — writes layer:<param>"],
  "channel.season.offset": ["Season offset", "shifts this season's days only — writes layer:<param>:season:<X>"],
  "channel.swing": ["Swing", "scales the seasonal amplitude around the annual mean — writes layer:<param>:swing"],
  "channel.jitter": ["Jitter", "day-to-day spread — writes layer:<param sd>"],
  "channel.depth": ["Depth", "what the ☾ layer is worth at full envelope strength — writes layer:<param>:moon:<X>"],
  "channel.stick": ["Stick", "how well wet weather holds from one day to the next — scales precipitation.pww"],
  "channel.chance": ["Chance", "how often rain starts after a dry day — scales precipitation.pwd"],
  "channel.amount": ["Amount", "how much falls on a wet day — scales precipitation.scale"],
  "channel.season.chance": ["Season chance", "shifts this season's wet-day odds — writes layer:precipitation.pwd:season:<X>"],
  "channel.wind": ["Wind", "shifts the mean speed — writes layer:wind.speed"],
  "channel.season.wind": ["Season wind", "shifts this season's days only — writes layer:wind.speed:season:<X>"],
  "channel.gust": ["Gust", "how far a day's wind strays from the mean — scales wind.speedSd"],
  "channel.calm": ["Calm", "how often the air is still — shifts wind.calmFraction"],
  "channel.direction": ["Direction", "the bearing this season blows from — writes layer:wind.direction:season:<X>:set"],
  "channel.direction.reset": ["Station's own", "drops the season's bearing layer — a bearing has no neutral to turn back to"],
  "channel.cloud": ["Cloud", "shifts both cloud fractions — writes layer:cloud.dry and layer:cloud.wet"],
  "channel.season.cloud": ["Season cloud", "shifts this season's cloud only — writes layer:cloud.dry/wet:season:<X>"],
  "channel.humidity": ["Humidity", "shifts both humidity fractions — writes layer:humidity.dry and layer:humidity.wet"],
  "channel.season.humidity": ["Season humidity", "shifts this season's humidity only — writes layer:humidity.dry/wet:season:<X>"],
  "channel.moon": ["Moon", "the carrier this scope rides — opens its cycle"],
  "channel.writers": ["Writers → channel", "every source that writes this channel, in signal order"],
  "channel.writer": ["Writer", "what this source contributes — click to open it"],
};

/**
 * The keys `src/studio/ui/windows/channel.ts` uses.
 * `test/studio-hints-channel.test.ts` scans that file and holds this list
 * against it in both directions, so a control added without a hint fails the
 * unit gate instead of printing a raw key into the hint bar.
 */
export const CHANNEL_EDITOR_HINT_KEYS: readonly string[] = [
  "channel.chart",
  "channel.series",
  "channel.rose",
  "channel.envelope",
  "channel.scope",
  "channel.stage",
  "channel.offset",
  "channel.season.offset",
  "channel.swing",
  "channel.jitter",
  "channel.depth",
  "channel.stick",
  "channel.chance",
  "channel.amount",
  "channel.season.chance",
  "channel.wind",
  "channel.season.wind",
  "channel.gust",
  "channel.calm",
  "channel.direction",
  "channel.direction.reset",
  "channel.cloud",
  "channel.season.cloud",
  "channel.humidity",
  "channel.season.humidity",
  "channel.moon",
  "channel.writers",
  "channel.writer",
];

/** The `data-hint` attribute value for `key`; an unknown key falls back to the key itself, as `hintAttr` does. */
export const channelEditorHint: HintLookup = makeHintLookup(CHANNEL_EDITOR_HINTS);
