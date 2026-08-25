# Wadjet (U+13080 Weather) — API Reference

This is a field-by-field reference to the plugin's public surface, generated from source, not
from intent. Where the design doc (`DESIGN-v1.md`) and the shipped code disagree, this document
describes the code — the thing a consumer plugin actually talks to.

**Stability.** The whole plugin is alpha (see the README). Nothing in this surface — the API
object's shape, the `WeatherReport` schema, the modifier grammar, the code block options — is
frozen. The one hard guarantee is the determinism contract (§9): for a fixed `(worldSeed,
generatorVersion, zoneProfile, calendarConfig, dayOrdinal)` the output never changes. Everything
else can and will move during alpha.

## Getting the API object

The API is `app.plugins.plugins.wadjet.api` (also mirrored at `window.Wadjet`). It does not exist
until the plugin has loaded, and its `ready` flag is `false` until settings and zones have
finished loading. Wait for the `wadjet:ready` workspace event (from the README):

```ts
const wadjet = () => (this.app as any).plugins.plugins.wadjet?.api;
if (wadjet()?.ready) init(wadjet());
else this.registerEvent(this.app.workspace.on("wadjet:ready", () => init(wadjet())));
```

The API object's own `on("ready", cb)` event fires at the same moment (see §2); the workspace event is the one you can register for before the plugin has loaded.

---

## 1. `WadjetAPI`

```ts
interface WadjetAPI {
  version: string;
  ready: boolean;
  schemaVersion: 0;
  generatorVersion: string;
  rngVersion: string;

  getReport(zoneId: string, time: TimeContext | { dayOrdinal: number; hour?: number }): WeatherReport;
  getRange(zoneId: string, fromDay: number, toDay: number): WeatherReport[];
  now(): TimeContext | null;
  listZones(): Array<{ id: string; name: string }>;

  registerTimeAdapter(adapter: TimeAdapter): () => void;
  registerZoneResolver(resolver: ZoneResolver): () => void;
  resolveZone(locator: ZoneLocator): string | null;

  describe(report: WeatherReport, style?: "short" | "prose"): string;
  on(event: "ready" | "profiles-changed" | "time-changed", cb: () => void): () => void;
}
```

### `version`

Type: `string`. The plugin manifest's version (`this.manifest.version`), not the schema or
generator version.

### `ready`

Type: `boolean`. `false` at construction; flipped to `true` at the end of `onload()`, immediately
before the `wadjet:ready` workspace event fires. See §2.

### `schemaVersion`

Type: `0` (literal, `SCHEMA_VERSION` in source). The shape of `WeatherReport`. Stays `0` through
alpha per its own doc comment ("0 until alpha ships").

### `generatorVersion`

Type: `string`. Currently `"wadjet-gen/0.0.2"` (`GENERATOR_VERSION`). This is the version of the
**code currently running**, not the version a given world was created with — see the note on
`WeatherReport.provenance.generatorVersion` in §4.


### `rngVersion`

Type: `string`. Identifies the frozen hash/uniform substrate (`RNG_VERSION`, defined in
`src/core/rng.ts`). Never changes without a deliberate, versioned break.

### `getReport(zoneId, time)`

```ts
getReport(zoneId: string, time: TimeContext | { dayOrdinal: number; hour?: number }): WeatherReport
```

| Parameter | Type | Description |
|---|---|---|
| `zoneId` | `string` | A zone id from `listZones()`. |
| `time` | `TimeContext \| { dayOrdinal: number; hour?: number }` | Only `dayOrdinal` (and, if you want diurnal interpolation, `hour`) are read; a full `TimeContext` (e.g. from `now()`) is accepted so you don't have to destructure it. |

**Returns:** `WeatherReport` for that zone and day (see §4). Passing `hour` (must be `[0, 24)` to
be meaningful) adds `temperature.current` and `precipitation.active` to the result.

**Throws:**
- `RangeError("Unknown zone \"<id>\".")` — no zone with that id exists.
- `Error("No calendar is available.")` — no time adapter is registered (should not happen once
  `ready` is true, since the internal calendar always registers itself).
- `RangeError` from profile validation ("profile \"<id>\" is invalid:\n  <path>: <message>...")
  if the zone's stored profile has validation *errors* (not warnings) — see §7.

**Example:**

```ts
const r = wadjet.getReport("greywold-highlands", { dayOrdinal: 412 });
const rHour = wadjet.getReport("greywold-highlands", { dayOrdinal: 412, hour: 14 });
```

### `getRange(zoneId, fromDay, toDay)`

```ts
getRange(zoneId: string, fromDay: number, toDay: number): WeatherReport[]
```

| Parameter | Type | Description |
|---|---|---|
| `zoneId` | `string` | A zone id from `listZones()`. |
| `fromDay` | `number` | First `dayOrdinal`, inclusive. |
| `toDay` | `number` | Last `dayOrdinal`, inclusive. |

**Returns:** one `WeatherReport` per day in `[fromDay, toDay]`, in order. Reports from a range
query are byte-for-byte identical to the same days fetched individually (§9) — no `hour` field
on any of them (range queries are daily-only; there is no per-hour range API).

**Throws:** same as `getReport` (unknown zone, no calendar, invalid profile).

**Example:**

```ts
const week = wadjet.getRange("greywold-highlands", 400, 406);
```

### `now()`

```ts
now(): TimeContext | null
```

