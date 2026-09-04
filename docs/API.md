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

  calendar(): CalendarDescription | null;
  listTimeAdapters(): Array<{ id: string; label: string; active: boolean }>;

  describe(report: WeatherReport, style?: "short" | "prose"): string;
  units(): "metric" | "imperial";
  convert(report: WeatherReport, units?: "metric" | "imperial"): ConvertedReport;
  on(event: "ready" | "profiles-changed" | "time-changed" | "adapters-changed", cb: () => void): () => void;
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
already registered, it is replaced. Every register **and** unregister fires `"adapters-changed"`
(§2); if `adapter.id` matches the currently *active* adapter id in settings, it additionally fires
`"time-changed"` (the active calendar's effective `now()`/`toContext()` just changed). Also
refreshes the settings tab if it's open (the "Calendar source" dropdown lists registered
adapters).

**Which adapter is active is the user's choice in settings — registering an adapter never claims
the active slot.** A calendar plugin makes itself available; the user picks it from the
"Calendar source" dropdown.

**Returns:** an unregister function. Calling it removes the adapter *only if it is still the one
registered under that id* (a later registration under the same id is not clobbered by an earlier
plugin's cleanup). **Unregistering the active adapter is symmetric with registering it:** the
registry falls back to the internal calendar (`TimeRegistry.active` always resolves to
`adapters.get("internal")` when the configured id isn't registered), and that fallback fires both
`"time-changed"` and `"adapters-changed"` — exactly as if the internal calendar had just become
active.

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

### `calendar()`

```ts
calendar(): CalendarDescription | null
```

**Returns:** the active time adapter's `CalendarDescription` (see §5), or `null` if the active
adapter has no `describe()` — an "opaque calendar" (below). This is what Wadjet's own Seasons and
CYCLE-window editors read to decide whether to show live edit controls or a read-only summary.

### `listTimeAdapters()`

```ts
listTimeAdapters(): Array<{ id: string; label: string; active: boolean }>
```

**Returns:** every currently-registered `TimeAdapter`, in registration order, with `label` taken
from `describe().label` (or the bare `id` if the adapter doesn't describe itself) and `active`
true for exactly one entry. **`active` reflects the registry's fallback-resolved adapter** — the
one `TimeRegistry.active` actually returns — **not** the raw `activeTimeAdapter` setting: if the
setting names an id that isn't currently registered, `"internal"` is what's marked active here,
because that's what every other API call (`getReport`, `now`, `calendar`) is really using.

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

### `units()`

```ts
units(): "metric" | "imperial"
```

The user's display-units setting. Reports themselves are always metric.

### `convert(report, units?)`

```ts
convert(report: WeatherReport, units?: "metric" | "imperial"): ConvertedReport
```

The same report in the given units (default: `units()`), with unit suffixes dropped from the
key names so consumers read one shape regardless of system. Pure; the renderer uses the same
table, so a number from `convert` matches what the card shows.

```ts
interface ConvertedReport {                    // everything not listed is as in WeatherReport
  units: "metric" | "imperial";
  labels: { temperature: string; amount: string; speed: string; distance: string }; // "°C"/"°F", "mm"/"in", ...
  temperature: { high: number; low: number; mean: number; current?: number };       // °C or °F, 0.1
  precipitation: { type: PrecipType; amount: number; intensity: number; active?: boolean }; // mm (0.1) or in (0.01)
  wind: { speed: number; directionDeg: number };                                      // km/h or mph (0.1)
  visibility: number;                                                                 // km or mi (0.1)
}
```

### `on(event, cb)`

```ts
on(event: "ready" | "profiles-changed" | "time-changed" | "adapters-changed", cb: () => void): () => void
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
| `"time-changed"` | Whenever the active calendar's notion of "now" changes: the *Advance/Rewind the calendar one day* commands, editing *Current day* or *Calendar source* in settings, editing the calendar's year length, a newly-registered `TimeAdapter` whose id matches the currently active adapter, or unregistering the currently-active adapter (the registry falls back to the internal calendar). |
| `"adapters-changed"` | Whenever the set of registered time adapters changes — every `registerTimeAdapter` call and every call to the unregister function it returns, active or not. Fired in addition to (not instead of) `"time-changed"` when the change also affects the active adapter. Use this to refresh a UI that lists all adapters (e.g. `listTimeAdapters()`); use `"time-changed"` for one that only cares about the active calendar. |

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
  year?: number;
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
| `year` | `number`, optional | The calendar's year number, used by the era timeline. The internal calendar always supplies it (`epochYear` at `dayOrdinal 0`). If an adapter omits it, the era timeline counts years from 1 at day 0 using `yearLength`. |
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
| `calendarHash` | `string` | The active time adapter's `configHash()` (for the internal calendar: `ical:<8 hex>` over year length, epoch year, moons, seasons), followed by `+eras:<8 hex>` over the era timeline when one is configured. |

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
  describe?(): CalendarDescription;
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
| `describe()` | optional | A static summary of the calendar's shape, for UIs — see `CalendarDescription` below. **Absent means "opaque calendar":** Wadjet's own editors (Seasons, CYCLE windows) can't show season/moon names or a badge for it, so they hide those affordances entirely rather than guess. `api.calendar()` returns `null` for an adapter with no `describe()`. |

**Which adapter is active is the user's choice in settings, not the registering plugin's** — see
`registerTimeAdapter` above. A calendar plugin should implement `describe()` regardless of whether
it expects to be the active one; `listTimeAdapters()` reads it for every registered adapter to
build the settings dropdown's labels.

### `CalendarDescription`

```ts
interface CalendarDescription {
  label: string;
  readOnly: boolean;
  yearLength: number;
  epochYear?: number;
  seasons: Array<{ name: string; from: number }>;
  moons: Array<{ name: string; cycleDays: number; phaseAtEpoch?: number; phases?: Array<{ name: string; at: number }> }>;
  editHint?: string;
}
```

| Field | Type | Description |
|---|---|---|
| `label` | `string` | Display name for the calendar badge: `"internal calendar"` for Wadjet's own, or the plugin's chosen name (e.g. `"Almanac of Foo"`). |
| `readOnly` | `boolean` | `true` for every adapter except the internal one, unless it explicitly opts into editing. When `true`, **Wadjet's own UIs never write to this calendar** — the Seasons and CYCLE-window editors in the Studio show a `"<label> · read-only"` badge, hide the season/moon editing controls, and surface `editHint` (below) as the place to actually change it. |
| `yearLength` | `number` | A representative year length for display (e.g. in the settings summary row). Adapters whose real year length varies (leap years, irregular calendars) still report **the actual length for the day in question** in every `TimeContext.yearLength` — this field is a label, not a promise that every year is this long. |
| `epochYear` | `number`, optional | The year number at `dayOrdinal 0`, if the calendar has one. |
| `seasons` | `Array<{ name, from }>` | `from` is a **yearPhase fraction, `[0, 1)`** — the same unit as `TimeContext.yearPhase` — marking where each season begins. Mirrors the internal calendar's own season table shape. |
| `moons` | `Array<{ name, cycleDays, phaseAtEpoch?, phases? }>` | One entry per moon the calendar tracks. `cycleDays` is the synodic period in days; `phaseAtEpoch` (optional) is a **cycle-phase fraction, `[0, 1)`**, `0` = new, at `dayOrdinal 0`. `phases` (optional) names points on the cycle — e.g. `{ name: "full", at: 0.5 }` — where `at` is again a `[0, 1)` cycle-phase fraction, for UIs that want to label phases rather than just show a number. |
| `editHint` | `string`, optional | Where the user actually edits this calendar, shown as `"edit in <label>"` (or similar) next to the read-only badge. Omit if there's nowhere to point them (e.g. a purely computed calendar). |

### Worked example: a third-party calendar plugin

A complete `TimeAdapter` for a fictional "Almanac of Foo" — a 400-day calendar where every 4th
year runs a day long (`yearLength` varies by context, not by adapter), two seasons, two moons (one
with named phases), `parse`/`format`, `configHash`, and `describe()`. This is exactly the code in
`test/fixtures/api/third-party-calendar.ts`, exercised by `test/api-doc.test.ts` — if the two ever
drift, that test fails.

```ts
// mirrors test/fixtures/api/third-party-calendar.ts
import type { CalendarDescription, TimeAdapter, TimeContext } from "wadjet/time/adapter"; // illustrative import path

export function makeAdapter(): TimeAdapter {
  const YEAR_DAYS = 400;
  const LEAP_EVERY = 4; // every 4th year (index 3, 7, 11, ...) runs 401 days
  const CYCLE_DAYS = YEAR_DAYS * (LEAP_EVERY - 1) + (YEAR_DAYS + 1); // 1601
  const EPOCH_YEAR = 1;

  const SEASONS = [
    { name: "Wet", from: 0 },
    { name: "Dry", from: 0.5 },
  ];

  const MOONS = [
    {
      name: "Ember",
      cycleDays: 33,
      phaseAtEpoch: 0,
      phases: [
        { name: "new", at: 0 },
        { name: "waxing", at: 0.25 },
        { name: "full", at: 0.5 },
        { name: "waning", at: 0.75 },
      ],
    },
    { name: "Cinder", cycleDays: 91, phaseAtEpoch: 0.1 },
  ];

  /** Pure arithmetic — O(1) and safe for any finite `dayOrdinal`, including negative and huge ones. */
  function yearInfo(dayOrdinal: number): { year: number; yearStart: number; yearLength: number } {
    const cycleIndex = Math.floor(dayOrdinal / CYCLE_DAYS);
    const dayInCycle = dayOrdinal - cycleIndex * CYCLE_DAYS;
    const isLeapYear = dayInCycle >= YEAR_DAYS * (LEAP_EVERY - 1);
    const yearIndexInCycle = isLeapYear ? LEAP_EVERY - 1 : Math.floor(dayInCycle / YEAR_DAYS);
    const yearStart = cycleIndex * CYCLE_DAYS + yearIndexInCycle * YEAR_DAYS;
    const yearLength = isLeapYear ? YEAR_DAYS + 1 : YEAR_DAYS;
    const year = cycleIndex * LEAP_EVERY + yearIndexInCycle + EPOCH_YEAR;
    return { year, yearStart, yearLength };
  }

  function seasonAt(yearPhase: number): string {
    let cur = SEASONS[SEASONS.length - 1]!;
    for (const s of SEASONS) if (yearPhase >= s.from) cur = s;
    return cur.name;
  }

  function wrap(x: number): number {
    const r = x - Math.floor(x);
    return r === 1 ? 0 : r;
  }

  function toContext(dayOrdinal: number): TimeContext {
    const { year, yearStart, yearLength } = yearInfo(dayOrdinal);
    const dayOfYear = dayOrdinal - yearStart;
    const yearPhase = dayOfYear / yearLength;
    const moons = MOONS.map((m) => ({ name: m.name, phase: wrap(dayOrdinal / m.cycleDays + m.phaseAtEpoch) }));
    return { dayOrdinal, yearPhase, yearLength, dayOfYear, year, moons, tags: [`season:${seasonAt(yearPhase)}`], source: "almanac-of-foo" };
  }

  return {
    id: "almanac-of-foo",
    // This almanac doesn't track a real-world "today" — it only converts ordinals Wadjet gives it.
    now: () => null,
    toContext,
    configHash: () => `almanac:${YEAR_DAYS}:${LEAP_EVERY}`,
    parse(text: string): number | null {
      const t = text.trim();
      return /^-?\d+$/.test(t) ? Number(t) : null;
    },
    format(dayOrdinal: number): string {
      const c = toContext(dayOrdinal);
      return `Year ${c.year}, day ${(c.dayOfYear ?? 0) + 1} of ${c.yearLength}`;
    },
    describe(): CalendarDescription {
      return {
        label: "Almanac of Foo",
        readOnly: true,
        yearLength: YEAR_DAYS,
        epochYear: EPOCH_YEAR,
        seasons: SEASONS.map((s) => ({ ...s })),
        moons: MOONS.map((m) => ({ name: m.name, cycleDays: m.cycleDays, phaseAtEpoch: m.phaseAtEpoch, ...(m.phases ? { phases: m.phases.map((p) => ({ ...p })) } : {}) })),
        editHint: "Almanac of Foo settings",
      };
    },
  };
}
```

And the plugin side — waiting for `wadjet:ready`, registering, and cleaning up on unload:

```ts
export default class AlmanacOfFooPlugin extends Plugin {
  private unregisterAdapter?: () => void;

  override onload(): void {
    const wadjet = () => (this.app as any).plugins.plugins.wadjet?.api;
    const register = () => {
      this.unregisterAdapter = wadjet().registerTimeAdapter(makeAdapter());
    };
    if (wadjet()?.ready) register();
    else this.registerEvent(this.app.workspace.on("wadjet:ready", register));
  }

  override onunload(): void {
    this.unregisterAdapter?.(); // falls back to Wadjet's internal calendar if this was the active adapter
  }
}
```

This plugin never sets itself active — it registers and waits. The user picks "Almanac of
Foo" from the *Calendar source* dropdown in Wadjet's settings if and when they want it.

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
  automation?: AutomationLane[];
  flipSeasons?: boolean;
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
| `automation` | `AutomationLane[]`, optional | Values that move over the world's *years* (see `AutomationLane` below). Absent or empty is exactly the behaviour before lanes existed, and only a non-empty list enters the profile hash. |
| `flipSeasons` | `boolean`, optional | Southern-hemisphere view of the active calendar: `season:*` tags are recomputed half a year away (see `flipSeasons` below). Tags only — no climate value changes, and it is not part of the profile hash. |

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

### `AutomationLane` — a value that moves over years

Where a `Curve` moves a parameter over the *year*, a lane moves it over the world's *years*: a
warming trend, a century of drought, an age that slowly stills the wind.

```ts
interface AutomationLane {
  id: string;
  param: string;                      // a CurvePath
  op: "offset" | "scale";
  points: Array<[number, number]>;    // [[year, value], …]
  enabled?: boolean;
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique within the zone. Names the lane in the UI; generation never reads it. |
| `param` | `CurvePath` | The parameter the lane moves. Scalar paths are rejected — a lane is a daily-stage op, and the daily stage has no scalars to touch. |
| `op` | `"offset" \| "scale"` | How the lane's value is applied. `set` and `clamp` are not lane ops: a lane is a continuous value, not a replacement or a bound. |
| `points` | `Array<[year, value]>` | At least one point; years strictly ascending; every number finite. Years are the calendar's own year numbers, as `Era.from`/`to` are. |
| `enabled` | `boolean`, optional | Absent = on. A disabled lane emits nothing — but it is still hashed, so muting a lane is a change of provenance. |

| Rule | Detail |
|---|---|
| Interpolation | `value(y)` is linear between points and **clamped** to the first/last value outside the authored span. A single point is that constant everywhere. |
| The year of a day | `y = year + yearPhase`, so a point at year *N* lands on the first instant of year *N*. `year` is `TimeContext.year`, else `floor(dayOrdinal / yearLength) + 1`; a caller supplying neither (e.g. the bare `gregorianTime` helper) gets a 365-day year. |
| Where it applies | Each enabled lane becomes one daily-stage op on `param`, pushed **before** the zone's own daily modifiers and after the regime's `apply` — so a modifier can still override the lane on a given day. For `offset`/`scale` on a curve this is observably identical to a climate-stage op. |
| Hashing | `automation` enters `profileHash` only when non-empty, so a zone that has never had a lane hashes exactly as it did before lanes existed. |

### `flipSeasons` — a southern-hemisphere view of the calendar

`flipSeasons: true` gives one zone the opposite half of the year: every `season:*` tag on the day
is replaced by the season at `(yearPhase + 0.5) mod 1`, read from the active adapter's
`describe().seasons` (§5).

| Rule | Detail |
|---|---|
| Tags only | Nothing else about the day changes — not `temperature.phase`, not the curves, not the report. A flipped zone whose *climate* still peaks in the calendar's summer is a `temperature.phase` that wants moving, not a flip that failed. |
| Opaque calendars | An adapter with no `describe()`, or one describing no seasons, is unaffected: the day's tags come back untouched. The zone cannot flip what it cannot see. |
| Days with no season tag | The flipped tag is still added. `describe()` is the adapter's statement of its season layout, and a flipped zone is a view of that layout rather than of the tags the adapter happened to emit. |
| Tag order | The flipped tag takes the position of the first `season:*` tag it replaced, so tag order stays stable. |
| Who notices | Only things that read tags: `tag` predicates, `ModGate.source`, and `WeatherReport` consumers reading `TimeContext.tags`. |
| Hashing | Not part of `profileHash` — it is calendar-side. The per-zone generator cache key carries it instead. |

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
  enabled?: boolean;             // absent = enabled
  mods?: ModGate[];              // daily stage only
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
| `enabled` | `boolean`, optional | Power switch, absent = enabled. `enabled: false` skips the modifier at **both** stages: no ops, no `tag`, and its climate-stage ops are not folded into the resolved climate. Distinct from a modifier gated out by its `mods` (below), which still runs and still tags the day. |
| `mods` | `ModGate[]`, optional | Mod-matrix gates. Absent or empty is a factor of 1. `daily` stage only — `mods` on a `climate`-stage modifier is a validation error, since a climate-stage modifier is unconditional by construction. |

### Id conventions

`Modifier.id` is free text, unique within the zone — with one reservation and two conventions the
Climate Studio reads back.

| Id | Status | Meaning |
|---|---|---|
| `era:…` | **Reserved — validation error on a zone modifier** | Belongs to the era timeline: an era with ops becomes the synthetic modifier `era:<name>` (§7b). |
| `layer:<param>` | Convention | The channel editor's all-year `offset` on `<param>`, at the `climate` stage. |
| `layer:<param>:scale` | Convention | The same channel's all-year `scale`. |
| `layer:<param>:curve` | Convention | The same channel's drawn keyframes — a `set` carrying a whole `Curve`. |
| `layer:<param>:swing` | Convention | The same channel's swing — a `set` carrying the amplitude-rescaled base, re-derived whenever the offset, scale or curve under it changes. |
| `layer:<param>:season:<X>` | Convention | The trim scoped to a season tag: `offset`, `when: { tag: "season:<X>" }`, at the `daily` stage. |
| `layer:<param>:season:<X>:set` | Convention | The same season scope on an *absolute* path (wind direction): `set` rather than `offset`. |
| `layer:<param>:moon:<X>` | Convention | The trim carried on a moon: `offset` plus an `envelope`, `when: { moon: … }`, at the `daily` stage. |
| `forcings:temperature.mean` | Convention | The Forcings window's temperature trim — a climate-stage `offset`. |
| `forcings:precipitation` | Convention | The Forcings window's wetness — one climate-stage `scale` on **both** `precipitation.pwd` and `precipitation.pww`. |

`<param>` is a `CurvePath`; `<X>` is a season or moon name, verbatim. The table is the same one
[§7c](#7c-the-climate-studio) gives with the control that writes each id — that section is the
source of truth, and this one is here because `Modifier.id` is where a reader meets the
conventions first.

The conventions are exactly that — the engine reads no id but an `era:`-prefixed one and a regime
id in a `regime` predicate, so a hand-written zone can ignore them entirely. An id that carries a
convention prefix but does not decompile cleanly is shown as an ordinary device with a "custom"
chip, never dropped. On save the studio orders `modifiers[]` as `layer:*`, then devices in rack
order, then `forcings:*`; the order is meaningful (ops stack in list order) but not enforced.

### `ModGate` — mod-matrix gates

```ts
interface ModGate {
  source: string;   // a TAG, never a moon
  amount: number;   // gate strength in [0, 1]
}
```

| Field | Type | Description |
|---|---|---|
| `source` | `string` | **A tag** — `season:Harvest`, `era:Ice Age`, or a tag set by a modifier earlier in the list the same day. The engine tests tag membership and nothing else. There is no `moon:` gate: a moon shapes a modifier as its *carrier* instead, through `when.moon` plus an `envelope` (see Ops below). A `source` **starting with `moon:` is a validation error**, not a tag that happens never to match. |
| `amount` | `number` in `[0, 1]` | The gate's **strength** — how hard it restricts the modifier to `source`. `1` is a hard gate (the modifier is silent on any day without the tag), `0.5` halves it on those days, `0` is no gate at all. Anything outside `[0, 1]` is a validation error. A gate never amplifies: author the device at the magnitude you want at its strongest, inside its source. |

| Rule | Detail |
|---|---|
| Factor | **A gate restricts a modifier to its source.** Each gate contributes ×1 on a day carrying its `source` tag and ×`(1 − amount)` on every other day, and the day's gate factor is the **product** across gates — so a modifier with two gates runs whole only where *both* tags are on the day. A modifier with no gates has factor 1. Every factor is in `[0, 1]`, so the product is too. |
| Sign is safe | Because the factor `f` is in `[0, 1]` and a `scale` value is non-negative, `1 + (v − 1)·f` sits between `v` and `1` — a gate can never flip the sign of a scaled parameter. The bound is enforced by validation, not clamped by the engine. |
| What it scales | The *magnitude* of each op, not the day's value: `offset v → v · f`, `scale v → 1 + (v − 1) · f`. `set` and `clamp` pass through untouched — there is no continuous "half a `set`". |
| A gated-out modifier is **muted**, not disabled | At factor 0 the ops still run (as `offset 0` / `scale 1`), so the modifier stays active and still contributes its `tag` and its visibility to later `tag` predicates. Only `enabled: false` removes a modifier. |
| Chaining | Gates read the day's tags as the modifier's own predicate saw them, so a modifier earlier in the list can gate a later one. |
| With an envelope | Gate factor and envelope strength multiply. |

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
| `tag` | `string` | True iff the string is present in the day's tags: `TimeContext.tags` (calendar-provided — seasons, eras, festivals) plus tags set by modifiers **earlier in the list** the same day. Spells replay earlier days and see only calendar tags. Not `WeatherReport.conditions`. |
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
type ModifierOp = (
  | { param: string; op: "set"; value: number | Curve }   // a Curve value is climate-stage only
  | { param: string; op: "offset"; value: number }
  | { param: string; op: "scale"; value: number }
  | { param: string; op: "clamp"; min?: number; max?: number }
) & {
  enabled?: boolean;                    // absent = enabled
  envelope?: Array<[number, number]>;   // [[phase, strength], …]; daily stage only
};
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
| `set` | replaced by `value` **(see note)** | replaced by `value` **(see note)** | replaced by `value` **(see note)** |
| `offset` | `curve + value` | `mean += value` (amplitude/phase untouched) | every keyframe's `value += value` |
| `scale` | `curve × value` | `mean ×= value`, `amplitude ×= value` (phase untouched) | every keyframe's `value ×= value` |
| `clamp` | clamped in place | **materialised to 24 evenly-spaced keyframes, each clamped point-wise** (a stated deviation from the design doc, which describes a runtime bound instead — same observable effect, one fewer Curve variant to carry around) | every keyframe's `value` clamped |

> **Note on `set`:** `value` is `number | Curve`, so a **climate**-stage `set` can replace the
> target with a whole annual shape (a constant, a `Harmonic`, or a `Keyframe[]`) regardless of what
> the target was before — this is how the Climate Studio writes a curve without mutating the zone's
> stored `climate`. A *Curve* value is climate-stage only and only on a `CurvePath`: a daily-stage
> op gets `apply[i].value: "set with a curve is climate stage only"`, and a climate-stage `set` of a
> curve on a `ScalarPath` is likewise an error. A numeric `value` behaves as it always has at both
> stages.

`clamp` requires at least one of `min`/`max`; the other ops require a finite numeric `value`.
On a *daily*-stage/`ScalarPath`-excluded op, `clamp` is a plain numeric clamp with no keyframe
materialisation (there's no Curve at that stage — it's already a scalar).

#### `enabled` — the per-op power switch

Absent = enabled. `enabled: false` drops the op before it reaches the curves, at both stages and
in every list that carries ops: a modifier's `apply`, a `Regime.apply`, and an `Era.apply`. It is
independent of the modifier's own `enabled`: a disabled op inside an enabled modifier leaves the
modifier active, so the modifier still contributes its `tag`. Disabling every op of a modifier is
therefore *not* the same as disabling the modifier.

#### `envelope` — an onset shape carried on a moon

```ts
envelope?: Array<[number, number]>;   // [[phase, strength], …]
```

A device that fires "on the full moon" rarely wants a square edge. An envelope shapes the op's
magnitude across the carrier moon's cycle, so the effect swells and fades instead of switching.

| Rule | Detail |
|---|---|
| Carrier | The moon named in a bare `when: { moon: … }` predicate; otherwise the **first** moon of the day. If the day has no moons at all the envelope does nothing (factor 1). A `moon` nested inside `all`/`any`/`not` is not a bare `when.moon` and does not name the carrier. |
| Sampling | Points are sorted by `phase` and interpolated linearly, and the segment from the last point back to the first **wraps** across `1 → 0`, so the shape is continuous around the cycle. A single point is a constant strength. |
| Effect | Strength `s` scales the op's magnitude exactly as a gate does: `offset v → v · s`, `scale v → 1 + (v − 1) · s`. Gate factor and envelope strength multiply. |
| `set` / `clamp` | Ignore it. Validation raises a **warning** (`"envelope has no effect on set/clamp"`), not an error. |
| Stage | `daily` only — an envelope on a `climate`-stage op is an error. The engine strips `envelope` from the op before it reaches the curves. |
| Shape rules | The array must be non-empty; each point is `[phase ∈ [0,1), strength ∈ [0,1]]`. **Strength is a dimmer**: a strength above 1 is a validation error, so an envelope shapes a device's onset but never amplifies it past the magnitude the author wrote. |

### Named moon phases (`MoonConfig.phases`)

```ts
interface MoonConfig {
  name: string;
  cycleDays: number;
  phaseAtEpoch: number;
  phases?: Array<{ name: string; at: number }>;   // display metadata
}
```

Set in *Settings → Calendar → Moons*, and mirrored on `CalendarDescription.moons[]` (§5) so a
third-party calendar can name its own phases. **Display metadata only.**

| Rule | Detail |
|---|---|
| `at` | A boundary on the moon's own cycle, in `[0,1)` (`0` = new, `0.5` = full). Names unique, `at` ascending. A named phase runs from its own `at` to the next boundary, wrapping past `1 → 0`. |
| The engine never sees a name | A UI compiles a selection of named phases down to the single `moon.phase` range `[a, b)` running from the first selected phase's `at` to the boundary after the last. Round-trip: a range whose ends coincide with boundaries decompiles back to a phase selection; anything else is shown as a custom range. |
| Not hashed | `phases` is outside the config hash — renaming or re-cutting phases cannot change generated weather. |

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
| `modifiers[i].id` | error | Missing, duplicate within the zone, or starting with the reserved `era:` prefix. |
| `modifiers[i].stage` | error | Present but not `"climate"`/`"daily"`. |
| `modifiers[i]` | error | `stage: "climate"` combined with `when` and/or `spell`. |
| `modifiers[i].when` | error | Predicate shape violations (wrong key count, unknown predicate key, out-of-range values — see the Predicates table's ranges: `moon.phase`/`yearPhase` must be within `[0,1]`, `dayOfYear` within `[0, 100000]`, `chance` within `[0,1]`, `tag`/`regime` non-empty strings). |
| `modifiers[i].spell.meanStartsPerYear` | error | Not `> 0`. |
| `modifiers[i].spell.meanDurationDays` | error | `< 1`. |
| `modifiers[i].spell.meanDurationDays` | warning | `> 50` — "very long spells are looked back over at most 400 days". |
| `modifiers[i].apply` | error | Not an array; any op not an object; op's `param` not a valid path for the modifier's stage; op's `op` not one of `set`/`offset`/`scale`/`clamp`; `clamp` with neither `min` nor `max`; non-`clamp` op with a non-finite `value`. |
| `modifiers[i].enabled`, `modifiers[i].apply[j].enabled` | error | Present but not `true`/`false`. |
| `modifiers[i].mods` | error | Not an array, or present on a `climate`-stage modifier. |
| `modifiers[i].mods[j].source` | error | Not a non-empty string, **or starting with `moon:`** — "a gate is a tag; a moon is the carrier (use `when.moon`)". |
| `modifiers[i].mods[j].amount` | error | Not a number in `[0, 1]` — "gate strength: 1 restricts to the source, 0 is no gate". |
| `modifiers[i].mods[j].<field>` | warning | Unknown field on a gate — ignored. |
| `modifiers[i].apply[j].envelope` | error | Present on a `climate`-stage op, or not a non-empty array. |
| `modifiers[i].apply[j].envelope[k]` | error | Not `[phase ∈ [0,1), strength ∈ [0,1]]`. |
| `modifiers[i].apply[j].envelope` | warning | On a `set`/`clamp` op — those ops ignore it. |
| `flipSeasons` | error | Present but not `true`/`false`. |
| `automation` | error | Present but not an array. |
| `automation[i].id` | error | Missing/blank, or duplicate within the zone. |
| `automation[i].param` | error | Not a `CurvePath` (a lane cannot target a scalar path). |
| `automation[i].op` | error | Not `offset`/`scale`. |
| `automation[i].enabled` | error | Present but not `true`/`false`. |
| `automation[i].points` | error | Missing or empty — a lane needs at least one `[year, value]` point. |
| `automation[i].points[j]` | error | Not a two-number `[year, value]` pair. |
| `automation[i].points[j][0]` | error | Year not finite, or not strictly greater than the previous point's year. |
| `automation[i].points[j][1]` | error | Value not finite. |
| `automation[i].<field>` | warning | Unknown field on a lane — ignored (the same rule eras carry). |

The complete list of paths this table can produce is checked in as
`test/fixtures/studio/validator-paths.json`, generated from
`test/fixtures/studio/trip-every-rule.json` by `test/validator-paths.test.ts` — a rule with no
path there is a rule the UI has nowhere to show.

---

## 7b. The era timeline

World-level, set in *Settings → Calendar → Eras*; applies under any time adapter. Stored in
`data.json` as `eras: Era[]`.

```ts
interface Era {
  name: string;         // unique; the day tag is "era:" + name
  from: number;         // first year, inclusive
  to?: number;          // last year, inclusive; omitted = open-ended
  apply?: ModifierOp[]; // daily-stage ops (CurvePaths only), applied to every zone
  enabled?: boolean;    // absent = enabled
}
```

| Rule | Detail |
|---|---|
| Year of a day | `TimeContext.year`, else `floor(dayOrdinal / yearLength) + 1`. |
| Tags | Every era covering the year adds `era:<name>` to the day's `TimeContext.tags` (after the adapter's own tags, in list order). Readable by the `tag` predicate; not copied into `conditions`. |
| Ops | An era with a non-empty `apply` becomes a synthetic daily modifier `{ id: "era:<name>", when: { tag: "era:<name>" }, apply }` appended **after** the zone's own modifiers, so ops run zone → era. Same op semantics and validation as a daily-stage modifier (no scalar paths). |
| Overlap | Overlapping eras all apply, in list order. |
| `enabled` | Absent = on. `enabled: false` makes the era invisible for the whole timeline: no `era:<name>` tag, no synthetic modifier, no ops. It is still hashed, so muting an era changes provenance. Individual ops inside `apply` carry their own `enabled` (§7). |
| Provenance | `calendarHash` gains `+eras:<hash>`; the per-zone generator cache is keyed on it. Editing eras changes past weather. |
| Reserved | Zone modifier ids may not start with `era:` (validation error). |
| Validation | `name` required and unique; `from`/`to` whole years, `to ≥ from`; `apply` validated as daily ops; `enabled` boolean if present; unknown fields warn. The settings row refuses to save while there is an error. |
| Spells | A spell's start window is estimated over days 0–364 of the calendar. Gated on an era that starts later, no day qualifies and the window falls back to a whole year, so `meanStartsPerYear` is read as "per year inside the era". |

Eras are steps on the absolute timeline — not cycles. See `NON-GOALS.md`.

---

## 7c. The Climate Studio

The studio (*Zones → Open in studio*, or the *Open climate studio* command) is an editor over the
schema above — it adds no grammar of its own. Everything it produces is a `Modifier` (§7), an
[`AutomationLane`](#automationlane--a-value-that-moves-over-years), a
[`Regime`](#regime), [`flipSeasons`](#flipseasons--a-southern-hemisphere-view-of-the-calendar), an
[`Era`](#7b-the-era-timeline), or an `Override`. What it *does* add is a set of id conventions, so
that a knob's value can be found again the next time the zone is opened.

**Ids the studio writes.** `<param>` is a `CurvePath`; `<X>` is a season or moon name, verbatim.

| Id | Stage | Op | Written by |
|---|---|---|---|
| `layer:<param>` | `climate` | `offset` | Channel editor, all-year offset knob |
| `layer:<param>:scale` | `climate` | `scale` | Channel editor, all-year scale knob |
| `layer:<param>:curve` | `climate` | `set` with a whole `Curve` | Channel editor, drawn keyframes |
| `layer:<param>:swing` | `climate` | `set` with the amplitude-rescaled base | Channel editor, swing knob |
| `layer:<param>:season:<X>` | `daily` | `offset`, `when: { tag: "season:<X>" }` | Channel editor, season scope |
| `layer:<param>:season:<X>:set` | `daily` | `set`, `when: { tag: "season:<X>" }` | Channel editor, season scope on an absolute path (wind direction) |
| `layer:<param>:moon:<X>` | `daily` | `offset` + `envelope`, `when: { moon: { name: "<X>", phase: [0, 1] } }` | Channel editor, ☾ cycle scope |
| `forcings:temperature.mean` | `climate` | `offset` | Forcings window, temperature trim |
| `forcings:precipitation` | `climate` | `scale` on **both** `precipitation.pwd` and `precipitation.pww` | Forcings window, wetness |
| `automation` lane `frc.warmth` | — | `offset` on `temperature.mean` | The `FRC · warmth` lane in the playlist |

| Rule | Detail |
|---|---|
| The engine reads none of it | Ids are a UI convention (see [Id conventions](#id-conventions) for the one id prefix that *is* reserved, `era:`). A hand-written zone may use any unique ids it likes and the generator behaves identically. |
| Order is meaningful | On save the studio partitions `modifiers[]` as `layer:*` → devices in rack order → `forcings:*`. Ops stack in list order, so the partition is what makes "the trim sits on top of the layers" true. Nothing enforces it: a hand-ordered file is left as it is. |
| Strays are kept, never rewritten | An id that carries a `layer:`/`forcings:` prefix but does not match the shape its id promises is shown as an ordinary device with a "custom" chip. The studio will not silently rewrite or drop it. |
| Anything else is a device | A modifier whose id is neither `layer:*` nor `forcings:*` is a device: it gets a mixer card, an editor window, and — if its `when` has a time shape — a lane. |
| Swing is derived | `layer:<param>:swing` is re-derived from the current effective base whenever the offset, scale or curve under it changes, so the three knobs stay independent. |
| Pins | The audition strip's right-click pin writes an ordinary `Override` (§4 `overridden`, *Settings → Pinned days*), not a modifier. |
| Colours | The colour indices on seasons, eras and regimes are view state on the studio leaf, never schema. |

Seasons and moons are the active adapter's, not the zone's: under a calendar plugin that
implements [`describe()`](#calendardescription) the Seasons and cycle windows mirror it read-only.

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
| `style` | `card` \| `line` \| `prose` \| `table` \| `value` | `card` | See below. |
| `range` | integer `1`–`366` | `7` | Only meaningful for `style: table` — the number of consecutive days starting at `date`. |
| `field` | a `ConvertedReport` leaf: `temperature.high` `temperature.low` `temperature.mean` `temperature.current` `precipitation.type` `precipitation.amount` `precipitation.intensity` `precipitation.active` `humidity` `cloudCover` `wind.speed` `wind.directionDeg` `visibility` `regime` `conditions` `descriptors.temperature` `descriptors.precipitation` `descriptors.wind` `descriptors.sky` `overridden` `units` | none | Required for `style: value`; an error otherwise. |
| `units` | `metric` \| `imperial` | the setting | Applies to every style. |

### Styles

| Style | Renders |
|---|---|
| `card` | Icon, one-line summary, and a temperature / precipitation / wind / sky / humidity / visibility grid, in the units configured in settings (metric/imperial). |
| `line` | One line, e.g. `🌧 Year 3, day 14: Cold, steady rain, breezy from the WSW, overcast. 1.1 to 7.8 °C.` |
| `prose` | A short paragraph from `describe(report, "prose")` — flagged in the README as "extremely rough for the alpha". |
| `table` | One row per day for `range` days starting at `date`, pinned (overridden) days marked with 📌. |
| `value` | The one `field`, bare, in a `<span class="wadjet-value">`: numbers as digits (no unit), lists comma-joined, booleans `yes`/`no`, a missing field (e.g. `temperature.current` without `hour`) as empty. |

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
