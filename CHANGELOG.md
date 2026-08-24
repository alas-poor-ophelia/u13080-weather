# Changelog

Release notes are taken from the matching `## <version>` section by the release workflow.

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
