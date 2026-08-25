# Changelog

Release notes are taken from the matching `## <version>` section by the release workflow.

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
