# Changelog

Release notes are taken from the matching `## <version>` section by the release workflow.

## Unreleased

### Plugin API (API version 1)

Additions for plugins that build on the weather. Nothing about a day's weather changes.

- `apiVersion: 1`, and `types/wadjet.d.ts`: a standalone declaration file for the whole API,
  checked against the plugin by its own test suite.
- `getReport(zoneId)` without a time means today. `timeAt(day, zoneId?)` returns the day as the
  generator sees it (era tags, hemisphere flip); `format` and `parse` go through the active
  calendar.
- Time control: `canSetNow()`, `setNow(day)` and `advance(days)` move the active calendar's day.
  Time adapters gain optional `setNow` and `subscribe`; the internal calendar implements both.
  The next/previous-day commands now move whichever calendar is active.
- `classify(report)`: Beaufort force, compass point, oktas, visibility class, precipitation class
  and feels-like temperature, each from a cited published scale. `glyphKey` and `glyph` give a
  monochrome SVG icon per report.
- Interpreters: `registerInterpreter`, `listInterpreters`, `getInterpreter` and `interpret` let a
  game-system plugin say what weather means for its game; Wadjet ships none. The code block gains
  `interpret: <id>` to show a ruling under the card.
- Zones: a note can name its zone with a `weather-zone` frontmatter key (built-in resolver
  `wadjet.frontmatter`), and a code block without `zone:` uses it. Resolvers may be async
  (`resolveAsync`, `resolveZoneAsync`, 2000 ms per resolver).
- New events `resolvers-changed`, `interpreters-changed` and `unload`, and the workspace event
  `wadjet:unload`. After unload the API object throws; get it again on the next `wadjet:ready`.

**Changes to existing behaviour:**

- Event callbacks now receive one payload object (`{ type, ... }`, frozen). Callbacks that take no
  argument are unaffected. `profiles-changed` lists the zones that changed; `time-changed` carries
  the current day and the active calendar id.
- A non-integer `dayOrdinal` now throws a `TypeError` in `getReport`, `getRange` (also
  `fromDay > toDay`, and spans over 3660 days, throw `RangeError`) and `timeAt`; it used to be
  passed through. An `hour` outside `[0, 24)` throws `RangeError`.
- `describe(report, style)` treats any style other than `"prose"` as `"short"` instead of throwing.
- A zone resolver's `resolve` is optional when it has `resolveAsync`; a resolver with neither is
  refused. Listener errors are now logged instead of swallowed.
- Switching the calendar source fires `time-changed` and `adapters-changed` instead of
  `profiles-changed`. Editing the active calendar (year length, epoch year, moons, seasons) fires
  `profiles-changed` with `all: true`, since every report moved.
- `profiles-changed` now fires on every settings save; `zoneIds` is empty when nothing that
  changes weather was touched.
- `format(dayOrdinal)` of a non-integer now throws a `TypeError`.
- `setNow` and `advance` keep the current day within ±10,000,000 (a `RangeError` beyond), and
  every day argument must be a safe integer. If the internal calendar can't save a new day, the
  day goes back and the call resolves `false`.
- The time adapter id `"internal"` is reserved for the built-in calendar (`wadjet-reserved-id`).
- An interpreter gets its own copies of the report and options.

**Display:**

- The code block shows a dry, windy day (Beaufort 6 and up, no fog) as 💨 instead of its sky
  emoji.
