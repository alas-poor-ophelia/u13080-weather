# U+13080 Weather

Deterministic, data-driven weather for TTRPG or fictional worldbuilding in Obsidian.

This plugin lets you define a world. Worlds have regions, regions have climates. Give a Worlds have seeds, and every day has weather: specifically the same weather
every time you ask, for anyone who shares the seed. So, look ahead a year, look back a
decade, and then you can pin the day the party got caught in the blizzard (exceptions to the forecast).

And it has a TypeScript API+an adapter system so other plugins can integrate with it, if they want. 

**This is stochastic generation, not simulation.** "Stochastic" meaning *driven by
probabilities*. Each zone is a statistical portrait of a real climate (taken from public weather station data): how often it rains, how much, how warm the seasons run, etc and the plugin rolls those odds forward one day at a time. It does not move air masses around, track moisture across your map, or read your heightmap, and two zones next to each other do not know about each other. See [`NON-GOALS.md`](NON-GOALS.md) for the full list of things it will not do.

_During alpha, capabilities may change somewhat, but broadly I plan on the above staying true_

Requires Obsidian **1.13** or later. Desktop; mobile is not marked unsupported but has not been
tested extensively, yet (alpha).

## How does it work?

U+13080 Weather uses a model called WGEN (and its descendants). This is the same model that agricultural scientists have used since the 1980s to make synthetic weather for crop and erosion studies. For each day:

1. **Wet or dry?** A weighted coin flip, where the odds depend on whether *yesterday* was wet. Rain tends to follow rain. The two odds (wet-after-wet, wet-after-dry) change through the year, so the wet season is ensured wet and the dry season is guaranteed dry.
2. **How much?** On a wet day the amount is drawn from a skewed distribution: most wet days are light, a few will be deluges. Its shape also changes through the year.
3. **How warm?** Temperature is drawn around the seasonal average, with a "memory" of yesterday so hot spells and cold snaps cluster rather than jitter. Wet days run cooler.
4. **Everything else**  (wind, humidity, cloud, visibility) is derived in the same way, some of it conditioned on wet or dry.

All these odds are drawn from a  real weather station's thirty-year record (see *Data*). What makes the plugin *deterministic* is where the "random" numbers come from: every draw is a hash of (world seed, zone, day number, what is being drawn). 

## Install

If you’re reading this really early, it may not be available for download in the Community Store yet, but it will be. If it is, do that. 

If it’s not:

- **BRAT:** add `https://github.com/alas-poor-ophelia/u13080-weather` as a beta plugin.
- **Manual:** download `main.js`, `manifest.json` and `styles.css` from the latest release into
  `<vault>/.obsidian/plugins/wadjet/`, then enable *U+13080 Weather* in *Settings → Community
  plugins*.

## Quick start

1. *Settings → U+13080 Weather → Zones → Add zone.* Name it, pick a climate (or describe the place with latitude, altitude, terrain, and the nearest climate is picked and adjusted).
2. Put a block in a note:

   ````markdown
   ```wadjet
   zone: greywold-highlands
   date: today
   style: card
   ```
   ````

3. Advance the calendar with the *Advance the calendar one day* command, or set *Current day* in settings. The block will update accordingly.

## The code block

````markdown
```wadjet
zone: greywold-highlands   # the zone id; omit to use the first zone
date: today                # today | +3 | -1 | 412 (a day number) | 3-14 (year-day)
hour: 14                   # optional; adds the temperature at that hour and whether rain is falling
style: card                # card | line | prose | table | value
range: 7                   # table only: days from `date`
field: precipitation.amount   # value only: which number (or word) to show
units: imperial            # optional; otherwise the setting
```
````

- **card** — icon, summary sentence, and a temperature / precipitation / wind / sky / humidity /
  visibility grid.
- **line** — one line: `🌧 Year 3, day 14: Cold, steady rain, breezy from the WSW, overcast. 1.1 to 7.8 °C.`
- **prose** — a short paragraph for reading aloud (**extremely rough for the alpha**)
- **table** — one row per day for `range` days; pinned days are marked with a 📌.
- **value** — just one field, bare, in the chosen units: `field: precipitation.amount` gives
  `4.2` (mm) or `0.17` (in). Fields: `temperature.high/low/mean/current`,
  `precipitation.type/amount/intensity/active`, `humidity`, `cloudCover`, `wind.speed/directionDeg`,
  `visibility`, `regime`, `conditions`, `descriptors.temperature/precipitation/wind/sky`.

Day numbers count from the first day of year 1 (which is day 0). Dates like `3-14` are
*year-day* in the internal calendar: year 3, the 14th day. Units (metric or imperial) are a
setting.