**Returns:** the active time adapter's current `TimeContext`, or `null` if the active adapter
itself reports no current date (a `TimeAdapter.now()` implementation is allowed to return `null`;
the internal calendar never does). Not `null` merely because no *custom* adapter is registered —
the internal calendar is always present and is the fallback.

### `listZones()`

```ts
listZones(): Array<{ id: string; name: string }>
```

**Returns:** every configured zone's `id` and `name`, in settings order. Does not expose
validation issues (the internal `World.listZones()` does; the public API strips them) — call
`getReport`/`getRange` and catch to discover a broken profile.

### `registerTimeAdapter(adapter)`

```ts
registerTimeAdapter(adapter: TimeAdapter): () => void
```

Registers a `TimeAdapter` (see §5) under `adapter.id`. If an adapter with the same `id` is
already registered, it is replaced. If `adapter.id` matches the currently *active* adapter id in
settings, a `time-changed` event fires immediately (the active calendar effectively just
changed). Also refreshes the settings tab if it's open (the "Calendar source" dropdown lists
registered adapters).

**Returns:** an unregister function. Calling it removes the adapter *only if it is still the one
registered under that id* (a later registration under the same id is not clobbered by an earlier
plugin's cleanup).

### `registerZoneResolver(resolver)`

```ts
registerZoneResolver(resolver: ZoneResolver): () => void
```

Adds a `ZoneResolver` (see §5) to the resolution chain. Resolvers are tried in registration order
by `resolveZone`. Multiple resolvers may be registered, including several for the same locator
`kind`.

**Returns:** an unregister function that removes exactly this resolver instance.

### `resolveZone(locator)`

```ts
resolveZone(locator: ZoneLocator): string | null
```

Walks the registered resolvers **in registration order**; for each whose `kinds` includes
`locator.kind`, calls `resolve(locator)`. Returns the first non-null id that also names a real,
currently-configured zone. A resolver that throws is caught and skipped (a misbehaving
third-party resolver can't break the others or the caller). Returns `null` if no resolver
produces a valid zone id.

### `describe(report, style?)`

```ts
describe(report: WeatherReport, style?: "short" | "prose"): string
```

| Parameter | Type | Description |
|---|---|---|
| `report` | `WeatherReport` | Any report, generated or hand-built. |
| `style` | `"short" \| "prose"` (optional) | Defaults to `"short"`. |

**Returns:** a human sentence built from the report's descriptors and numbers (never from
`conditions`/tags directly except to list them). `"short"` is one line, minus-sign-typeset
temperature range, e.g. `Cold, steady rain, breezy from the WSW, overcast. −1.1 to 7.8 °C.`;
`"prose"` is a short paragraph. Both are marked "extremely rough for the alpha" in the README.

### `on(event, cb)`

```ts
on(event: "ready" | "profiles-changed" | "time-changed", cb: () => void): () => void
```

Subscribes to a `WorldEvent` (see §2). **Returns** an unregister function. A listener that
throws is caught and does not stop other listeners or the emitter.

---

## 2. Events

### API-level events (`wadjet.on(event, cb)`)

| Event | Fires when |
|---|---|
| `"ready"` | Once, from inside `onload()`, immediately after `api.ready` is set to `true` and just before the `wadjet:ready` workspace event. Only useful if you obtained the API object before the plugin finished loading; otherwise wait on the workspace event below. |
| `"profiles-changed"` | Whenever the World's state is rebuilt: zones, overrides, or the world seed changed and saved (`plugin.saveAndRebuild()` — e.g. after an edit in the zone/preset/override settings UI). Generators are invalidated and rebuilt lazily on next use. |
| `"time-changed"` | Whenever the active calendar's notion of "now" (or the set of adapters) changes: the *Advance/Rewind the calendar one day* commands, editing *Current day* or *Calendar source* in settings, editing the calendar's year length, or a newly-registered `TimeAdapter` whose id matches the currently active adapter. |

### Workspace event

| Event | Fires when |
|---|---|
| `"wadjet:ready"` (`app.workspace.trigger`) | Once, at the very end of `onload()`, **after** `api.ready` has been set to `true`. This is the event to wait on. |

---

## 3. `TimeContext`

```ts
interface TimeContext {
  dayOrdinal: number;
  yearPhase: number;
  yearLength: number;
  hour?: number;
  dayOfYear?: number;
  moons?: Array<{ name: string; phase: number }>;
  tags?: string[];
  source: string;
}
```

| Field | Type | Description |
|---|---|---|
| `dayOrdinal` | `number` (integer) | Days since the world epoch; may be negative. The primary key for weather generation — everything else in `TimeContext` is context for predicates and rendering, not an independent input. |
| `yearPhase` | `number`, `[0, 1)` | Position in the annual cycle; `0` is the calendar's own year start. Drives every `Curve` evaluation and the `yearPhase` predicate. |
| `yearLength` | `number` | Days in the *current* year, as reported by the active adapter (adapters may vary this year to year). |
| `hour` | `number`, `[0, 24)`, optional | Set only when requesting an hourly report; enables diurnal interpolation. |
| `dayOfYear` | `number`, optional | Integer day-of-year, used by the `dayOfYear` predicate (inclusive range test, §7). The internal calendar always supplies it (0-based); a third-party adapter may omit it, in which case `dayOfYear` predicates always evaluate false. |
| `moons` | `Array<{ name: string; phase: number }>`, optional | `phase` is `[0, 1)`, `0` = new, `0.5` = full. Read by the `moon` predicate. |
| `tags` | `string[]`, optional | Calendar-provided labels (seasons, festivals, eras — whatever the adapter wants). Read by the `tag` predicate. **Not** copied into `WeatherReport.conditions**; conditions come only from active modifier tags and the fog heuristic (§4). |
| `source` | `string` | The adapter's `id`. |

---

## 4. `WeatherReport`

```ts
interface WeatherReport {
  schemaVersion: 0;
  zoneId: string;
  dayOrdinal: number;
  hour?: number;

  temperature: { high: number; low: number; mean: number; current?: number };
  precipitation: { type: PrecipType; amountMm: number; intensity: number; active?: boolean };
  humidity: number;
  cloudCover: number;
  wind: { speedKph: number; directionDeg: number };
  visibilityKm: number;

  regime: string;
  conditions: string[];
  descriptors: { temperature: string; precipitation: string; wind: string; sky: string };

  overridden: boolean;
  provenance: Provenance;
}
```

### Top-level fields

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | `0` | Report shape version. |
| `zoneId` | `string` | Echoes the requested zone. |
| `dayOrdinal` | `number` | Echoes the requested day. |
| `hour` | `number`, optional | Present only if an `hour` was passed to `getReport`. |
| `regime` | `string` | The id of the synoptic `Regime` active that day (§6) — a background weather pattern (settled, stormy, ...) chosen by a seeded semi-Markov process, exposed for display and for the `regime` predicate. |
| `conditions` | `string[]` | The `tag`s of every currently-active daily-stage modifier that has one, plus `"fog"` if the fog heuristic triggered (below). Overrides can append further strings via `patch.conditions`. This is the only source of "conditions" — season/calendar tags are **not** included. |
| `overridden` | `boolean` | `true` iff a pinned override patch exists for `(zoneId, dayOrdinal)` and was applied. |

### `temperature`

All values °C, rounded to 0.1 (`Math.round(x*10)/10`).

| Field | Type | Description |
|---|---|---|
| `high` | `number` | Daily high. |
| `low` | `number` | Daily low. |
| `mean` | `number` | `(high + low) / 2` before rounding; drives the temperature descriptor. |
| `current` | `number`, optional | Only present when `hour` was given. Diurnal interpolation: `mean + (range/2) · cos(2π(hour − 15)/24)` — a cosine with a peak at **15:00** and a trough at **03:00** (`HEURISTIC.warmestHour = 15`). Stated heuristic, not station-derived. |

### `precipitation`

| Field | Type | Description |
|---|---|---|
| `type` | `"none" \| "drizzle" \| "rain" \| "sleet" \| "snow"` | See discrepancy note below — `"hail"` is *not* a value the current type or generator produces. |
| `amountMm` | `number`, mm, rounded to 0.1 | Daily total. `0` if `type === "none"`. Otherwise floored at a **0.1 mm trace**: a wet day never reports `0` (`TRACE_MM = 0.1`). |
| `intensity` | `number`, `[0, 1]`, rounded to 0.01 | `1 − exp(−amountMm / 20)`, monotone in `amountMm`. Reference points: 10 mm → 0.39, 25 mm → 0.71, 50 mm → 0.92. **Consumers should key on this field, not on `descriptors.precipitation`.** |
| `active` | `boolean`, optional | Only present when `hour` was given. `false` if the day isn't wet; otherwise whether `hour` falls inside a deterministic daily precipitation window `[start, start+length)` (wrapping midnight): `start` is a per-(seed, zone, day) uniform draw over `[0, 24)`, and `length = min(24, 2 + 12·intensity)` hours (a heavier day rains longer). |

### `humidity`, `cloudCover`

Both `number`, `[0, 1]`, rounded to 0.01 (2-decimal fraction).

### `wind`

| Field | Type | Description |
|---|---|---|
| `speedKph` | `number`, km/h, rounded to the nearest integer | |
| `directionDeg` | `number`, degrees, rounded to the nearest integer, `[0, 360)` | Compass direction the wind is blowing **from** (standard meteorological convention). |

### `visibilityKm`

`number`, km, rounded to 0.1. Derived (stated heuristic, `HEURISTIC` constants in
`src/core/report.ts`), not station data:

- Fog: if `humidity ≥ 0.92` **and** `windKph < 8` **and** precipitation is `"none"` or
  `"drizzle"`, visibility is fixed at `0.4` km and `"fog"` is added to `conditions`.
- Otherwise: start from `40` km (clear-day baseline), reduce by up to 40% for cloud cover
  (`40 × (1 − 0.4·cloud)`), then divide by `1 + factor·intensity`, where `factor` is `10` for
  snow/sleet and `4` for rain/drizzle/none.

### `descriptors`

```ts
{ temperature: string; precipitation: string; wind: string; sky: string }
```

Plain, user-editable strings — **not** a closed union in the type, because the band tables that
produce them are user-editable in settings. Consumers must key on the numeric fields above and
must never exhaustively `switch` on these strings. Computed *after* overrides and rounding, so
the words always match the numbers shown. An override can supply explicit `descriptors` values
per field, which win over the band lookup for whichever keys are present.

**Default bands** (`DEFAULT_BANDS`, used unless the zone/global settings override them). A band
applies once the value is `>=` its `from` threshold (highest matching band wins):

| Temperature (°C, on daily mean) | Precipitation (mm/day total) | Wind (km/h) | Sky (cloud cover fraction) |
|---|---|---|---|
| `< -10` → bitter | `0` → dry | `0` → calm | `0` → clear |
| `-10` → freezing | `0.1` → drizzle | `2` → light air | `0.2` → scattered |
| `0` → cold | `1` → light | `12` → breezy | `0.5` → cloudy |
| `8` → cool | `4` → steady | `29` → windy | `0.8` → overcast |
| `15` → mild | `10` → heavy | `50` → gale | |
| `22` → warm | `25` → torrential | `89` → storm | |
| `29` → hot | `50` → flooding | `118` → hurricane | |
| `35` → sweltering | | | |

The precipitation band is only consulted when `type !== "none"`; a dry day always gets the first
band's label ("dry") regardless of `amountMm`.

### `provenance`

```ts
interface Provenance {
  worldSeed: string;
  generatorVersion: string;
  rngVersion: string;
  profileHash: string;
  calendarHash: string;
}
```

| Field | Type | Description |
|---|---|---|
| `worldSeed` | `string` | The world's seed at generation time (settings). |
| `generatorVersion` | `string` | The `GENERATOR_VERSION` of the running plugin code. Settings also hold the version the world was created with (it drives the upgrade notice and the *Upgrade* button); `provenance` reports the running version. |
| `rngVersion` | `string` | The frozen RNG/hash substrate's version. |
| `profileHash` | `string` | `wh1:<8 hex><8 hex>` — two 32-bit hashes over the canonical JSON of `{ climate, regimes, modifiers }` for the zone (i.e. Tier C plus regimes/modifiers; the copied preset and geography are already baked into `climate` and don't appear separately). Changes whenever the zone's profile changes. |
| `calendarHash` | `string` | The active time adapter's `configHash()` (for the internal calendar: `ical:<8 hex>` over year length, epoch year, moons, seasons). |

Consumers wanting to cache a report should key on the full tuple `(zoneId, dayOrdinal, hour,
provenance.*)`, not just `(zoneId, dayOrdinal)` — any provenance field changing means the weather
may have changed.

---

## 5. Third-party contracts

### `TimeAdapter`

A plugin providing a calendar implements this and calls `wadjet.registerTimeAdapter(adapter)`.

```ts
interface TimeAdapter {
  id: string;
  now(): TimeContext | null;
  toContext(dayOrdinal: number): TimeContext;
  configHash(): string;
  parse?(text: string): number | null;
  format?(dayOrdinal: number): string;
}
```

| Member | Required | Contract |
|---|---|---|
| `id` | yes | Stable identity; used as the settings dropdown value and as the registration key (a second `register` under the same id replaces the first). |
| `now()` | yes | The calendar's current date as a `TimeContext`, or `null` if it has none. |
| `toContext(dayOrdinal)` | yes | **MUST be O(1) or O(log n)** — called for every warm-up day inside generation (up to 90 days per query, see §9), so anything heavier will be felt. **MUST extrapolate rather than throw** for a `dayOrdinal` outside the calendar's defined range (use the nearest defined year length or equivalent); the internal fallback adapter does this by construction. |
| `configHash()` | yes | A string identifying the adapter's *configuration* (not its current date) — folded into `provenance.calendarHash`. Should change whenever a setting that affects `toContext`'s output changes. |
| `parse(text)` | optional | Parse a calendar-native date string (e.g. from a `wadjet` code block's `date:` field) to a `dayOrdinal`, or `null` if unparseable. |
| `format(dayOrdinal)` | optional | Human-readable rendering of a day, used by the codeblock renderer and commands. |

### `ZoneResolver` / `ZoneLocator`

A plugin that owns a notion of "place" (a hex map, a note, ...) implements this and calls
`wadjet.registerZoneResolver(resolver)` so other code can ask "what zone is this?" via
`wadjet.resolveZone(locator)`.

```ts
type ZoneLocator =
  | { kind: "note"; path: string }
  | { kind: "hex"; mapId: string; q: number; r: number }
  | { kind: "point"; mapId: string; x: number; y: number }
  | { kind: "custom"; namespace: string; data: unknown };

interface ZoneResolver {
  id: string;
  kinds: ZoneLocator["kind"][];
  resolve(locator: ZoneLocator): string | null;
}
```

| Member | Contract |
|---|---|
| `id` | Identity, not otherwise enforced unique by the engine. |
| `kinds` | The locator `kind`s this resolver handles. `resolveZone` only calls `resolve` for locators whose `kind` is in this list — a resolver is never handed a shape it didn't declare. |
| `resolve(locator)` | Return a zone id, or `null` if this resolver doesn't know. May throw; `resolveZone` catches and moves to the next resolver. The returned id must also be a zone that currently exists — `resolveZone` re-checks this before returning it. |

`ZoneLocator` is a closed, tagged union; `"custom"` with a `namespace` is the escape hatch for a
locator kind not otherwise anticipated.

---

## 6. Zone profile schema

### `ZoneProfile`

```ts
interface ZoneProfile {
  id: string;
  name: string;
  schemaVersion: 1;
  geography?: Geography;
  preset?: { id: string; contentHash: string; matched: "auto" | "manual" };
  climate: ClimateParams;
  regimes: Regime[];
  modifiers: Modifier[];
  coordinate?: { x: number; y: number };
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Zone id (slugified name, unique within the world). |
| `name` | `string` | Display name. |
| `schemaVersion` | `1` | Zone profile shape version (distinct from `WeatherReport.schemaVersion`). |
| `geography` | `Geography`, optional | Present if the zone was created "by geography"; informational plus provenance for how it was matched — not re-consulted at generation time. |
| `preset` | `{ id, contentHash, matched }`, optional | Lineage: which shipped preset this zone was copied from, a content hash of that preset at copy time, and whether the match was automatic (from geography) or manual (picked by name). The preset itself is **never referenced again at runtime** — everything the generator needs lives in `climate`/`regimes` below. |
| `climate` | `ClimateParams` | The resolved climate parameters the generator actually reads (Tier C). This is the stored, editable state. |
| `regimes` | `Regime[]` | The synoptic regime layer (§6). At least one entry with `weight > 0` is required. |
| `modifiers` | `Modifier[]` | The modifier list (§7). |
| `coordinate` | `{ x: number; y: number }`, optional | Reserved for a future spatial-correlation feature; unused by generation today. |

### `Geography`

```ts
interface Geography {
  latitude: number;
  altitude: number;
  continentality?: number;
  orographic: "none" | "windward" | "leeward";
}
```

| Field | Type | Description |
|---|---|---|
| `latitude` | `number`, degrees | Used only at zone-creation time for nearest-preset matching and a latitude-based temperature adjustment (Azgaar-style piecewise constants); negative values are southern hemisphere and flip the seasonal phase. |
| `altitude` | `number`, metres | Used at creation time for a −6.5 °C/km lapse-rate adjustment. |
| `continentality` | `number`, `[0, 1]`, optional | `0` = coast, `1` = deep interior. Omit to ignore this axis when matching and to keep the matched preset's own seasonal swing. |
| `orographic` | `"none" \| "windward" \| "leeward"` | Used **only** to steer which preset is chosen (windward slopes match wetter presets, leeward drier); it does not otherwise affect the stored climate. |

### `ClimateParams`

Every numeric leaf is a `Curve` unless noted "scalar". All units per the doc comments in
`src/core/types.ts`.

#### `temperature`

| Path | Type | Units | Description |
|---|---|---|---|
| `temperature.mean` | Curve | °C | Daily mean. |
| `temperature.diurnalRange` | Curve | °C | `Tmax − Tmin`. |
| `temperature.phase` | scalar | yearPhase `[0,1)` | yearPhase of the coldest day — hemisphere lives here. **Required**, no default. |
| `temperature.wetDayOffset` | Curve | °C | Added to the mean on wet days (usually negative in summer — wet days run cooler). |
| `temperature.persistence` | scalar | AR(1) coefficient | Error outside `[0, MAX_PERSISTENCE]`; warning above `0.9` (a faint seam may appear every 64 days) — see the validation table in §7. |
| `temperature.sd` | Curve | °C | Residual SD of the daily mean; used for `sdHigh`/`sdLow` when they're absent. |
| `temperature.sdHigh` | Curve, optional | °C | Residual SD of the daily high. Falls back to `sd`. |
| `temperature.sdLow` | Curve, optional | °C | Residual SD of the daily low. Falls back to `sd`. |
| `temperature.wetDayRangeOffset` | Curve, optional | °C | Added to the diurnal range on wet days (usually negative). Falls back to `0`. |

#### `precipitation`

| Path | Type | Units | Description |
|---|---|---|---|
| `precipitation.pww` | Curve | probability `[0,1]` | P(wet given yesterday wet). |
| `precipitation.pwd` | Curve | probability `[0,1]` | P(wet given yesterday dry). |
| `precipitation.shape` | Curve | gamma shape (α) | Shape of the wet-day amount distribution. |
| `precipitation.scale` | Curve | gamma scale (β), mm | Scale of the wet-day amount distribution. |
| `precipitation.freezingPoint` | scalar | °C | Below this daily mean, precipitation becomes snow rather than rain/sleet/drizzle. |

#### `humidity`, `cloud` (`WetDrySplit`)

| Path | Type | Units | Description |
|---|---|---|---|
| `humidity.dry` / `humidity.wet` | Curve | fraction `[0,1]` | Base humidity on dry/wet days. |
| `humidity.sd` | scalar | fraction | Residual SD added on top. |
| `cloud.dry` / `cloud.wet` | Curve | fraction `[0,1]` | Base cloud cover on dry/wet days. |
| `cloud.sd` | scalar | fraction | Residual SD added on top. |

#### `wind`

| Path | Type | Units | Description |
|---|---|---|---|
| `wind.speed` | Curve | km/h | Mean wind speed. |
| `wind.speedSd` | Curve | km/h | SD of wind speed. |
| `wind.direction` | Curve | degrees from north, clockwise | Prevailing direction. |
| `wind.directionSpread` | Curve | degrees | Circular SD around the prevailing direction. |
| `wind.wetDayScale` | scalar | multiplier | Applied to speed on wet days. |
| `wind.calmFraction` | Curve | fraction `[0,1]` | Fraction of days that are calm (0 km/h). |

### `Curve` — three forms

```ts
type Curve = number | Harmonic | Keyframe[];
interface Harmonic { mean: number; amplitude: number; phase: number; }
interface Keyframe { at: number; value: number; }
```

| Form | Shape | Semantics |
|---|---|---|
| Constant | `number` | The value every day of the year. Example: `"wind.wetDayScale": 1.3` is always scalar (it's not even a Curve path); `"precipitation.scale": 6` is a Curve path pinned to `6` mm year-round. |
| Harmonic | `{ mean, amplitude, phase }` | Single-cosine seasonal curve: `mean + amplitude · cos(2π(yearPhase − phase))`. **`phase` is required** — there is no silent default (validation rejects a harmonic missing it). Example: `{ "mean": 8.5, "amplitude": 7, "phase": 0.08 }` peaks 7 above the mean near `yearPhase = 0.08` and troughs the same amount below it half a year later. |
| Keyframes | `Array<{ at, value }>` | Explicit points on the annual cycle, `at ∈ [0,1)`, interpolated with a periodic monotone (Fritsch–Carlson) cubic — interpolation never overshoots the keyframe values, so a probability curve built from probabilities stays a probability. Example: `[{ "at": 0.0, "value": 0.2 }, { "at": 0.5, "value": 0.8 }]`. Must have at least one entry; each `at` must be in `[0,1)`. |

### `Regime`

```ts
interface Regime {
  id: string;
  weight: number;
  meanDurationDays: number;
  apply?: ModifierOp[];
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique within the zone. Exposed on every `WeatherReport.regime` and readable by the `regime` predicate. |
| `weight` | `number ≥ 0` | Relative selection weight when a new regime is drawn (semi-Markov). At least one regime must have `weight > 0`. |
| `meanDurationDays` | `number ≥ 1` | Geometric mean duration before the regime is re-rolled. Validated `≤ 30` (warning, not error, above that — "long-lived states belong in a spell modifier, not a regime"). |
| `apply` | `ModifierOp[]`, optional | Daily-stage ops (§7) applied to that day's evaluated parameters whenever this regime is active — the same op vocabulary and per-path rules as a `daily`-stage modifier. |

---

## 7. Modifier grammar

```ts
interface Modifier {
  id: string;
  stage?: "climate" | "daily";   // default "daily"
  when?: Predicate;
  spell?: SpellSpec;
  apply: ModifierOp[];
  tag?: string;
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique within the zone. |
| `stage` | `"climate" \| "daily"`, default `"daily"` | See "stage semantics" below. |
| `when` | `Predicate`, optional | Condition gating a `daily`-stage modifier (or the window a `spell` may start in). **Not allowed on a `climate`-stage modifier** (climate-stage edits are unconditional) — validation errors if both are set. |
| `spell` | `SpellSpec`, optional | Turns `when` into a multi-day event (see below). Also not allowed on `climate` stage. |
| `apply` | `ModifierOp[]` | The ops to run when active, in list order. |
| `tag` | `string`, optional | Added to `WeatherReport.conditions` while the modifier is active; a modifier with a `tag` and no meaningful `apply` (e.g. `apply: []`) is pure flavour text. |

### Stage semantics

| Stage | When applied | What it edits | Conditions allowed |
|---|---|---|---|
| `climate` | Once, at profile-resolution time (not per day) — folded into the zone's resolved `climate` before any day is generated. | `Curve`-typed or scalar climate paths (per-Curve-variant table in §7) — a structural edit to the curve itself, affecting every future evaluation of it. | None — unconditional by construction; `when`/`spell` are validation errors here. |
| `daily` (default) | Per day, after that day's climate curves have been evaluated to scalars and the active regime's own `apply` list has run. | The day's already-evaluated scalar parameters (`DayParams`, one entry per `CurvePath`) via `set`/`offset`/`scale`/`clamp` — **not** the underlying Curve. Ops from multiple active modifiers apply in modifier-list order, each stacking on the previous result. | `when` and/or `spell`. |

After all daily-stage ops (regime's `apply` plus every active modifier's `apply`) are applied for
the day, the engine normalizes automatically, regardless of what any op did:
probability-typed paths (`precipitation.pww`, `precipitation.pwd`, `humidity.dry`, `humidity.wet`,
`cloud.dry`, `cloud.wet`, `wind.calmFraction`) are clamped to `[0, 1]`; strictly-positive paths
(`precipitation.shape`, `precipitation.scale`, `temperature.sd`, `temperature.sdHigh`,
`temperature.sdLow`, `wind.speedSd`, `wind.directionSpread`) are floored at a tiny epsilon;
non-negative paths (`temperature.diurnalRange`, `wind.speed`) are floored at `0`;
`wind.direction` is wrapped to `[0, 360)`. An unknown parameter path throws (a typo is a
validation error, not a silent no-op).

### Predicates (closed grammar)

```ts
type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { moon: { name: string; phase: [number, number] } }
  | { yearPhase: [number, number] }
  | { dayOfYear: [number, number] }
  | { tag: string }
  | { regime: string }
  | { chance: number };
```

A predicate object must have **exactly one** of these keys — the validator rejects zero or
multiple keys, and rejects any key not in this list.

| Predicate | Shape | Semantics |
|---|---|---|
| `all` | `Predicate[]` | True iff every child is true (empty array → vacuously true). |
| `any` | `Predicate[]` | True iff at least one child is true. |
| `not` | `Predicate` | Negation of the child. |
| `moon` | `{ name: string; phase: [lo, hi] }` | True iff a moon named `name` exists in the day's `TimeContext.moons` and its `phase` (`[0,1)`, `0` = new, `0.5` = full) falls in `[lo, hi)` **on the unit circle** — the range **wraps** if `lo > hi` (e.g. `[0.9, 0.1]` covers new-moon-adjacent phases on both sides of `0`). If `lo === hi` the predicate is always false. If no moon of that name exists in the context, false. |
| `yearPhase` | `[lo, hi]`, values in `[0, 1]` | Same wrap-around-circle semantics as `moon.phase`, tested against `TimeContext.yearPhase`. |
| `dayOfYear` | `[lo, hi]`, integers in `[0, 100000]` | **Inclusive** on both ends (`dayOfYear >= lo && dayOfYear <= hi`), **does not wrap**. False if the time context has no `dayOfYear`. |
| `tag` | `string` | True iff the string is present in `TimeContext.tags` (calendar-provided — seasons, festivals, etc., not `WeatherReport.conditions`). |
| `regime` | `string` (a regime id) | True iff that regime is the one active on the day. Only known at generation time — see the `stripRegime` note below re: `spell` window estimation. |
| `chance` | `number`, `[0, 1]` | A per-day Bernoulli draw seeded by `hash(seed, zoneId, dayOrdinal, "mod:<modifierId>:chance")` — independent per day, no memory. Use this for a single freak day; use `spell` for a run of days. |

### `SpellSpec` — multi-day events

```ts
interface SpellSpec {
  meanStartsPerYear: number;   // > 0
  meanDurationDays: number;    // >= 1
}
```

Turns a `when` condition into a run of consecutive active days rather than a per-day test:

- **Start probability.** For each candidate day inside the `when` window, the per-day probability
  of a spell *starting* is `meanStartsPerYear / windowDays`, where `windowDays` is the count of
  days (0–364, a reference year) on which the **regime-stripped** `when` predicate holds — any
  `regime` sub-predicate is treated as vacuously true for this estimate, since the regime for an
  arbitrary future day isn't known in advance. The result is clamped to `≤ 1`. Draws are seeded
  by `hash(seed, zoneId, day, "mod:<id>:spell")`.
- **Duration.** Geometric with mean `meanDurationDays`, seeded by `hash(seed, zoneId, startDay,
  "mod:<id>:spell-duration")`.
- **No re-trigger while active.** A day already covered by a running spell is skipped as a
  candidate start — spells don't overlap themselves.
- **Lookback.** Whether day `d` is inside an active spell is determined by scanning backward from
  `d` for up to `min(400, ceil(meanDurationDays × 8) + 1)` days (`SPELL_LOOKBACK_MAX = 400`),
  replaying start/duration draws, so the result is a pure function of `d` regardless of query
  order or range. Validation warns above `meanDurationDays > 50` for this reason.
- **Regime-gated spells** (a `when` that includes a `regime` predicate) use the day being
  *queried*'s current regime for the entire lookback scan — a documented approximation, not the
  regime that was actually active on each earlier candidate day (regime-gated spells are unusual;
  regimes already have their own duration).

### Ops (closed grammar)

```ts
type ModifierOp =
  | { param: string; op: "set"; value: number }
  | { param: string; op: "offset"; value: number }
  | { param: string; op: "scale"; value: number }
  | { param: string; op: "clamp"; min?: number; max?: number };
```

Applied in `apply` list order, then declaration order across stacked modifiers/regime.

`param` must be one of the closed paths in the `ClimateParams` table above (§6): `climate`-stage
ops may target any `CurvePath` or `ScalarPath`; `daily`-stage ops (and a `Regime.apply`) may only
target a `CurvePath` (the corresponding evaluated `DayParams` key) — `temperature.phase`,
`temperature.persistence`, `precipitation.freezingPoint`, `humidity.sd`, `cloud.sd`, and
`wind.wetDayScale` cannot be touched by a daily-stage op or a regime.

#### Per-Curve-variant table (climate-stage ops on a `CurvePath`)

| op | on a constant | on a harmonic | on keyframes |
|---|---|---|---|
| `set` | replaced by `value` | replaced by `value` **(see note)** | replaced by `value` **(see note)** |
| `offset` | `curve + value` | `mean += value` (amplitude/phase untouched) | every keyframe's `value += value` |
| `scale` | `curve × value` | `mean ×= value`, `amplitude ×= value` (phase untouched) | every keyframe's `value ×= value` |
| `clamp` | clamped in place | **materialised to 24 evenly-spaced keyframes, each clamped point-wise** (a stated deviation from the design doc, which describes a runtime bound instead — same observable effect, one fewer Curve variant to carry around) | every keyframe's `value` clamped |

> **Note on `set`:** `ModifierOp.value` is a `number`, so `set` always replaces the target with a
> plain constant — a modifier op cannot install a harmonic or keyframe curve. (The design doc's op
> table says "replace with a full Curve"; the shipped type does not support that.)

`clamp` requires at least one of `min`/`max`; the other ops require a finite numeric `value`.
On a *daily*-stage/`ScalarPath`-excluded op, `clamp` is a plain numeric clamp with no keyframe
materialisation (there's no Curve at that stage — it's already a scalar).

### Validation (errors block generation; warnings don't)

Run via `validateProfile(zone)`; `getReport`/`getRange` throw if any **error**-level issue is
present.

| Path | Level | Condition |
|---|---|---|
| `id` | error | Zone `id` missing. |
| `climate` | error | `climate` object missing (all other climate checks are skipped). |
| `climate.<param>` (every required Curve path) | error | Not a valid Curve: not finite (constant), empty keyframe array, keyframe missing numeric `at`/`value`, `at` outside `[0,1)`, or a harmonic missing numeric `mean`/`amplitude`/`phase`, or `phase` outside `[0,1)`. |
| `climate.temperature.persistence` | error | Missing or outside `[0, MAX_PERSISTENCE]` (`MAX_PERSISTENCE` from `src/core/generator.ts`). |
| `climate.temperature.persistence` | warning | Above `0.9` — "a faint seam may appear every 64 days" (the block-warm-up seam, §9). |
| `climate.temperature.phase` | error | Missing or outside `[0,1)`. |
| `regimes` | error | Missing/empty array, or no regime with `weight > 0`. |
| `regimes[i].id` | error | Missing, or duplicate within the zone. |
| `regimes[i].weight` | error | `< 0`. |
| `regimes[i].meanDurationDays` | error | `< 1`. |
| `regimes[i].meanDurationDays` | warning | `> 30`. |
| `regimes[i].apply` | error | Same op validation as below, `stage: "daily"`. |
| `modifiers[i].id` | error | Missing, or duplicate within the zone. |
| `modifiers[i].stage` | error | Present but not `"climate"`/`"daily"`. |
| `modifiers[i]` | error | `stage: "climate"` combined with `when` and/or `spell`. |
| `modifiers[i].when` | error | Predicate shape violations (wrong key count, unknown predicate key, out-of-range values — see the Predicates table's ranges: `moon.phase`/`yearPhase` must be within `[0,1]`, `dayOfYear` within `[0, 100000]`, `chance` within `[0,1]`, `tag`/`regime` non-empty strings). |
| `modifiers[i].spell.meanStartsPerYear` | error | Not `> 0`. |
| `modifiers[i].spell.meanDurationDays` | error | `< 1`. |
| `modifiers[i].spell.meanDurationDays` | warning | `> 50` — "very long spells are looked back over at most 400 days". |
| `modifiers[i].apply` | error | Not an array; any op not an object; op's `param` not a valid path for the modifier's stage; op's `op` not one of `set`/`offset`/`scale`/`clamp`; `clamp` with neither `min` nor `max`; non-`clamp` op with a non-finite `value`. |

---

## 8. The ` ```wadjet ` code block

```markdown
​```wadjet
zone: greywold-highlands
date: today
hour: 14
style: card
range: 7
​```
```

One `key: value` line per option, `#`-prefixed lines and blank lines ignored. An unparseable line
or unknown key is collected as a rendered error (the block fails closed, showing all parse errors
at once — it does not stop at the first one).

| Key | Values | Default | Notes |
|---|---|---|---|
| `zone` | a zone id | first configured zone | Errors at render time if the id doesn't match a configured zone. |
| `date` | `today` \| `+N` \| `-N` \| an integer `dayOrdinal` \| an adapter-native date string | `today` | `+N`/`-N` are relative to the active adapter's current day (`now()`); `today`/`+N`/`-N` all error if there is no current day set. A bare integer (optionally negative) is taken as a literal `dayOrdinal`. Anything else is handed to the active adapter's optional `parse()`; errors if it returns `null` or the adapter has none. |
| `hour` | a number in `[0, 24)` | none (whole-day report) | Adds `temperature.current` and `precipitation.active`; error if outside range. |
| `style` | `card` \| `line` \| `prose` \| `table` | `card` | See below. |
| `range` | integer `1`–`366` | `7` | Only meaningful for `style: table` — the number of consecutive days starting at `date`. |

### Styles

| Style | Renders |
|---|---|
| `card` | Icon, one-line summary, and a temperature / precipitation / wind / sky / humidity / visibility grid, in the units configured in settings (metric/imperial). |
| `line` | One line, e.g. `🌧 Year 3, day 14: Cold, steady rain, breezy from the WSW, overcast. 1.1 to 7.8 °C.` |
| `prose` | A short paragraph from `describe(report, "prose")` — flagged in the README as "extremely rough for the alpha". |
| `table` | One row per day for `range` days starting at `date`, pinned (overridden) days marked with 📌. |

Day numbers count from the first day of year 1, which is `dayOrdinal 0`. `Y-D` date strings
(e.g. `3-14`) are the internal calendar's own year-day notation, parsed by
`InternalCalendar.parse`, and are one such adapter-native format among possibly others.

---

## 9. Determinism contract

A `WeatherReport` is a pure function of five inputs: **world seed, generator version, the zone's
resolved profile (climate + regimes + modifiers), the calendar configuration, and the day number
(plus hour)**. Nothing else — no wall-clock time, no call order, no caching side effects that
change output. Two vaults with identical values for those five inputs produce byte-identical
reports.

Mechanism: every random draw on day `d` is `hash(worldSeed, zoneId, d, drawName)` — never a
running RNG stream carried across days. Query cost is bounded because each day's computation
replays from a **grid-anchored warm-up**: day `d` belongs to a 64-day block, and that block's
computation always starts from a state hashed purely from `(worldSeed, zoneId, blockIndex)`,
30 days (90 for the regime layer) before the block. A single-day query and a range query that
happens to touch the same day produce the identical result, because both replay the identical
sequence from the identical anchor — agreement is structural, not the result of the chain having
"mixed enough" (which is why `persistence` and regime `meanDurationDays` are capped: capping
keeps the warm-up window long enough relative to persistence that the block seam stays invisible
in practice, not because correctness depends on it).

**What changes past weather** (anything in the five-input domain): editing a zone's climate,
regimes, or modifiers; changing the world seed; changing the calendar's year length, epoch, or
moon configuration; upgrading the generator version. **What does not**: which zone/day you
queried, in what order, or from a single-day vs. range call; overrides are layered on top of the
generated report and are the only thing the plugin persists — they always win and survive any of
the above changes. See the provenance discrepancy note (end of report) regarding
`generatorVersion` specifically.