- The glyph set has a separate `cloudy` step from 60 % cloud cover, between `partly-cloudy` and
  `overcast` (the code block's emoji for it is still ⛅).
- `describe()` no longer repeats the precipitation type when the descriptor already names it:
  "drizzle drizzle" is now "drizzle", and a band label that already says the type (such as
  "heavy rain") is not followed by it again.

## 0.3.1

Housekeeping for the community-plugin store scan of 0.3.0. Nothing about a day's weather or a
zone's JSON changes.

- `styles.css` no longer uses `:has()` or `!important`. Per-kind window chrome is scoped on a
  `data-kind` attribute the window carries from its id, a head with a right-hanging tail is
  flagged on the head and bar, and the era name and year inputs override Obsidian's input rules
  by specificity.
- Dev dependency `electron` moves to 40, which drops `extract-zip` (advisory GHSA-jmr9-qjv8-65gv,
  no patched version exists). The e2e harness is the only consumer; the shipped plugin never
  depended on it.
- `bun run lint:scanner` now also checks `styles.css` for the two CSS rules above, so the store's
  verdict is known before a tag.

## 0.3.0

### Climate Studio

Added the Climate Studio, a new UI for easy or advanced customization of U+13080's climate data.
Open it from *Zones → Open in studio* or the *Open climate studio* command. It is a DAW-style
editor: a playlist of lanes over a calendar ruler, a mixer with a chain per channel, floating
editor windows for every part of a zone, and an audition strip that rolls one seeded year live as
you edit. It writes the same zone JSON the settings editor does, so nothing about an existing
world changes until you change it.

- Watch: [studio overview, 1:50](https://github.com/alas-poor-ophelia/u13080-weather/blob/0.3.0/media/studio-overview.mp4) ·
  [first-region tutorial, 1:49](https://github.com/alas-poor-ophelia/u13080-weather/blob/0.3.0/media/t1-first-region.mp4) ·
  [launch reel, 0:32](https://github.com/alas-poor-ophelia/u13080-weather/blob/0.3.0/media/sizzle.gif)
- Read: [README → Climate studio](https://github.com/alas-poor-ophelia/u13080-weather/blob/0.3.0/README.md#climate-studio) ·
  [Recipes](https://github.com/alas-poor-ophelia/u13080-weather/blob/0.3.0/docs/EXAMPLES.md) · [API §7c](https://github.com/alas-poor-ophelia/u13080-weather/blob/0.3.0/docs/API.md#7c-the-climate-studio)

### Schema

New optional fields, all in [docs/API.md](https://github.com/alas-poor-ophelia/u13080-weather/blob/0.3.0/docs/API.md). Absent means exactly the behaviour 0.2.0 had, so existing worlds, presets and hashes are untouched.

- `enabled` on a modifier, an op or an era (a power switch); `mods` gates on a daily modifier;
  `envelope` on an `offset`/`scale` op; `automation` lanes and `flipSeasons` on a zone; named
  moon `phases` in the calendar; `devicePresets` and `regimePresets` in plugin data; a
  climate-stage `set` may take a whole `Curve`.
- `GENERATOR_VERSION` is `wadjet-gen/0.0.3`: a `mods` gate restricts a device to its source tag
  (full strength on tagged days, `1 − amount` elsewhere). The golden master is unchanged apart
  from the version string; no day's weather moves unless a zone uses the new fields.

### Calendar adapters

- `TimeAdapter.describe()` (optional) returns a `CalendarDescription`; the settings tab and the
  studio mirror a describing adapter read-only instead of showing their own controls.
- The registry notifies on unregister as well as register. API gains `calendar()`,
  `listTimeAdapters()` and an `adapters-changed` event. Registering never seizes the active slot.

### Fixes

- The settings tab re-reads its definitions when something else writes settings, so a pin or a
  zone saved while the settings window was shut is no longer missing when it reopens.
- A regime's `apply` ops honour their own `enabled` flag. Regime ops bypass the modifier engine,
  so they needed the filter separately; no math changed.

### Notes

- `main.js` is ≈742 KB minified (≈375 KB at 0.2.0); the studio is a lot of UI.

## 0.2.0

- Era timeline (*Settings → Calendar → Eras*): world-level spans of years that tag every day
  (`era:<name>`) and can bend every zone with modifier ops. Eras join the calendar hash, so
  they show in provenance. `TimeContext` gains an optional `year`.
- The zone editor accepts `//` comments and trailing commas, so the annotated examples on its
  grammar card paste as they are.
- `docs/API.md`: full reference for the API, report, adapter and resolver contracts, zone schema
  and modifier grammar. `docs/EXAMPLES.md`: a recipe book of modifiers and eras.
- Fixed: a tag set by one modifier is now visible to later modifiers the same day, as the README
  always said (spells still see only calendar tags when they replay earlier days). A spell whose
  `when` matches no day of the reference year (for example one gated on a later era) no longer
  fires every day.
- Fixed: `api.ready` is set before the API-level `ready` event fires.
- Code block `style: value` with `field:` renders one bare field (a number for notes and
  scripts); `units:` on any block overrides the setting. API gains `units()` and
  `convert(report, units?)`; the renderer and the API share one conversion table.

## 0.1.0

First alpha.

- Deterministic daily weather per zone: a WGEN-family generator over a frozen hashed RNG, so a
  day is a pure function of world seed, generator version, zone, calendar and day number.
- 26 climate presets built from thirty-year CLIGEN station records (U.S. Public Domain),
  statistically reconciled against the raw station files; presets are copied into zones on
  selection so later updates never change an existing world.
- Zones by preset or by geography (latitude, altitude, terrain, optional continentality), with
  a Köppen readout computed from the zone's own curves.
- Modifiers: a closed grammar (predicates, ops, spells, tags) with a grammar card and two
  one-click examples in the zone editor.
- Pinned days: the only weather ever stored; list, edit, delete and create from settings, in
  metric or imperial.
- ```` ```wadjet ```` code block with card / line / prose / table styles, `hour:` and relative or
  year-day dates; commands to advance the calendar, insert or pin today's weather.
- Settings on the Obsidian 1.13 declarative settings API; requires Obsidian 1.13.0.
- Public API (`window.Wadjet`, `wadjet:ready`) with time-adapter and zone-resolver hooks for
  other plugins.


Pssst. Hey. You. 

You ever wanted full weather forecasts for your fantasy world, some weirdo released a plugin for it, but they wanted you to edit complex JSON files to do anything, like some kind of nerd?

Have you thought to yourself, "wow, I really think the streamlined and modern UI of music production would apply great to tweaking climate data"?

...No? Damn.

---

Bit aside, I've added a new UI tentatively called the Climate Studio to U+13080, which allows for actual visualization and tweaking of your data. I **promise** that it's actually pretty good, even if I sound like an insane person. I've added a bunch of video recordings to the README, including [a walkthrough of creating a region for Mordor](https://github.com/alas-poor-ophelia/u13080-weather/blob/0.3.0/media/t1-first-region.mp4) from scratch, because why not. There's also [an overview video here](https://github.com/alas-poor-ophelia/u13080-weather/blob/0.3.0/media/studio-overview.mp4) showing a broader view of the concept.