## Commands

Access these through Obsidian's Command Palette to access various shortcuts and pieces of functionality.

| Command | Does |
|---|---|
| Advance / Rewind the calendar one day | moves the internal calendar's current day |
| Insert today's weather | writes a one-line summary at the cursor |
| Insert a weather codeblock | inserts a ```` ```wadjet ```` block for the first zone |
| Pin today's weather | freezes today's generated weather for the first zone as a pinned day |
| Refresh weather blocks in this note | re-renders the active note |

## Pinned days

For various reasons, generated weather is never stored, rather it is recomputed on demand from the seed. The only weather the plugin *saves* is what you “pin”. A pinned day always wins over generation, survives seed and generator changes, and can be edited from *Settings → Pinned days*: temperature, precipitation, wind, and a note. 

This is for one off storytelling events. Party got lost in a blizzard, the moon fell and there was a bunch of dust…. Etc.

## Zones and climates

A zone is a climate you define. When you pick a preset it is **copied** into the zone, so if a plugin update changes the climate data (which shouldn’t really happen, but if it does), your pre-existing weather won’t change.

Every zone row shows its **Köppen class**, which is the standard shorthand geographers use for climates, computed from the zone's own numbers. 

The first letter is the broad/high level climate descriptor: **A** tropical, **B** dry, **C** temperate, **D** continental (cold winters), **E** polar. 

The next letters say when the rain comes (**f** all year, **s** dry summer, **w** dry winter, or for dry climates **W** desert / **S** steppe) and how warm it gets (**a** hot summer, **b** warm, **c** cool, **d**
brutally cold winter; **h** hot / **k** cold for dry climates). So *Cfb* is "temperate, rain all
year, warm summers"  (Bergen, or London); *Dfc* is "cold winters, rain all year, short cool
summers"  (the taiga). It’s purely informational, and will change when you change the climate of a region.

_Also I’m not an expert, even remotely on all this, so if you spot an error, let me know!_

### Presets

Built from thirty-year station records (see *Data* below). The name is a flavour label so you can better understand what you’re picking (no association with the original data), but the station is the source of truth for any of the numbers.

| Preset | Köppen | Station |
|---|---|---|
| Alpine Pass | Dfc | Fremont Pass, United States (3475 m) |
| Altiplano | Cwb | Toluca, Mexico (2638 m) |
| Atlantic Green | Csb | A Coruña, Spain |
| Bayou | Cfa | Ponchatoula, United States |
| Birch Heartland | Dfb | Kolomna, Russia |
| Equatorial Rainforest | Af | Singapore Changi |
| Fjord Coast | Cfb | Bergen, Norway |
| Frozen Heartland | Dfc | Hatyryk-Homo, Russia |
| Hill Station | Cwa | Shimla, India (2202 m) |
| Kulunda Steppe | Dfb | Slavgorod, Russia |
| Monsoon Coast | Af | Kuantan, Malaysia |
| Monsoon Taiga | Dwb | Pogranichnyj, Russia |
| Olive Coast | Csa | Jerez de la Frontera, Spain |
| Pamir Plateau | ET | Sajmak, Tajikistan (3840 m) |
| Prairie | Dfa | Valley, United States |
| Rain-Shadow Vale | Dfc | Rösta, Sweden |
| Red Desert | BWh | Undoolya, Australia |
| Savanna | Aw | Darwin, Australia |
| Sertão | Aw | Icó, Brazil |
| Silk Road Basin | BSk | Lanzhou, China (1518 m) |
| Southern Oceanic | Cfb | Hobart, Australia |
| Storm Isle | ET | Jan Mayen, Norway |
| Taiga | Dfc | Sodankylä, Finland |
| Tundra | ET | Ny-Ålesund, Norway |
| Wet Tropics (windward) | Am | Kuranda, Australia |
| Tableland (leeward) | Aw | Mareeba, Australia |

### Choosing by geography

If none of the names fits what you’re picturing, you may attempt to define the place instead and the plugin will pick the nearest preset and adjusts it:

- **Latitude** sets the baseline warmth:  hot at the equator, colder toward the poles. The curve is borrowed from Azgaar's Fantasy Map Generator, so theoretically the weather in here will agree with the weather in there.
- **Altitude** cools things down by 6.5 °C for every 1000 m of height, which the standard atmospheric lapse rate (mountain tops are cold).
- **Southern hemisphere** flips the seasons, so a zone at −40° has its winter in the middle of
  the year.
- **Terrain** *windward* slopes face the prevailing wind and catch its rain; *leeward* slopes
  sit behind a range in its rain shadow. This only steers which preset is chosen.
- **Continentality** (optional) — how far from the sea, on a 0–1 scale. Water stores heat, so
  coasts generally have mild winters and cool summers while deep interiors will swing hard between the two. Turn on *Adjust the seasonal swing* to scale the summer–winter swing accordingly; leave it off and the zone keeps the swing of the station it was matched to.

The notice after adding tells you exactly what was done and which station you ended up with.

### Modifiers

Zones can carry *modifiers*: It’s worldbuilding detail, allowed to bend the rules, a way to hopefully support a wide variety of settings and worlds without needing to add in specific support for everything. They are how you get a stormy moon, a volcano's ash season, or a cursed valley where it never rains.

The zone editor (*Zones → Edit*) has a folded card with the full grammar and two examples you can add with one click; the same two are below.

> **Q**: Really, I have to edit JSON?
> **A**: Yes, for now. I'll worry about a UI when all this is more cemented.

A stormy spring tide whenever the moon *Sable* is near full (add a moon called "Sable" in
*Settings → Calendar* first):

```json
{
  "id": "sable-stormtide",
  "stage": "daily",
  "when": { "moon": { "name": "Sable", "phase": [0.88, 1.0] } },
  "apply": [
    { "param": "precipitation.pwd", "op": "scale", "value": 1.5 },
    { "param": "wind.speed", "op": "offset", "value": 12 }
  ],
  "tag": "stormtide"
}
```

Ashfall *spells*: dry, dark runs of days that start about once a year in late summer and last
a couple of weeks:

```json
{
  "id": "ashfall",
  "stage": "daily",
  "when": { "yearPhase": [0.61, 0.72] },
  "spell": { "meanStartsPerYear": 0.6, "meanDurationDays": 18 },
  "apply": [
    { "param": "precipitation.pwd", "op": "set", "value": 0 },
    { "param": "precipitation.pww", "op": "set", "value": 0 },
    { "param": "cloud.dry", "op": "set", "value": 0.95 }
  ],
  "tag": "ashfall"
}
```

Reading them:

- **`when`** is the condition. A moon **phase** runs 0 (new) → 0.5 (full) → 1 (new again);
  **`yearPhase`** is how far through the year you are, 0 to 1, so `[0.61, 0.72]` is roughly
  August–September in a northern-hemisphere year. Ranges wrap around the end. Conditions can also test a day-of-year range, a tag, the current regime, or a seeded **`chance`**, and combine with `all` / `any` / `not`.
- **`apply`** is what changes: a **`param`** is one of the climate's dials — `precipitation.pwd`
  is the chance a dry day is followed by a wet one, `precipitation.pww` the chance a wet day is followed by another, `wind.speed`, `cloud.dry` (cloudiness on dry days), `temperature.mean`, and so on, and **`op`** is how: `set` it, `offset` it by an amount, `scale` it by a factor, or `clamp` it between limits.
- **`spell`** turns a condition into an *event with duration*: instead of applying on every
  qualifying day, spells start now and then (`meanStartsPerYear`) and run for a while
  (`meanDurationDays`). Use `chance` for a single freak day, `spell` for a run of days.
- **`tag`** is added to the day's conditions while the rule is active, so it shows in the card
  and other rules can react to it. A modifier with a tag and no `apply` is pure flavour.

Under the modifiers sits a **regime** layer you normally never touch: a few background weather
patterns (settled, unsettled, stormy…) that persist for days at a time and nudge the odds, so
weather arrives in stretches the way real weather does.

The complete grammar, with every parameter path and the exact rules for each predicate, is in [docs/API.md](docs/API.md#7-modifier-grammar).

### Eras

Seasons repeat; eras don't. *Settings → Calendar → Eras* is the world's long history as a list of
year spans (JSON, comments allowed):

```json
[
  { "name": "Ice Age", "from": 1200, "to": 1900,
    "apply": [
      { "param": "temperature.mean", "op": "offset", "value": -8 },
      { "param": "precipitation.scale", "op": "scale", "value": 0.7 }
    ] },
  { "name": "Thaw", "from": 1901, "to": 1950 },
  { "name": "Long Summer", "from": 1951 }
]
```

- Years are the calendar's own year numbers, both ends inclusive; leave out `to` for "until the
  end of time". Eras chain by listing them; overlapping eras all apply.
- Every day inside an era carries the tag `era:<name>`, so a zone's modifiers can react to it
  (`{ "tag": "era:Thaw" }`) — a valley that floods in the Thaw while the mountains merely drip.
- `apply` (optional) bends **every zone** for the era's span with the same ops a modifier uses.
  Era ops run after the zone's own modifiers.
- Eras are steps, not cycles: you write the arc of history and the generator follows it. Nothing
  drifts on its own. Changing eras changes past weather (they are part of the calendar hash).

More recipes — seasons, moons, eras, curses — in [docs/EXAMPLES.md](docs/EXAMPLES.md).

## Climate studio

If you'd rather not hand-write the JSON above, the studio is a DAW-style editor for one zone's
climate: a **playlist** of lanes over a calendar ruler you can zoom from a two-day window out to
eleven centuries, a **mixer** with a chain per channel (TEMP, PRECIP, WIND, SKY) plus a MASTER,
floating **editor windows** for whatever you clicked, and a live **audition strip** along the
bottom showing one seeded year rolled through the whole path.

**It is an editor, not a simulator.** It writes the same zone JSON the settings editor does —
anything you build in it you could have typed by hand, and *Zones → Edit* is still there for when
you'd rather type. It invents nothing: every climate number still comes from the shipped station
presets and the edits you make on top of them. And it changes past weather only where the JSON
already would — the same knobs, the same rules, and the same warning that you are doing it.

**Opening it.** *Settings → U+13080 Weather → Zones → Open in studio* on a zone row, or the *Open
climate studio* command (which asks which zone if you have more than one). There is one studio
tab; opening another zone re-points it rather than piling up tabs.

**The signal path.** The lanes and the chains are laid out in the order the generator runs:

1. **Station** — the preset copied into the zone. The `SRC` chip opens the Atlas, where you re-base
   the zone on another station or match one by geography.
2. **Baseline curves** — the four channels as yearly curves.
3. **Climate-stage layers** — unconditional edits to those curves: the channel editor's offset,
   scale, swing and drawn keyframes.
4. **Regimes** — the sticky background states, slot `00` in every chain.
5. **Devices** — your modifiers, in rack order: `when` × `apply`, plus optional spells, mod gates
   and an onset envelope carried on a moon.
6. **Forcings** — the zone's master: a temperature trim, a wetness factor, and the `FRC · warmth`
   lane that walks a value across the years.
7. **Eras** — the world's spans of history, which bend every zone.
8. **Pins** — days you fixed by hand (right-click a day in the audition strip).
9. **The roll** — the weather itself. Audited, never drawn on.

**Every window shows what it writes.** Each editor window carries a `Writes →` footer with the
exact JSON it produces, and `{ } JSON` in the header opens a read-only drawer with the whole zone
file beside the world's eras, seasons and moons. The file is derived; you never type it.

**Undo and Save.** ↶ / ↷ step back and forward one edit (one per knob drag). Nothing reaches disk
until you press Save, which reads `Saved ✓` when there is nothing to write, `Save ●` when there
is, carries a `⚠` count for warnings, and turns red with a count when something is actually wrong.
Errors block saving; the offending unit's LED and its window's footer say what is wrong.

**Third-party calendars.** Seasons and moons come from whichever calendar is active. If a calendar
plugin describes its own (see the [`CalendarDescription`](docs/API.md#calendardescription)
contract), the Seasons and cycle windows mirror it read-only — the badge reads
`<plugin> · read-only` and points you back at that plugin to edit it. The internal calendar stays
editable in place.

The ids the studio writes into `modifiers[]` (`layer:*`, `forcings:*`) and its `frc.warmth`
automation lane are documented in [docs/API.md](docs/API.md#7c-the-climate-studio). A hand-written
zone can ignore all of it; anything the studio does not recognise it leaves alone and shows as an
ordinary device.

## On Determinism

A day's weather is a pure function of five things: the world seed, the generator version, the
zone profile, the calendar and the day number, and nothing else. Nothing runs in the background and nothing is cached (except pinned events).

- **Same seed === same weather.** Any two vaults with the same seed/same generator version are **guaranteed** to be the same. A "real" feeling weather system is pretty useless for a consistent world if it can change at random.
- **The generator is pinned per world.** When a plugin update changes the numbers, your world will keep using the version it was created with until you press *Upgrade* in settings. 
- **Pinned days survive everything.**

Changing the seed, the year length, a zone's climate, the calendar's moons or the eras does change past weather; I have tried to make it clear where this is the case.

> **Q**: So will the generator just constantly be getting breaking changes? Can I not take advantage of new features without risking my weather changing?
> **A**: During the alpha, honestly.... yeah, probably. I'll do my best, but there may be some flex out of necessity. After the alpha, I expect it to be very rare. Think of this as a safety lever you hopefully don't need

## Other Plugins (API)

The API is `app.plugins.plugins.wadjet.api` (also `window.Wadjet`). Wait for it:

```ts
const wadjet = () => (this.app as any).plugins.plugins.wadjet?.api;
if (wadjet()?.ready) init(wadjet());
else this.registerEvent(this.app.workspace.on("wadjet:ready", () => init(wadjet())));
```

```ts
interface WadjetAPI {
  version: string; 
  ready: boolean;
  schemaVersion: number; 
  generatorVersion: string; rngVersion: string;

