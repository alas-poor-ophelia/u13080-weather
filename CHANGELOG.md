# Changelog

Release notes are taken from the matching `## <version>` section by the release workflow.

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

New optional fields, all in [docs/API.md](https://github.com/alas-poor-ophelia/u13080-weather/blob/0.3.0/docs/API.md). Absent means exactly the behaviour
0.2.0 had, so existing worlds, presets and hashes are untouched.

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
