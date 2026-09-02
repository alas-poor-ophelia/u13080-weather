# Changelog

Release notes are taken from the matching `## <version>` section by the release workflow.

## 0.3.0

### Climate studio

A DAW-style editor for a zone's climate, opened from *Zones → Open in studio* or the *Open climate
studio* command. It writes the same zone JSON the settings editor does; *Zones → Edit* stays.

- **Playlist**: lanes over a calendar ruler, continuously zoomable from a two-day window to eleven
  centuries — the rolled regimes, the world's eras (create, move, resize and delete clips at Era
  zoom), a lane per device with a time predicate, the `FRC · warmth` automation lane, and a curve
  row per channel. Under a week-wide window the lanes give way to a card for the day itself.
- **Mixer**: a chain per channel (TEMP, PRECIP, WIND, SKY) plus MASTER. Each chain has a fixed
  strip — the regimes, and the forcings where they apply — over a rack of devices you can reorder,
  mute per chain, or click to open.
- **Insert picker**: five device kinds (trim, moon-bound, spell, tag-gated, chance) and presets —
  five shipped (Spring-tide, Volcanic, Drought curse, Monsoon burst, Föhn days) plus your own
  saved ones.
- **Editor windows**, floating and multiple: channel editors for all four channels, regime states,
  a generic device editor (when · spell · apply · mod gates), era, seasons, moon cycle, forcings,
  and the Atlas (re-base on a station, or match one by geography). Each carries a `Writes →` footer
  with the exact JSON it produces.
- **Audition strip**: one seeded year rolled through the whole path, live. Right-click a day to pin
  it; re-roll changes only the preview, never the world seed.
- **JSON drawer** (`{ } JSON`): the derived zone file beside the world's eras, seasons and moons,
  read-only, with a copy button per side.
- Undo and redo (one step per drag), per-leaf view state that survives a restart, validation
  surfaced on the unit LED and in the window footer, and a Save button that blocks on errors.
- Documented in [README](README.md#climate-studio) and [docs/API.md §7c](docs/API.md#7c-the-climate-studio).

### Schema additions

All optional; absent means exactly the behaviour 0.2.0 had, so existing worlds, presets and hashes
are untouched.

- `enabled` on a modifier, on a single op, and on an era — a power switch. `enabled: false` skips
  the thing entirely at both stages: no ops, no tag.
- `mods` on a daily-stage modifier: mod-matrix gates, `{ source, amount }`, where `source` is a tag
  and `amount` is a dimmer in `[0, 1]` scaling every op's magnitude while that tag is on the day.
  A gate at `0` mutes the ops but keeps the modifier active and tagging.
- `envelope` on an `offset`/`scale` op: `[[phase, strength]…]` sampled at the carrier moon's phase,
  so a moon-bound device can swell and fade instead of switching on.
- `automation` on a zone: `AutomationLane[]`, a value walked across the world's *years* by linear
  interpolation, applied as a daily op before the zone's own modifiers. Enters `profileHash` only
  when non-empty.
- `flipSeasons` on a zone: replaces the day's `season:*` tags with the season half a year away —
  a southern-hemisphere zone under a northern calendar. Tags only; nothing else about the day
  changes.
- Named moon phases: `phases: [{ name, at }]` on a moon in the calendar. Display metadata; the
  engine still sees `[a, b)` ranges.
- Device presets: `devicePresets` in plugin data, saved from and loaded into a device window.
- A climate-stage `set` may now take a whole `Curve`, not just a number — how the channel editor
  writes edited keyframes without touching the zone's base `climate`. A `Curve` on a scalar path
  is a validation error, at either stage.

Full reference in [docs/API.md](docs/API.md).

### Calendar adapters

- `TimeAdapter.describe()` (optional) returns a `CalendarDescription`: label, read-only flag, year
  length, seasons, moons and named phases, and a hint saying where the user edits it. The settings
  tab and the studio mirror a describing adapter read-only instead of showing their own controls.
- The time registry now notifies on **unregister** as well as register, so removing the active
  calendar falls back cleanly and refreshes everything that displayed it.
- API: `calendar()` returns the active adapter's description, `listTimeAdapters()` lists what is
  registered and which is active, and a new `adapters-changed` event fires on any change.
- Activation stays a user setting: registering an adapter does not seize the active slot.

### Fixes

- The settings tab now re-reads its definitions when something else writes settings, so a pin or a
  zone saved from the studio while the settings window was shut is no longer missing when it
  reopens.
- A regime's `apply` ops honour their own `enabled` flag. Regime ops bypass the modifier engine, so
  they needed the filter separately; no math changed.

### Notes

- `main.js` grows to ≈634 KB minified (≈375 KB at 0.2.0) — the studio is a lot of UI. Trimming it
  is on the list.
- `GENERATOR_VERSION` is unchanged (`wadjet-gen/0.0.2`) and both golden masters are byte-identical:
  none of this changes a day's weather unless you use one of the new fields.

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