  getReport(zoneId: string, time: TimeContext | { dayOrdinal: number; hour?: number }): WeatherReport;
  
  getRange(zoneId: string, fromDay: number, toDay: number): WeatherReport[];
  
  now(): TimeContext | null;
  
  listZones(): Array<{ id: string; name: string }>;
  
  describe(report: WeatherReport, style?: "short" | "prose"): string;
  units(): "metric" | "imperial";                            // the display setting
  convert(report: WeatherReport, units?): ConvertedReport;   // °F / in / mph / mi, or metric, keys without unit suffixes

  registerTimeAdapter(adapter: TimeAdapter): () => void;     // your calendar supplies "now"
  registerZoneResolver(resolver: ZoneResolver): () => void;  // your map says which zone a hex is in
  resolveZone(locator: ZoneLocator): string | null;
  on(event: "ready" | "profiles-changed" | "time-changed", cb: () => void): () => void;
}
```

`WeatherReport` is a plain object and always metric: temperature (low/high/mean, `current` when an hour is given), precipitation (type, mm, intensity, `active`), wind (km/h, degrees from), cloud cover, humidity, visibility, descriptor words, conditions, `overridden`, and provenance (seed, versions, zone hash). Everything is rounded (0.1 °C, 0.1 mm) so that results match across JavaScript engines. `convert(report)` gives the same thing in the user's units with plain key names (`precipitation.amount`, `wind.speed`, `visibility`) and a `labels` object for display.

A **time adapter** gives the plugin a calendar (`now()`, `toContext(dayOrdinal)`, optionally
`parse`/`format`); a **zone resolver** answers "which zone is this note / hex / point in" for
locator kinds it declares. Both are unregistered by calling the function they return.

The full field-by-field reference — every API member, the `WeatherReport` schema, the adapter and resolver contracts, the zone profile schema and the complete modifier grammar — is in [docs/API.md](docs/API.md).

> **Q**: Can I use this with Meta Bind/JS Engine/Templater/DataviewJS/etc, rather than writing or installing a whole other plugin?
> **A**: Sure, so long as whatever solution you're using has the ability to import U+13080, it's all just JS.

## Data

The presets are derived from **CLIGEN** station files. CLIGEN is the U.S. Department of
Agriculture's weather generator (the same family of model as this plugin); each of its station
files distills a real station's daily record  (thirty years, in the set used here) down to the
monthly odds and averages the generator needs. The plugin reads those files and converts them to its own units and curves.

> Fullhart, A.; Nearing, M. A.; Armendariz, G.; Weltz, M. A. (2020). *International Climate
> Benchmarks and Input Parameters for a Stochastic Weather Generator, CLIGEN.* Ag Data Commons.
> https://doi.org/10.15482/USDA.ADC/1518706 — U.S. Public Domain.
> Companion paper: Fullhart et al. (2021), *Earth Syst. Sci. Data* 13, 435–446.

Each preset records its station, record length and this DOI in its `source` field. The
generator's output is checked against the raw station files (`bun run validate`, report in
`docs/VALIDATION.md`): it generates many years of weather for each station and compares the statistics — wet days, rainfall, temperatures — with the station's own numbers. 

There are two caveats:

- **Wind directions** for stations outside the United States are interpolated from US analogue
  stations in the source data, so a Norwegian coast gets an Alaskan coast's wind rose. Speeds and calm days are plausible; prevailing *directions* are not actually local. Just using the data I have.
- **Cloud cover** is not directly in the station files; it is estimated from how much sunshine the station recorded (derived via the FAO-56 Ångström relation; basically, less sunshine, more cloud). The extra cloud and humidity on wet days are rules of thumb.

## Known limitations (alpha)

- No spatial correlation between zones; no accumulated ground state (snow depth, mud); no
  frontmatter writer; no sidebar.
- `insert-today` and `pin-today` act on the first zone.
- No hail, thunder or fog as distinct precipitation types (fog is a condition derived from humidity and wind).
- Regime-gated `spell` modifiers use the current regime for their lookback.

## Licence

MIT — see [`LICENSE`](LICENSE).
