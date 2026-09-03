/**
 * The channel rows' and the day card's hint table (SPEC §3.1, §3.2).
 *
 * `hints-playlist.ts` owns the playlist *surface*'s table — the ruler, the
 * playlist itself and the four `row.*` keys the `CHANNELS` list carries as
 * data. Those four entries are written before the rows draw anything, so the
 * rows re-use the key and hand `playlistHint` a live detail from
 * `channelRowDetail` rather than forking the table.
 *
 * Everything the rows and the day card build *themselves* — the plot, the
 * card, its readouts, its chips — is here, so `hints-playlist.ts` stays the
 * contract for the surface and this file stays the contract for the rows.
 *
 * Same house rules as `hints.ts` (SPEC §9): product microcopy, sentence case,
 * no explainer prose, no trailing full stop.
 *
 * Pure: no Obsidian imports, no DOM (PLAN D3).
 */
import type { Channel } from "./compile";
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const CHANNEL_HINTS: Record<string, Hint> = {
  "channel.plot": ["Channel", "the composed curve at this zoom — click to open the channel"],
  "daycard.head": ["Day", "the generated day under the centre of the window"],
  "daycard.readout": ["Reading", "what this day reports — the same numbers a wadjet block prints"],
  "daycard.chip": ["Tag", "a tag this day carries — modifiers match on these"],
  "daycard.pin": ["Pinned day", "an override fixes this day's weather — edit it from the audition"],
  "daycard.neighbour": ["Nearby day", "the weather two days either side — click to move the window there"],
};

/**
 * The keys `src/studio/ui/rows/channel-row.ts` and `src/studio/ui/day-card.ts`
 * use. `test/studio-hints-channels.test.ts` scans both files and holds this
 * list against them in both directions, so a control added without a hint
 * fails the unit gate instead of printing a raw key into the hint bar.
 */
export const CHANNEL_HINT_KEYS: readonly string[] = ["channel.plot", "daycard.head", "daycard.readout", "daycard.chip", "daycard.pin", "daycard.neighbour"];

/** The `data-hint` attribute value for `key`; an unknown key falls back to the key itself, as `hintAttr` does. */
export const channelHint: HintLookup = makeHintLookup(CHANNEL_HINTS);

/** What each channel's label column says it writes — the detail half of `hints-playlist.ts`'s `row.<channel>`. */
const ROW_DETAIL: Record<Channel, string> = {
  temperature: "the rolled mean and its high–low band; click to open the temperature channel",
  precipitation: "the rolled wet days and their amount; click to open the precipitation channel",
  wind: "the rolled daily wind speed; click to open the wind channel",
  sky: "the rolled daily cloud cover; click to open the sky channel",
};

/** The live detail for a channel row's label, passed to `playlistHint` as an override. */
export function channelRowDetail(channel: Channel): string {
  return ROW_DETAIL[channel];
}

/** The live detail for the playlist's `playlist.daycard`, now that the card is real. */
export const DAY_CARD_DETAIL = "the generated day under the centre of the window, with its tags";
