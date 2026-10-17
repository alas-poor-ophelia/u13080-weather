# Wadjet (U+13080 Weather) — API Reference

This is a field-by-field reference to the plugin's public surface, written from the source code.
It describes the shipped code that consumer plugins call.

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

The API object's own `on("ready", cb)` event fires at the same moment (see §2). You can register
for the workspace event before the plugin has loaded.

**Unload and re-enable.** When the plugin is disabled or reloaded, the API object fires its own
`unload` event, then the `wadjet:unload` workspace event. From then on `ready` is `false`, every
method throws an `Error` with `code: "wadjet-unloaded"` (async methods reject with it), and every
unsubscribe or unregister function you hold does nothing. Re-enabling builds a new API object with
empty registries. Drop your reference on `wadjet:unload`. On the next `wadjet:ready`, get the object
again and register your adapters, resolvers, interpreters and listeners again.

```ts
this.registerEvent(this.app.workspace.on("wadjet:unload", () => (api = null)));
this.registerEvent(this.app.workspace.on("wadjet:ready", () => init(wadjet()))); // fires again on re-enable
```

**Types.** `types/wadjet.d.ts` in the repository is a standalone, dependency-free declaration of
everything in this document. Copy it into your plugin and `import type { WadjetAPI } from
"./wadjet"`. The plugin's test suite fails if the shipped object stops matching it.

**Feature detection.** `apiVersion` (below) increases whenever members are added. Members marked
*(API 1)* in this document arrived with `apiVersion: 1`. On an older plugin `apiVersion` is absent.
`on()` callbacks receive payloads from API 1 onward.

---

## 1. `WadjetAPI`

```ts
interface WadjetAPI {
  version: string;
  apiVersion: 1;
  ready: boolean;
  schemaVersion: 0;
  generatorVersion: string;
  rngVersion: string;

  getReport: (zoneId: string, time?: TimeContext | { dayOrdinal: number; hour?: number }) => WeatherReport;
  getRange: (zoneId: string, fromDay: number, toDay: number) => WeatherReport[];
  now: () => TimeContext | null;
  listZones: () => Array<{ id: string; name: string }>;
  timeAt: (dayOrdinal: number, zoneId?: string) => TimeContext;
  format: (dayOrdinal: number) => string;
  parse: (text: string) => number | null;

  canSetNow: () => boolean;
  setNow: (dayOrdinal: number) => Promise<boolean>;
  advance: (days: number) => Promise<boolean>;

  registerTimeAdapter: (adapter: TimeAdapter) => () => void;
  registerZoneResolver: (resolver: ZoneResolver) => () => void;
  resolveZone: (locator: ZoneLocator) => string | null;
  resolveZoneAsync: (locator: ZoneLocator) => Promise<string | null>;

  calendar: () => CalendarDescription | null;
  listTimeAdapters: () => Array<{ id: string; label: string; active: boolean }>;

  describe: (report: WeatherReport, style?: "short" | "prose") => string;
  units: () => Units; // "metric" | "imperial"
  convert: (report: WeatherReport, units?: Units) => ConvertedReport;

  classify: (report: WeatherReport) => Classification;
  glyphKey: (report: WeatherReport) => GlyphKey;
  glyph: (keyOrReport: GlyphKey | WeatherReport, opts?: { size?: number; title?: string }) => string;

  registerInterpreter: (interpreter: WeatherInterpreter) => () => void;
  listInterpreters: (facet?: string) => InterpreterInfo[];
  getInterpreter: (id: string) => WeatherInterpreter | null;
  interpret: <T = unknown>(id: string, report: WeatherReport, options?: Record<string, unknown>) => T;

  on: <E extends WadjetEvent>(event: E, cb: (payload: WadjetEventPayloads[E]) => void) => () => void;
}
```

Members are written in property syntax (`name: (...) => T`) so the declaration file can be
checked for identity with the implementation. Call them like ordinary methods.

### `version`

Type: `string`. The plugin manifest's version (`this.manifest.version`), not the schema or
generator version.

### `apiVersion` *(API 1)*

Type: `1`. Increases whenever members are added to this interface. It is absent on plugins older
than API 1. Test for it with `api.apiVersion >= 1`, which is false for `undefined`.

### `ready`

Type: `boolean`. `false` at construction. Set to `true` at the end of `onload()`, immediately
before the `wadjet:ready` workspace event fires. Set back to `false` at unload, and it stays
`false` after that. See §2.

### `schemaVersion`

Type: `0` (literal, `SCHEMA_VERSION` in source). The version of the `WeatherReport` shape. It stays
`0` through alpha; its doc comment reads "0 until alpha ships".

### `generatorVersion`

Type: `string`. Currently `"wadjet-gen/0.0.3"` (`GENERATOR_VERSION`). This is the version of the
code currently running, not the version a given world was created with. See the note on
`WeatherReport.provenance.generatorVersion` in §4.


### `rngVersion`

Type: `string`. Identifies the frozen hash/uniform substrate (`RNG_VERSION`, defined in
`src/core/rng.ts`). It changes only with an explicit, versioned break.

### `getReport(zoneId, time?)`

```ts
getReport(zoneId: string, time?: TimeContext | { dayOrdinal: number; hour?: number }): WeatherReport
```

| Parameter | Type | Description |
|---|---|---|
| `zoneId` | `string` | A zone id from `listZones()`. |
| `time` | `TimeContext \| { dayOrdinal: number; hour?: number }`, optional | Only `dayOrdinal` is read, plus `hour` if you want diurnal interpolation. A full `TimeContext` (e.g. from `now()`) is accepted. Omitted: today (`now().dayOrdinal`) as a daily report; any `hour` on `now()` is dropped. |

**Returns:** `WeatherReport` for that zone and day (see §4). Passing `hour` adds
`temperature.current` and `precipitation.active` to the result.

**Throws:**
- `Error("The active calendar has no current day; pass a time.")`: `time` omitted and `now()` is `null`.
- `TypeError` naming the bad value: `time` is not an object, `dayOrdinal` is not a safe integer
  (`1.5`, `NaN`, `Infinity`, `2 ** 53`, a string, missing), or `hour` is not a finite number.
  Behaviour change in API 1: a non-integer `dayOrdinal` used to be passed through.
- `RangeError`: `hour` outside `[0, 24)`.
- `RangeError("Unknown zone \"<id>\".")`: no zone with that id exists.
- `Error("No calendar is available.")`: no time adapter is registered. This should not happen once
  `ready` is true, because the internal calendar always registers itself.
- `RangeError` from profile validation ("profile \"<id>\" is invalid:\n  <path>: <message>...")
  — the zone's stored profile has validation errors. Warnings do not cause it. See §7.

**Example:**

```ts
const today = wadjet.getReport("greywold-highlands");
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
query are byte-for-byte identical to the same days fetched individually (§9). None of them has an
`hour` field. Range queries are daily-only; there is no per-hour range API.

**Throws:** `TypeError` when either bound is not an integer. `RangeError` when `fromDay > toDay`
or the span is longer than 3660 days (ten 366-day years); request longer spans in pieces.
Otherwise the same as `getReport` (unknown zone, no calendar, invalid profile).

**Example:**

```ts
const week = wadjet.getRange("greywold-highlands", 400, 406);
```

### `now()`

```ts
now(): TimeContext | null
```

**Returns:** the active time adapter's current `TimeContext`, or `null` if the active adapter
reports no current date. A `TimeAdapter.now()` implementation may return `null`; the internal
calendar does not. Having no custom adapter registered does not make the result `null`. The
internal calendar is always present and is the fallback.

### `listZones()`

```ts
listZones(): Array<{ id: string; name: string }>
```

**Returns:** every configured zone's `id` and `name`, in settings order. Validation issues are not
included. The internal `World.listZones()` reports them, but the public API strips them. To find a
broken profile, call `getReport`/`getRange` and catch the error.

### `timeAt(dayOrdinal, zoneId?)` *(API 1)*

```ts
timeAt(dayOrdinal: number, zoneId?: string): TimeContext
```

The `TimeContext` the generator sees for that day: the active adapter's `toContext(dayOrdinal)`
plus the era timeline's `era:<name>` tags (§7b). With a `zoneId`, the zone's `flipSeasons` is
applied too (§6), in the same way as when that zone's weather is generated. So `timeAt(d, zoneId)`
is the context that a modifier's `tag`/`season` predicates were evaluated against. The generator
and `timeAt` share one function, so their results cannot differ.

**Throws:** `TypeError` for a non-integer `dayOrdinal`; `RangeError` for an unknown `zoneId`.

### `format(dayOrdinal)` *(API 1)*

```ts
format(dayOrdinal: number): string
```

Returns the active adapter's `format(dayOrdinal)`. Returns `"Day N"` when the adapter has no
`format`, or when its `format` throws (the error is logged). Throws `TypeError` for a non-integer
`dayOrdinal`.

### `parse(text)` *(API 1)*

```ts
parse(text: string): number | null
```

Returns the active adapter's `parse(text)`. If the adapter's `parse` throws or returns a
non-integer, the result is `null`. When the adapter has no `parse`, a plain integer string
(`"412"`, `" -3 "`) is accepted and anything else returns `null`. Non-string input returns `null`.

### `canSetNow()`, `setNow(dayOrdinal)`, `advance(days)` *(API 1)*

```ts
canSetNow(): boolean
setNow(dayOrdinal: number): Promise<boolean>
advance(days: number): Promise<boolean>
```

These move the active calendar's current day. See "Time control" in §5 for the contract.

- `canSetNow()` is `true` when the active adapter has a `setNow` function, and `false` otherwise.
- `setNow(d)` sets the current day to `d`. `advance(n)` moves it by `n` days from `now()`; a negative
  `n` goes back. Both resolve `true` when the day moved. They resolve `false`, and do not reject,
  when the active adapter has no `setNow`, when `now()` is `null` (advance only), when the
  adapter's `setNow` threw or rejected (logged with the adapter id), or when the plugin unloaded
  while the call was in flight.
- Both reject with `TypeError` for an argument that is not a safe integer
  (`Number.isSafeInteger`).
- **Day range.** A calendar's current day is kept within ±10,000,000 (`MAX_DAY_ORDINAL`,
  about 27,000 years of 365 days). `setNow(d)` rejects with `RangeError` when `|d|` is above that.
  `advance(n)` rejects with `RangeError` when its target day (`now() + n`, computed when the call's
  turn in the queue comes) would be above it. In both cases the day does not move. Reading weather
  (`getReport`, `getRange`, `timeAt`) is not limited to this range.
- Calls are serialised. Each starts after every earlier `setNow`/`advance` call (and Wadjet's own
  day edits) has settled, so `advance(1)` twice in a row moves two days.
- On success `time-changed` fires once (§2). When Wadjet fires it itself (for an adapter without
  `subscribe`), `adapterId` names the adapter whose day moved. That is the adapter that was active
  when the call's turn came, even if the Calendar source setting changed while the call ran.
- If the internal calendar cannot save the new day (the write to `data.json` fails), the day
  goes back to what it was, the call resolves `false`, and no event fires.

```ts
if (wadjet.canSetNow()) await wadjet.advance(1);
```

### `registerTimeAdapter(adapter)`

```ts
registerTimeAdapter(adapter: TimeAdapter): () => void
```

Registers a `TimeAdapter` (see §5) under `adapter.id`. If an adapter with the same `id` is
already registered, it is replaced. The id `"internal"` is reserved for the built-in calendar.
Registering it throws an `Error` with `code: "wadjet-reserved-id"`. Every register and every
unregister fires `"adapters-changed"` (§2). If `adapter.id` matches the active adapter id in
settings, it also fires `"time-changed"`, because the active calendar's effective
`now()`/`toContext()` has changed. It also refreshes the settings tab if it is open, because the
"Calendar source" dropdown lists registered adapters.

The user chooses the active adapter in settings. Registering an adapter does not make it the
active one. A calendar plugin makes itself available, and the user picks it from the
"Calendar source" dropdown.

**Returns:** an unregister function. It removes the adapter only if that adapter is still the one
registered under its id. This way an earlier plugin's cleanup does not remove a later registration
under the same id. Unregistering the active adapter has the same effects as registering it. The
registry falls back to the internal calendar: `TimeRegistry.active` resolves to
`adapters.get("internal")` whenever the configured id is not registered. That fallback fires both
`"time-changed"` and `"adapters-changed"`, as if the internal calendar had just become active.

### `registerZoneResolver(resolver)`

```ts
registerZoneResolver(resolver: ZoneResolver): () => void
```

Adds a `ZoneResolver` (see §5) to the end of the resolution chain. Resolvers are tried in
registration order. Multiple resolvers may be registered, including several for the same locator
`kind`. Wadjet's own `wadjet.frontmatter` resolver is registered first, when the plugin loads (§5).

**Throws:** `TypeError` if the resolver has neither `resolve` nor `resolveAsync`, or has no `kinds`
array. Fires `resolvers-changed` (§2).

**Returns:** a function that unregisters this resolver instance and fires `resolvers-changed`.
Later calls do nothing.

### `resolveZone(locator)`

```ts
resolveZone(locator: ZoneLocator): string | null
```

Walks the registered resolvers in registration order. For each resolver whose `kinds` includes
`locator.kind` and that has a synchronous `resolve`, it calls `resolve(locator)`. It returns the
first non-null id that also names a currently configured zone. A resolver that throws is caught
and skipped. Resolvers with only `resolveAsync` are skipped here. Returns `null` if no resolver
produces a valid zone id.

### `resolveZoneAsync(locator)` *(API 1)*

```ts
resolveZoneAsync(locator: ZoneLocator): Promise<string | null>
```

The same walk, for resolvers that need to await (read a file, ask a server):

- The chain is snapshotted when the call starts. Resolvers registered after that are not asked.
- Each resolver's `resolveAsync` is awaited when it has one. Otherwise its `resolve` is called.
- Each `resolveAsync` has 2000 ms. A slower one counts as `null` (with a `console.warn` naming
  it) and the walk moves on. A resolver that throws or rejects is handled the same way.
- After each await, the answer is checked again against the zones that exist at that point. A
  zone deleted while a resolver was running is not returned.
- Resolves `null` when no resolver answers. Rejects with `code: "wadjet-unloaded"` when called
  after unload. Resolves `null` if the plugin unloads during the walk.

### `calendar()`

```ts
calendar(): CalendarDescription | null
```

**Returns:** the active time adapter's `CalendarDescription` (see §5), or `null` if the active
adapter has no `describe()`. Such an adapter is an "opaque calendar" (below). Wadjet's own Seasons
and CYCLE-window editors read this value to decide whether to show live edit controls or a
read-only summary.

### `listTimeAdapters()`

```ts
listTimeAdapters(): Array<{ id: string; label: string; active: boolean }>
```

**Returns:** every registered `TimeAdapter`, in registration order. The `label` is taken from
`describe().label`, or is the bare `id` if the adapter does not describe itself. `active` is true
for one entry and false for the rest. `active` marks the adapter the registry resolves to after
fallback, which is the one `TimeRegistry.active` returns. It does not mark the raw
`activeTimeAdapter` setting. If the setting names an id that is not registered, `"internal"` is
marked active here, because every other API call (`getReport`, `now`, `calendar`) uses it.

### `describe(report, style?)`

```ts
describe(report: WeatherReport, style?: "short" | "prose"): string
```

| Parameter | Type | Description |
|---|---|---|
| `report` | `WeatherReport` | Any report, generated or hand-built. |
| `style` | `"short" \| "prose"` (optional) | Defaults to `"short"`. Any other value (a typo, an object) also means `"short"`; it does not throw. |

**Returns:** a human-readable sentence built from the report's descriptors and numbers. It uses
`conditions` and tags only to list them. `"short"` is one line with the temperature range typeset
with a minus sign, e.g. `Cold, steady rain, breezy from the WSW, overcast. −1.1 to 7.8 °C.`
`"prose"` is a short paragraph, marked "extremely rough for the alpha" in the README.

### `units()`

```ts
units(): "metric" | "imperial"
```

The user's display-units setting. Reports themselves are always metric.

### `convert(report, units?)`

```ts
convert(report: WeatherReport, units?: "metric" | "imperial"): ConvertedReport
```

The same report in the given units (default: `units()`). Unit suffixes are dropped from the key
names, so consumers read one shape in either system. The function is pure. The renderer uses the
same table, so a number from `convert` matches what the card shows.

```ts
interface ConvertedReport {                    // everything not listed is as in WeatherReport
  units: "metric" | "imperial";
  labels: { temperature: string; amount: string; speed: string; distance: string }; // "°C"/"°F", "mm"/"in", ...
  temperature: { high: number; low: number; mean: number; current?: number };       // °C or °F, 0.1
  precipitation: { type: PrecipType; amount: number; intensity: number; active?: boolean }; // mm (0.1) or in (0.01)
  wind: { speed: number; directionDeg: number };                                      // km/h (whole) or mph (0.1)
  visibility: number;                                                                 // km or mi (0.1)
}
```

### `classify(report)` *(API 1)*

```ts
classify(report: WeatherReport): Classification
```

Standard meteorological classes for a report: Beaufort force, compass point, oktas, visibility
class, precipitation class and apparent temperature. The function is pure and deterministic. It
works on any report, including hand-built ones, and does not read the descriptor words. Tables
and sources are in §4b.

### `glyphKey(report)`, `glyph(keyOrReport, opts?)` *(API 1)*

```ts
glyphKey(report: WeatherReport): GlyphKey
glyph(keyOrReport: GlyphKey | WeatherReport, opts?: { size?: number; title?: string }): string
```

`glyphKey` picks one of twelve icon keys for a report (§4b). `glyph` returns the built-in SVG for
a key, or for a report via `glyphKey`, as a string. The SVG uses monochrome `currentColor`
strokes and a square `viewBox="0 0 24 24"`. It contains no scripts and no external references, so
you can parse it with `DOMParser` or `sanitizeHTMLToDom`. `size` sets the width and height
(default 24). `title` adds an accessible `<title>`. `opts` may be omitted or `null`. An unknown key
throws `RangeError`. To use your own art, map `glyphKey(report)` to it.

### `registerInterpreter(interpreter)`, `listInterpreters(facet?)`, `getInterpreter(id)`, `interpret(id, report, options?)` *(API 1)*

```ts
registerInterpreter(interpreter: WeatherInterpreter): () => void
listInterpreters(facet?: string): InterpreterInfo[]
getInterpreter(id: string): WeatherInterpreter | null
interpret<T = unknown>(id: string, report: WeatherReport, options?: Record<string, unknown>): T
```

Other plugins use this registry to define what weather means for their game. See "Interpreters"
in §5 for the contract and an example.

- `registerInterpreter` throws `TypeError` for a malformed interpreter (empty `id`, `label` or
  `facet`; no `interpret` function; a `format` that is not a function). It throws an `Error` with
  `code: "wadjet-duplicate-id"` when an interpreter with that id is already registered; it does not
  replace the existing one. It returns an unregister function that removes the interpreter only if
  it is still the one registered under that id. Later calls do nothing. Registering and
  unregistering both fire `interpreters-changed`.
- `listInterpreters` returns `{ id, label, facet, description? }` for every registered
  interpreter, in registration order. When `facet` is given, only interpreters with that facet are
  listed.
- `getInterpreter` returns the registered object itself, or `null`.
- `interpret` builds the `InterpretContext` and calls the interpreter synchronously. The
  interpreter receives its own deep copies of `report` and `options` (`structuredClone`). If
  `options` holds values that cannot be cloned, such as functions, it is copied one level deep. An
  interpreter that mutates its arguments therefore changes nothing that the caller, the card or
  another interpreter sees. It throws `RangeError` for an unknown id. If the interpreter throws,
  the error is rethrown as `Error('Interpreter "<id>" failed: <message>')` with the original error
  as `cause`.

### `on(event, cb)`

```ts
on<E extends WadjetEvent>(event: E, cb: (payload: WadjetEventPayloads[E]) => void): () => void
```

Subscribes to an event (see §2). The callback receives one frozen payload object. Callbacks
written for the old no-argument form still work. Returns an unregister function. A listener that
throws is logged with `console.error` and does not stop other listeners or the emitter. An
`async` listener (one that returns a promise) is not awaited, and a rejection is logged the same
way.

---

## 2. Events

### API-level events (`wadjet.on(event, cb)`)

Every callback receives one frozen payload object (arrays inside it are frozen too), with `type`
set to the event name. *(API 1: before, callbacks got no argument.)*

| Event | Payload | Fires when |
|---|---|---|
| `"ready"` | `{ type }` | Once, from inside `onload()`, immediately after `api.ready` is set to `true` and just before the `wadjet:ready` workspace event. Use it only if you obtained the API object before the plugin finished loading; otherwise wait on the workspace event below. |
| `"profiles-changed"` | `{ type, all: boolean, zoneIds: string[] }` | Whenever the world state is saved and rebuilt: zones, overrides, the seed, eras, descriptor bands or calendar configuration, whether from an edit in settings, a pin or a studio save. The internal calendar's *Current day* write and the *Calendar source* switch do not rebuild the world and do not fire it. `zoneIds` lists the zones whose output may have changed (profile, name, `flipSeasons`, or that zone's pinned days), including zones added or removed. `all` is `true` when the seed, the era timeline or the descriptor bands changed. It is also `true` when the active calendar's configuration changed in a way that changes reports, that is, when its `configHash()` (`provenance.calendarHash`) changed. For the internal calendar this means an edit to year length, epoch year, seasons, or a moon's cycle length or epoch phase. Renaming named moon phases does not count, because they are display metadata outside the config hash. When `all` is `true`, `zoneIds` is every current zone. The event fires on every such save. When the save touched nothing that changes weather, it fires with `all: false` and `zoneIds: []`. |
| `"time-changed"` | `{ type, current: number \| null, adapterId: string }` | Whenever the active calendar's "now" or its shape changes: `setNow`/`advance`, the *Advance/Rewind the calendar one day* commands, editing *Current day* in settings (while the internal calendar is active), switching *Calendar source*, editing the internal calendar's year length, epoch year, seasons, or a moon's cycle length or epoch phase while it is active, registering an adapter whose id is the active setting, unregistering the active adapter (fallback to the internal calendar), or the active adapter's own `subscribe` callback. `current` is `now()?.dayOrdinal` at that moment; `adapterId` is the active adapter. |
| `"adapters-changed"` | `{ type }` | Whenever the set of registered time adapters changes. That includes every `registerTimeAdapter` call and every call to the unregister function it returns, whether or not the adapter is active. It also fires when *Calendar source* switches to another adapter. Use this to refresh a UI that lists adapters (`listTimeAdapters()`). Use `"time-changed"` for a UI that only needs the active calendar. |
| `"resolvers-changed"` *(API 1)* | `{ type }` | A zone resolver was registered or unregistered. |
| `"interpreters-changed"` *(API 1)* | `{ type, facet: string }` | An interpreter was registered or unregistered; `facet` is that interpreter's facet. |
| `"unload"` *(API 1)* | `{ type }` | Once, at the start of unload, after `ready` became `false` and before the `wadjet:unload` workspace event. Listeners are removed immediately afterwards. |

**Switching the active calendar** fires `time-changed` and `adapters-changed`, not
`profiles-changed`. Zone profiles did not change, and every report carries the calendar in
`provenance.calendarHash`.

**Editing the active calendar** is different. When the same adapter stays active and its
`configHash()` changes (detected at the next save), `profiles-changed` fires with `all: true`,
because every report changed. For the internal calendar that save is the edit itself, and
`time-changed` fires too, because the meaning of "today" changed. When a third-party adapter's
configuration changes on its own side, Wadjet notices at its next save. To detect the change
immediately, key caches on `provenance.calendarHash`.

### Workspace events

| Event | Fires when |
|---|---|
| `"wadjet:ready"` (`app.workspace.trigger`) | At the end of `onload()`, after `api.ready` has been set to `true`. This is the event to wait on. It fires again after a re-enable, with a new API object. |
| `"wadjet:unload"` *(API 1)* (`app.workspace.trigger`) | At the start of `onunload()`, right after the API-level `unload` event. Drop your reference to the API object; it no longer works (see *Unload and re-enable* at the top). |

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
| `dayOrdinal` | `number` (integer) | Days since the world epoch; may be negative. The primary key for weather generation. Everything else in `TimeContext` is context for predicates and rendering, not an independent input. |
| `yearPhase` | `number`, `[0, 1)` | Position in the annual cycle; `0` is the calendar's own year start. Drives every `Curve` evaluation and the `yearPhase` predicate. |
| `yearLength` | `number` | Days in the current year, as reported by the active adapter. Adapters may vary this from year to year. |
| `hour` | `number`, `[0, 24)`, optional | Set only when requesting an hourly report; enables diurnal interpolation. |
| `dayOfYear` | `number`, optional | Integer day-of-year, used by the `dayOfYear` predicate (inclusive range test, §7). The internal calendar always supplies it (0-based). A third-party adapter may omit it, and then `dayOfYear` predicates always evaluate false. |
| `year` | `number`, optional | The calendar's year number, used by the era timeline. The internal calendar always supplies it (`epochYear` at `dayOrdinal 0`). If an adapter omits it, the era timeline counts years from 1 at day 0 using `yearLength`. |
| `moons` | `Array<{ name: string; phase: number }>`, optional | `phase` is `[0, 1)`, `0` = new, `0.5` = full. Read by the `moon` predicate. |
| `tags` | `string[]`, optional | Labels provided by the calendar, such as seasons, festivals or eras. Read by the `tag` predicate. Not copied into `WeatherReport.conditions`. Conditions come only from active modifier tags and the fog heuristic (§4). |
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
| `regime` | `string` | The id of the synoptic `Regime` active that day (§6). A regime is a background weather pattern (settled, stormy, ...) chosen by a seeded semi-Markov process. It is exposed for display and for the `regime` predicate. |
| `conditions` | `string[]` | The `tag`s of every currently active daily-stage modifier that has one, plus `"fog"` if the fog heuristic triggered (below). Overrides can append further strings via `patch.conditions`. This is the only source of conditions. Season and calendar tags are not included. |
| `overridden` | `boolean` | `true` if and only if a pinned override patch exists for `(zoneId, dayOrdinal)` and was applied. |

### `temperature`

All values °C, rounded to 0.1 (`Math.round(x*10)/10`).

| Field | Type | Description |
|---|---|---|
| `high` | `number` | Daily high. |
| `low` | `number` | Daily low. |
| `mean` | `number` | `(high + low) / 2` before rounding; drives the temperature descriptor. |
| `current` | `number`, optional | Only present when `hour` was given. Diurnal interpolation: `mean + (range/2) · cos(2π(hour − 15)/24)`. This is a cosine with a peak at 15:00 and a trough at 03:00 (`HEURISTIC.warmestHour = 15`). It is a stated heuristic, not derived from station data. |

### `precipitation`

| Field | Type | Description |
|---|---|---|
| `type` | `"none" \| "drizzle" \| "rain" \| "sleet" \| "snow"` | The current type and generator do not produce `"hail"`. |
| `amountMm` | `number`, mm, rounded to 0.1 | Daily total. `0` if `type === "none"`. Otherwise it has a floor of a 0.1 mm trace, so a wet day never reports `0` (`TRACE_MM = 0.1`). |
| `intensity` | `number`, `[0, 1]`, rounded to 0.01 | `1 − exp(−amountMm / 20)`, monotone in `amountMm`. Reference points: 10 mm → 0.39, 25 mm → 0.71, 50 mm → 0.92. Consumers should key on this field, not on `descriptors.precipitation`. |
| `active` | `boolean`, optional | Only present when `hour` was given. `false` if the day is not wet. Otherwise it tells whether `hour` falls inside a deterministic daily precipitation window `[start, start+length)`, which can wrap past midnight. `start` is a uniform draw over `[0, 24)` per (seed, zone, day). `length = min(24, 2 + 12·intensity)` hours, so a heavier day rains longer. |

### `humidity`, `cloudCover`

Both `number`, `[0, 1]`, rounded to 0.01 (2-decimal fraction).

### `wind`

| Field | Type | Description |
|---|---|---|
| `speedKph` | `number`, km/h, rounded to the nearest integer | |
| `directionDeg` | `number`, degrees, rounded to the nearest integer, `[0, 360)` | Compass direction the wind is blowing from (standard meteorological convention). |

### `visibilityKm`

`number`, km, rounded to 0.1. Derived from a stated heuristic (`HEURISTIC` constants in
`src/core/report.ts`), not from station data:

- Fog: if `humidity ≥ 0.92` and `windKph < 8` and precipitation is `"none"` or
  `"drizzle"`, visibility is fixed at `0.4` km and `"fog"` is added to `conditions`.
- Otherwise: start from `40` km (clear-day baseline), reduce by up to 40% for cloud cover
  (`40 × (1 − 0.4·cloud)`), then divide by `1 + factor·intensity`, where `factor` is `10` for
  snow/sleet and `4` for rain/drizzle/none.

### `descriptors`

```ts
{ temperature: string; precipitation: string; wind: string; sky: string }
```

Plain, user-editable strings. The type is not a closed union, because the band tables that
produce them are user-editable in settings. Consumers must key on the numeric fields above and
must not exhaustively `switch` on these strings. Descriptors are computed after overrides and
rounding, so the words match the numbers shown. An override can supply explicit `descriptors`
values per field. Those values win over the band lookup for whichever keys are present.

**Default bands** (`DEFAULT_BANDS`, used unless the zone or global settings override them). A band
applies once the value is `>=` its `from` threshold. The highest matching band wins:

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

The precipitation band is only consulted when `type !== "none"`. A dry day always gets the first
band's label ("dry"), whatever its `amountMm`.

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
| `generatorVersion` | `string` | The `GENERATOR_VERSION` of the running plugin code. Settings also hold the version the world last accepted, which drives the generator-change notice and the *Acknowledge* button. Only the current generator ships, so every report comes from the running version, and `provenance` reports it. |
| `rngVersion` | `string` | The frozen RNG/hash substrate's version. |
| `profileHash` | `string` | `wh1:<8 hex><8 hex>`: two 32-bit hashes over the canonical JSON of the zone's `{ climate, regimes, modifiers }`, plus its automation lanes when it has any. This covers Tier C plus regimes and modifiers. The copied preset and geography are already baked into `climate` and do not appear separately. Changes whenever the zone's profile changes. |
| `calendarHash` | `string` | The active time adapter's `configHash()`, followed by `+eras:<8 hex>` over the era timeline when one is configured. For the internal calendar the hash is `ical:<8 hex>` over year length, epoch year, moon cycle lengths and epoch phases, and seasons; named moon phases are not hashed. |

To cache a report, key on the full tuple `(zoneId, dayOrdinal, hour,
provenance.*)`, not just `(zoneId, dayOrdinal)`. A change in any provenance field means the weather may have changed.

---

## 4b. Classification and glyphs

`classify(report)` maps a report onto published scales. Wadjet reports these physical classes and
nothing more. What a gale means for a party on the road is left to an interpreter (§5).

```ts
interface Classification {
  beaufort: number;               // 0..12
  beaufortLabel: string;          // "Calm" ... "Hurricane force"
  compass: string;                // 16-point, the direction the wind blows FROM ("WSW")
  oktas: number;                  // 0..8
  visibility: "very-poor" | "poor" | "moderate" | "good" | "very-good" | "excellent";
  precipitation: "none" | "very-light" | "light" | "moderate" | "heavy" | "very-heavy" | "extremely-heavy";
  frozenPrecipitation: boolean;   // sleet or snow
  feelsLike: { mean: number; current?: number }; // °C, 0.1
}
```

Lower bounds are inclusive throughout (half-open intervals), so each value falls in one class and
no more.

`classify` does not throw when a numeric field is `NaN` or infinite, as it can be in a hand-built
report. It falls back as follows:

| Field | Non-finite value | Result |
|---|---|---|
| `wind.speedKph` | `NaN` | Beaufort 0, "Calm"; no wind chill |
| `wind.speedKph` | `Infinity` | Beaufort 12; no wind chill |
| `wind.directionDeg` | `NaN`, `±Infinity` | compass `"N"` |
| `cloudCover` | `NaN` | 0 oktas (`Infinity` is 8, `-Infinity` 0) |
| `visibilityKm` | `NaN` | `"moderate"`, the middle of the scale (`Infinity` is `"excellent"`, `-Infinity` `"very-poor"`) |
| `precipitation.amountMm` | `NaN` on a wet day | `"very-light"` (`Infinity` is `"extremely-heavy"`); a `none` day is `"none"` whatever the amount |
| `humidity` | `NaN`, `±Infinity` | no heat index; wind chill is unaffected |
| `temperature.mean` / `.current` | `NaN`, `±Infinity` | `feelsLike` is that same value |

**Beaufort.** The WMO Beaufort scale (WMO Manual on Marine Meteorological Services, WMO-No. 558;
Guide to Instruments and Methods of Observation, WMO-No. 8), applied to `wind.speedKph`:

| Force | Label | km/h | Force | Label | km/h |
|---|---|---|---|---|---|
| 0 | Calm | < 1 | 7 | Near gale | 50–61 |
| 1 | Light air | 1–5 | 8 | Gale | 62–74 |
| 2 | Light breeze | 6–11 | 9 | Strong gale | 75–88 |
| 3 | Gentle breeze | 12–19 | 10 | Storm | 89–102 |
| 4 | Moderate breeze | 20–28 | 11 | Violent storm | 103–117 |
| 5 | Fresh breeze | 29–38 | 12 | Hurricane force | ≥ 118 |
| 6 | Strong breeze | 39–49 | | | |

**Precipitation.** India Meteorological Department 24-hour rainfall categories (IMD
"Terminologies and glossary", mm/day), applied to the water-equivalent `precipitation.amountMm`
whatever the type. `"none"` is a day whose type is `none`. A wet day under 0.1 mm reads as
`"very-light"`.

| Class | mm/day |
|---|---|
| `very-light` | 0.1–2.4 |
| `light` | 2.5–15.5 |
| `moderate` | 15.6–64.4 |
| `heavy` | 64.5–115.5 |
| `very-heavy` | 115.6–204.4 |
| `extremely-heavy` | ≥ 204.5 |

**Visibility.** The Met Office general-public visibility scale, applied to `visibilityKm`. The
stock generator caps visibility at 40 km, so `"excellent"` occurs only at 40 km itself or through
an override. Fog is a condition (`report.conditions` contains `"fog"`), not a visibility class.

| Class | km |
|---|---|
| `very-poor` | < 1 |
| `poor` | 1–4 |
| `moderate` | 4–10 |
| `good` | 10–20 |
| `very-good` | 20–40 |
| `excellent` | ≥ 40 |

**Oktas.** WMO Manual on Codes (WMO-No. 306), code table 2700. The result is `0` when
`cloudCover` is 0 or less and `8` when it is 1 or more. Otherwise it is `round(cloudCover × 8)`
clamped to 1–7.

**Feels like.** Apparent temperature in °C, rounded to 0.1, for `temperature.mean` and (on an
hourly report) `temperature.current`. It uses the report's daily `humidity` and `wind.speedKph`:

- wind chill, the joint NWS / Environment Canada index (JAG/TI 2001), when T ≤ 10 °C and wind
  is above 4.8 km/h;
- heat index, the full NWS algorithm (NWS Weather Prediction Center, "The Heat Index Equation";
  Rothfusz 1990, SR 90-23), when T ≥ 80 °F (≈ 26.7 °C). Steadman's simple form is computed
  first. The Rothfusz regression, with its low- and high-humidity adjustments, is used when the
  average of the simple result and T is 80 °F or more. The heat index switches on in one step at
  80 °F. In dry air it reads below the air temperature, as the NWS equation does: at 80 °F and
  10 % humidity it gives about 79 °F. So feels-like can drop as the air warms across 80 °F;
- otherwise the air temperature.

**Glyphs.** `GlyphKey` is a closed set: `clear`, `partly-cloudy`, `cloudy`, `overcast`, `fog`,
`drizzle`, `rain`, `heavy-rain`, `sleet`, `snow`, `heavy-snow`, `windy`. `glyphKey(report)` picks
one by the precedence below. The precedence is a presentation choice, not a standard, and may be
refined. Key on `classify()` when you need a rule.

1. `conditions` contains `"fog"` → `fog`
2. precipitation type → `drizzle`, `rain`, `sleet` or `snow`; rain and snow become `heavy-rain` /
   `heavy-snow` when `precipitation.intensity` ≥ 0.6
3. Beaufort ≥ 6 → `windy`
4. `cloudCover` ≥ 0.8 → `overcast`; ≥ 0.6 → `cloudy`; ≥ 0.4 → `partly-cloudy`; else `clear`

The code block's icon uses the same function.

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
  setNow?(dayOrdinal: number): void | Promise<void>;
  subscribe?(cb: () => void): () => void;
}
```

(The declaration file writes these as properties, `now: () => TimeContext | null`; a class with
methods satisfies either form.)

| Member | Required | Contract |
|---|---|---|
| `id` | yes | Stable identity. It is the settings dropdown value and the registration key. A second `register` under the same id replaces the first. |
| `now()` | yes | The calendar's current date as a `TimeContext`, or `null` if it has none. |
| `toContext(dayOrdinal)` | yes | MUST be O(1) or O(log n). It is called for every day of the 154-day block replay (90 warm-up + 64, see §9). Zones with spell modifiers need more calls: each modifier adds a 365-day window estimate, and the spell lookback reaches up to 401 days back. Anything heavier causes noticeable delays. MUST extrapolate rather than throw for a `dayOrdinal` outside the calendar's defined range. Use the nearest defined year length or equivalent. The internal fallback adapter extrapolates this way. |
| `configHash()` | yes | A string identifying the adapter's configuration, not its current date. It is folded into `provenance.calendarHash`. It should change whenever a setting that affects `toContext`'s output changes. |
| `parse(text)` | optional | Parse a calendar-native date string (e.g. from a `wadjet` code block's `date:` field) to a `dayOrdinal`. Return `null` if the string cannot be parsed. |
| `format(dayOrdinal)` | optional | A human-readable rendering of a day, used by the codeblock renderer and commands. |
| `describe()` | optional | A static summary of the calendar's shape, for UIs. See `CalendarDescription` below. Without it, the calendar is opaque to Wadjet. Wadjet's own editors (Seasons, CYCLE windows) cannot show season or moon names or a badge for it, so they hide those controls entirely instead of guessing. `api.calendar()` returns `null` for an adapter with no `describe()`. |
| `setNow(dayOrdinal)` | optional *(API 1)* | Move this calendar's current day. If the adapter has it, `api.canSetNow()` is true while the adapter is active. `setNow`/`advance` and Wadjet's next/previous-day commands call it. Wadjet calls it only with an integer. It may be async. A throw or rejection makes the API call resolve `false`. |
| `subscribe(cb)` | optional *(API 1)* | Call `cb` whenever the calendar's own current day changes, for example when the user moves it in your plugin. Wadjet subscribes to the active adapter only, resubscribes when the active adapter changes, and fires `time-changed` for each call. Return an unsubscribe function. When an adapter has `subscribe`, Wadjet also relies on it after a successful `setNow`, so call `cb` from your `setNow`. Without `subscribe`, Wadjet fires `time-changed` itself after `setNow` resolves. |

### Time control: `canSetNow` versus `readOnly`

`readOnly` and `canSetNow()` answer separate questions:

- `CalendarDescription.readOnly` governs Wadjet's own editing UIs (the settings rows, the
  studio's Seasons and CYCLE editors). It decides whether Wadjet offers to edit the calendar's
  shape.
- `api.canSetNow()` says whether the current day can be moved through the API. It is `true` if
  and only if the active adapter has `setNow`, whatever `readOnly` says. A calendar plugin can be
  `readOnly: true` (months are edited in its own settings) and still let a session tracker advance
  the day.

The internal calendar implements `setNow` (it writes *Current day* and saves) and `subscribe`.
Wadjet's settings-tab *Current day* edit and its next/previous-day commands go through the same
serialised queue as `api.setNow`/`api.advance`. The commands move whichever calendar is active.
If that calendar cannot be moved, they show a notice saying so.

The user chooses the active adapter in settings. The registering plugin does not; see
`registerTimeAdapter` above. A calendar plugin should implement `describe()` whether or not it
expects to be the active one. `listTimeAdapters()` reads `describe().label` for every registered
adapter, and falls back to the id. The settings *Calendar source* dropdown currently labels each
adapter by its bare `id`.

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
| `readOnly` | `boolean` | `true` for every adapter except the internal one, unless the adapter opts into editing. When `true`, Wadjet's own UIs never write to this calendar. The Seasons and CYCLE-window editors in the Studio show a `"<label> · read-only"` badge, hide the season/moon editing controls, and show `editHint` (below) as the place to change the calendar. |
| `yearLength` | `number` | A representative year length for display (e.g. in the settings summary row). Adapters whose real year length varies (leap years, irregular calendars) still report the actual length for the day in question in every `TimeContext.yearLength`. This field is a label. It does not promise that every year is this long. |
| `epochYear` | `number`, optional | The year number at `dayOrdinal 0`, if the calendar has one. |
| `seasons` | `Array<{ name, from }>` | `from` is a yearPhase fraction in `[0, 1)`, the same unit as `TimeContext.yearPhase`. It marks where each season begins. The shape matches the internal calendar's own season table. |
| `moons` | `Array<{ name, cycleDays, phaseAtEpoch?, phases? }>` | One entry per moon the calendar tracks. `cycleDays` is the synodic period in days. `phaseAtEpoch` (optional) is the moon's cycle-phase fraction in `[0, 1)` at `dayOrdinal 0`, where `0` is new. `phases` (optional) names points on the cycle, for UIs that label phases instead of showing a number. An example is `{ name: "full", at: 0.5 }`, where `at` is also a `[0, 1)` cycle-phase fraction. |
| `editHint` | `string`, optional | Where the user edits this calendar. It is shown as `"edit in <label>"` (or similar) next to the read-only badge. Omit it if there is nowhere to point the user (e.g. a purely computed calendar). |

### Worked example: a third-party calendar plugin

A complete `TimeAdapter` for a fictional "Almanac of Foo". It is a 400-day calendar in which every
4th year is one day longer, so `yearLength` varies by context, not by adapter. It has two seasons,
two moons (one with named phases), `parse`/`format`, `configHash`, and `describe()`. The code is
identical to `test/fixtures/api/third-party-calendar.ts`, which `test/api-doc.test.ts` exercises.
If the two drift apart, that test fails.

```ts
// mirrors test/fixtures/api/third-party-calendar.ts
import type { CalendarDescription, TimeAdapter, TimeContext } from "./wadjet";

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

The plugin side waits for `wadjet:ready`, registers the adapter, and unregisters it on unload:

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

This plugin does not set itself active. It registers and waits. The user picks "Almanac of
Foo" from the *Calendar source* dropdown in Wadjet's settings if they want it.

### `ZoneResolver` / `ZoneLocator`

A plugin that owns a notion of "place" (a hex map, a note, ...) implements this and calls
`wadjet.registerZoneResolver(resolver)`. Other code can then ask "what zone is this?" via
`wadjet.resolveZone(locator)` or `wadjet.resolveZoneAsync(locator)`.

```ts
type ZoneLocator =
  | { kind: "note"; path: string }
  | { kind: "hex"; mapId: string; q: number; r: number }
  | { kind: "point"; mapId: string; x: number; y: number }
  | { kind: "custom"; namespace: string; data: unknown };

interface ZoneResolver {
  id: string;
  kinds: ZoneLocator["kind"][];
  resolve?(locator: ZoneLocator): string | null;
  resolveAsync?(locator: ZoneLocator): Promise<string | null>;
}
```

| Member | Contract |
|---|---|
| `id` | Identity. The engine does not otherwise enforce that it is unique, so namespace it (`"my-maps.hex"`). |
| `kinds` | The locator `kind`s this resolver handles. Wadjet only passes a resolver locators whose `kind` is in this list. |
| `resolve(locator)` | Optional *(API 1; required before)*. Return a zone id, or `null` if this resolver doesn't know. It may throw; the walk catches the error and moves on. The returned id must name a zone that currently exists. The walk re-checks it. |
| `resolveAsync(locator)` | Optional *(API 1)*. Returns the same answer as a promise. Only `resolveZoneAsync` calls it, with a 2000 ms budget. A resolver needs `resolve`, `resolveAsync`, or both. Registration throws a `TypeError` if it has neither. |

`ZoneLocator` is a closed, tagged union. Use `"custom"` with a `namespace` for a locator kind the
union does not otherwise cover.

**Conventions.**

- `hex`: `q` and `r` are axial coordinates in the map's own axial system. Wadjet does not depend
  on whether the map is pointy- or flat-topped; only the map's own resolver interprets them.
- **Map regions** (a named area on a map, a province, a biome painted over many hexes) use
  `custom` with a namespace of `"<your plugin id>.region"`:

  ```ts
  wadjet.resolveZone({ kind: "custom", namespace: "my-maps.region", data: { mapId: "west-march", regionId: "fen" } });
  ```

  A resolver for that namespace declares `kinds: ["custom"]` and returns `null` for any other
  namespace.

### Built-in resolver: `wadjet.frontmatter`

On load, Wadjet registers one resolver of its own. It is first in the chain and is registered
through the same public `registerZoneResolver` that any plugin uses. For `{ kind: "note", path }`
it reads the note's `weather-zone` frontmatter key:

```yaml
---
weather-zone: greywold-highlands   # a zone id, or a zone name
---
```

An exact zone id match wins. Otherwise the resolver returns the first zone whose name matches
case-insensitively. If neither matches, it returns `null` and the walk moves on to the next
resolver. The code block uses this resolver (§8).

### Worked example: an async resolver

This resolver has to read a file before it can answer. It also answers synchronously from a
cache, so the code block and `resolveZone` can use it once the cache is warm.

```ts
const cache = new Map<string, string | null>();
const off = wadjet.registerZoneResolver({
  id: "my-maps.hex",
  kinds: ["hex"],
  resolve: (l) => (l.kind === "hex" ? (cache.get(`${l.mapId}:${l.q},${l.r}`) ?? null) : null),
  resolveAsync: async (l) => {
    if (l.kind !== "hex") return null;
    const key = `${l.mapId}:${l.q},${l.r}`;
    if (!cache.has(key)) {
      const map = JSON.parse(await this.app.vault.adapter.read(`maps/${l.mapId}.json`));
      cache.set(key, map.cells?.[`${l.q},${l.r}`]?.zone ?? null);
    }
    return cache.get(key) ?? null;
  },
});
this.register(off);

const zoneId = await wadjet.resolveZoneAsync({ kind: "hex", mapId: "west-march", q: 3, r: -1 });
```

### Interpreters

Wadjet reports weather. It does not decide what weather does to a game, such as travel pace,
saving throws, encounter odds or mood. Those rulings live in interpreters that other plugins (a
game system, a hex crawler, your own script) register. Wadjet ships none.

```ts
interface WeatherInterpreter<T = unknown> {
  id: string;            // namespaced: "my-system.mood"; unique among live registrations
  label: string;         // shown in pickers and in the code block
  facet: string;         // free-form grouping key
  description?: string;
  interpret(report: WeatherReport, ctx: InterpretContext): T; // synchronous
  format?(result: T): string; // one line for the code block
}

interface InterpretContext {
  zoneId: string;                     // report.zoneId
  classification: Classification;     // classify(report)
  time: TimeContext;                  // timeAt(report.dayOrdinal, report.zoneId), with report.hour when set
  options?: Record<string, unknown>;  // whatever the caller passed to interpret()
}

interface InterpreterInfo { id: string; label: string; facet: string; description?: string }
```

- **`facet`** is a free-form string that groups interpreters answering the same kind of
  question. A consumer can use it to offer "every interpreter with facet X" in a picker. Wadjet
  gives facets no meaning and defines no result shapes. What an interpreter returns is agreed
  between it and its callers.
- **`interpret`** must be synchronous. Return a value, not a promise.
- If `report.zoneId` names a zone that no longer exists (a hand-built report), `ctx.time` is the
  calendar's context without a hemisphere flip.

Example: a made-up "mood" interpreter that a game-system plugin might register.

```ts
import type { WeatherInterpreter } from "./wadjet";

const mood: WeatherInterpreter<{ mood: string; score: number }> = {
  id: "my-system.mood",
  label: "Mood",
  facet: "mood",
  description: "How the day feels at the table",
  interpret: (report, ctx) => {
    const c = ctx.classification;
    if (c.precipitation === "heavy" || c.beaufort >= 8) return { mood: "grim", score: -2 };
    if (c.oktas <= 2 && c.feelsLike.mean >= 15) return { mood: "bright", score: 1 };
    return { mood: "plain", score: 0 };
  },
  format: (r) => `${r.mood} (${r.score >= 0 ? "+" : ""}${r.score})`,
};
const off = wadjet.registerInterpreter(mood as WeatherInterpreter);
this.register(off);

const report = wadjet.getReport("greywold-highlands");
const { mood } = wadjet.interpret<{ mood: string; score: number }>("my-system.mood", report);
```

A note can show the same ruling without code: put `interpret: my-system.mood` in a `wadjet` code
block (§8).

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
| `geography` | `Geography`, optional | Present if the zone was created "by geography". It is informational, and records how the zone was matched. Generation does not consult it again. |
| `preset` | `{ id, contentHash, matched }`, optional | Lineage: which shipped preset this zone was copied from, a content hash of that preset at copy time, and whether the match was automatic (from geography) or manual (picked by name). The preset itself is not referenced again at runtime. Everything the generator needs is in `climate`/`regimes` below. |
| `climate` | `ClimateParams` | The resolved climate parameters the generator reads (Tier C). This is the stored, editable state. |
| `regimes` | `Regime[]` | The synoptic regime layer (§6). At least one entry with `weight > 0` is required. |
| `modifiers` | `Modifier[]` | The modifier list (§7). |
| `coordinate` | `{ x: number; y: number }`, optional | Reserved for a future spatial-correlation feature. Generation does not use it today. |
| `automation` | `AutomationLane[]`, optional | Values that move over the world's years (see `AutomationLane` below). An absent or empty list behaves the same as before lanes existed. Only a non-empty list enters the profile hash. |
| `flipSeasons` | `boolean`, optional | Southern-hemisphere view of the active calendar: `season:*` tags are recomputed half a year away (see `flipSeasons` below). It changes tags only, not climate values, and it is not part of the profile hash. |

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
| `latitude` | `number`, degrees | Used only at zone-creation time, for nearest-preset matching and a latitude-based temperature adjustment (Azgaar-style piecewise constants). Negative values are southern hemisphere and flip the seasonal phase. |
| `altitude` | `number`, metres | Used at creation time for a −6.5 °C/km lapse-rate adjustment. |
| `continentality` | `number`, `[0, 1]`, optional | `0` = coast, `1` = deep interior. Omit it to ignore this axis when matching and to keep the matched preset's own seasonal swing. |
| `orographic` | `"none" \| "windward" \| "leeward"` | Used only to steer which preset is chosen: windward slopes match wetter presets, leeward slopes drier ones. It has no other effect on the stored climate. |

### `ClimateParams`

Every numeric leaf is a `Curve` unless noted "scalar". All units per the doc comments in
`src/core/types.ts`.

#### `temperature`

| Path | Type | Units | Description |
|---|---|---|---|
| `temperature.mean` | Curve | °C | Daily mean. |
| `temperature.diurnalRange` | Curve | °C | `Tmax − Tmin`. |
| `temperature.phase` | scalar | yearPhase `[0,1)` | yearPhase of the coldest day. The hemisphere is set here. Required, with no default. |
| `temperature.wetDayOffset` | Curve | °C | Added to the mean on wet days. Usually negative in summer, when wet days run cooler. |
| `temperature.persistence` | scalar | AR(1) coefficient | Error outside `[0, MAX_PERSISTENCE]` (`MAX_PERSISTENCE` is 0.95). Warning above `0.9`, because a faint seam may appear every 64 days. See the validation table in §7. |
| `temperature.sd` | Curve | °C | Residual SD of the daily mean. Used for `sdHigh`/`sdLow` when they are absent. |
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
| `precipitation.freezingPoint` | scalar | °C | Precipitation is snow when the daily mean is at or below this value, and sleet in the 2 °C band above it (`SLEET_BAND_C`). Otherwise it is rain or drizzle. |

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
| Constant | `number` | The value every day of the year. Example: `"wind.wetDayScale": 1.3` is always scalar, because it is not a Curve path. `"precipitation.scale": 6` is a Curve path held at `6` mm year-round. |
| Harmonic | `{ mean, amplitude, phase }` | Single-cosine seasonal curve: `mean + amplitude · cos(2π(yearPhase − phase))`. `phase` is required and has no default. Validation rejects a harmonic without it. Example: `{ "mean": 8.5, "amplitude": 7, "phase": 0.08 }` peaks 7 above the mean near `yearPhase = 0.08`, and is the same amount below the mean half a year later. |
| Keyframes | `Array<{ at, value }>` | Explicit points on the annual cycle, `at ∈ [0,1)`, interpolated with a periodic monotone (Fritsch–Carlson) cubic. The interpolation does not overshoot the keyframe values, so a curve built from probabilities stays a valid probability. Example: `[{ "at": 0.0, "value": 0.2 }, { "at": 0.5, "value": 0.8 }]`. Must have at least one entry, and each `at` must be in `[0,1)`. |

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
| `meanDurationDays` | `number ≥ 1` | Geometric mean duration before the regime is re-rolled. Validated `≤ 30`. A larger value produces a warning, not an error: long-lived states belong in a spell modifier, not a regime. |
| `apply` | `ModifierOp[]`, optional | Daily-stage ops (§7) applied to that day's evaluated parameters whenever this regime is active. They use the same op vocabulary and per-path rules as a `daily`-stage modifier. |

### `AutomationLane` — a value that moves over years

A `Curve` moves a parameter over the year. A lane moves it over the world's years, for example a
warming trend, a century of drought, or winds that weaken over an age.

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
| `id` | `string` | Unique within the zone. Names the lane in the UI. Generation does not read it. |
| `param` | `CurvePath` | The parameter the lane moves. Scalar paths are rejected, because a lane is a daily-stage op and the daily stage has no scalars. |
| `op` | `"offset" \| "scale"` | How the lane's value is applied. `set` and `clamp` are not lane ops, because a lane is a continuous value, not a replacement or a bound. |
| `points` | `Array<[year, value]>` | At least one point. Years must be strictly ascending, and every number must be finite. Years are the calendar's own year numbers, as `Era.from`/`to` are. |
| `enabled` | `boolean`, optional | Absent means on. A disabled lane emits nothing, but it is still hashed, so muting a lane changes the provenance. |

| Rule | Detail |
|---|---|
| Interpolation | `value(y)` is linear between points. Outside the authored span it is clamped to the first or last value. A single point gives that constant everywhere. |
| The year of a day | `y = year + yearPhase`, so a point at year *N* lands on the first instant of year *N*. `year` is `TimeContext.year`, else `floor(dayOrdinal / yearLength) + 1`. A caller supplying neither (e.g. the bare `gregorianTime` helper) gets a 365-day year. |
| Where it applies | Each enabled lane becomes one daily-stage op on `param`. It is pushed after the regime's `apply` and before the zone's own daily modifiers, so a modifier can still override the lane on a given day. For `offset`/`scale` on a curve, the result is the same as a climate-stage op. |
| Hashing | `automation` enters `profileHash` only when non-empty. A zone that has never had a lane has the same hash as before lanes existed. |

### `flipSeasons` — a southern-hemisphere view of the calendar

`flipSeasons: true` gives one zone the opposite half of the year. Every `season:*` tag on the day
is replaced by the season at `(yearPhase + 0.5) mod 1`, read from the active adapter's
`describe().seasons` (§5).

| Rule | Detail |
|---|---|
| Tags only | Nothing else about the day changes: not `temperature.phase`, not the curves, not the report. If a flipped zone's climate still peaks in the calendar's summer, move its `temperature.phase`. The flip has not failed. |
| Opaque calendars | An adapter with no `describe()`, or one describing no seasons, is unaffected. The day's tags are returned unchanged, because the zone has no season layout to flip. |
| Days with no season tag | The flipped tag is still added. `describe()` is the adapter's statement of its season layout, and a flipped zone is a view of that layout, not of the tags the adapter emitted. |
| Tag order | The flipped tag takes the position of the first `season:*` tag it replaced, so tag order stays stable. |
| Who notices | Only things that read tags: `tag` predicates, `ModGate.source`, and `WeatherReport` consumers reading `TimeContext.tags`. |
| Hashing | Not part of `profileHash`, because it is calendar-side. The per-zone generator cache key carries it instead. |

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
| `when` | `Predicate`, optional | Condition gating a `daily`-stage modifier, or the window a `spell` may start in. Not allowed on a `climate`-stage modifier, because climate-stage edits are unconditional. Setting `when` on a `climate`-stage modifier is a validation error. |
| `spell` | `SpellSpec`, optional | Turns `when` into a multi-day event (see below). Also not allowed on `climate` stage. |
| `apply` | `ModifierOp[]` | The ops to run when active, in list order. |
| `tag` | `string`, optional | Added to `WeatherReport.conditions` while the modifier is active. A modifier with a `tag` and no meaningful `apply` (e.g. `apply: []`) is pure flavour text. |
| `enabled` | `boolean`, optional | Power switch, absent = enabled. `enabled: false` skips the modifier at both stages: no ops, no `tag`, and its climate-stage ops are not folded into the resolved climate. This differs from a modifier gated out by its `mods` (below), which still runs and still tags the day. |
| `mods` | `ModGate[]`, optional | Mod-matrix gates. Absent or empty is a factor of 1. `daily` stage only. `mods` on a `climate`-stage modifier is a validation error, because a climate-stage modifier is unconditional. |

### Id conventions

`Modifier.id` is free text, unique within the zone. One prefix is reserved, and the Climate Studio
reads back two conventions.

| Id | Status | Meaning |
|---|---|---|
| `era:…` | **Reserved; validation error on a zone modifier** | Belongs to the era timeline. An era with ops becomes the synthetic modifier `era:<name>` (§7b). |
| `layer:<param>` | Convention | The channel editor's all-year `offset` on `<param>`, at the `climate` stage. |
| `layer:<param>:scale` | Convention | The same channel's all-year `scale`. |
| `layer:<param>:curve` | Convention | The same channel's drawn keyframes: a `set` carrying a whole `Curve`. |
| `layer:<param>:swing` | Convention | The same channel's swing: a `set` carrying the amplitude-rescaled base. It is re-derived whenever the offset, scale or curve under it changes. |
| `layer:<param>:season:<X>` | Convention | The trim scoped to a season tag: `offset`, `when: { tag: "season:<X>" }`, at the `daily` stage. |
| `layer:<param>:season:<X>:set` | Convention | The same season scope on an absolute path (wind direction): `set` rather than `offset`. |
| `layer:<param>:moon:<X>` | Convention | The trim carried on a moon: `offset` plus an `envelope`, `when: { moon: … }`, at the `daily` stage. |
| `forcings:temperature.mean` | Convention | The Forcings window's temperature trim, as a climate-stage `offset`. |
| `forcings:precipitation` | Convention | The Forcings window's wetness: one climate-stage `scale` applied to both `precipitation.pwd` and `precipitation.pww`. |

`<param>` is a `CurvePath`; `<X>` is a season or moon name, verbatim.
[§7c](#7c-the-climate-studio) gives the same table with the control that writes each id. That
section is the source of truth. The table is repeated here because `Modifier.id` is where a reader
first meets the conventions.

The conventions are only conventions. The engine reads no id except an `era:`-prefixed one and a
regime id in a `regime` predicate, so a hand-written zone can ignore them. An id that carries a
convention prefix but does not decompile cleanly is shown as an ordinary device with a "custom"
chip. It is not dropped. On save the studio orders `modifiers[]` as `layer:*`, then devices in
rack order, then `forcings:*`. The order is meaningful, because ops stack in list order, but it is
not enforced.

### `ModGate` — mod-matrix gates

```ts
interface ModGate {
  source: string;   // a TAG, never a moon
  amount: number;   // gate strength in [0, 1]
}
```

| Field | Type | Description |
|---|---|---|
| `source` | `string` | A tag: `season:Harvest`, `era:Ice Age`, or a tag set by a modifier earlier in the list the same day. The engine tests tag membership and nothing else. There is no `moon:` gate. A moon shapes a modifier as its carrier instead, through `when.moon` plus an `envelope` (see Ops below). A `source` starting with `moon:` is a validation error, not a tag that fails to match. |
| `amount` | `number` in `[0, 1]` | The gate's strength: how hard it restricts the modifier to `source`. `1` is a hard gate (the modifier is silent on any day without the tag), `0.5` halves it on those days, and `0` is no gate. Anything outside `[0, 1]` is a validation error. A gate does not amplify. Author the device at the magnitude you want at its strongest, inside its source. |

| Rule | Detail |
|---|---|
| Factor | A gate restricts a modifier to its source. Each gate contributes ×1 on a day carrying its `source` tag and ×`(1 − amount)` on every other day. The day's gate factor is the product across gates, so a modifier with two gates runs at full strength only on a day that carries both tags. A modifier with no gates has factor 1. Every factor is in `[0, 1]`, so the product is too. |
| Sign is safe | The factor `f` is in `[0, 1]` and a `scale` value is non-negative, so `1 + (v − 1)·f` lies between `v` and `1`. A gate cannot flip the sign of a scaled parameter. Validation enforces the bound; the engine does not clamp it. |
| What it scales | The magnitude of each op, not the day's value: `offset v → v · f`, `scale v → 1 + (v − 1) · f`. `set` and `clamp` pass through unchanged, because there is no partial form of a `set`. |
| A gated-out modifier is **muted**, not disabled | At factor 0 the ops still run (as `offset 0` / `scale 1`). The modifier stays active, still contributes its `tag`, and is still visible to later `tag` predicates. Only `enabled: false` removes a modifier. |
| Chaining | Gates read the day's tags as the modifier's own predicate saw them, so a modifier earlier in the list can gate a later one. |
| With an envelope | Gate factor and envelope strength multiply. |

### Stage semantics

| Stage | When applied | What it edits | Conditions allowed |
|---|---|---|---|
| `climate` | Once, at profile-resolution time, not per day. The ops are folded into the zone's resolved `climate` before any day is generated. | `Curve`-typed or scalar climate paths (per-Curve-variant table in §7). This is a structural edit to the curve itself and affects every later evaluation of it. | None. Climate-stage edits are unconditional; `when`/`spell` are validation errors here. |
| `daily` (default) | Per day, after that day's climate curves have been evaluated to scalars and the active regime's own `apply` list has run. | The day's already-evaluated scalar parameters (`DayParams`, one entry per `CurvePath`) via `set`/`offset`/`scale`/`clamp`, not the underlying Curve. Ops from multiple active modifiers apply in modifier-list order, each stacking on the previous result. | `when` and/or `spell`. |

After all daily-stage ops for the day have run (the regime's `apply` plus every active modifier's
`apply`), the engine normalises the parameters, whatever the ops did:
probability-typed paths (`precipitation.pww`, `precipitation.pwd`, `humidity.dry`, `humidity.wet`,
`cloud.dry`, `cloud.wet`, `wind.calmFraction`) are clamped to `[0, 1]`; strictly-positive paths
(`precipitation.shape`, `precipitation.scale`, `temperature.sd`, `temperature.sdHigh`,
`temperature.sdLow`, `wind.speedSd`, `wind.directionSpread`) are floored at a small epsilon;
non-negative paths (`temperature.diurnalRange`, `wind.speed`) are floored at `0`;
`wind.direction` is wrapped to `[0, 360)`. An unknown parameter path throws. A typo is a
validation error, not a silent no-op.

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

A predicate object must have exactly one of these keys. The validator rejects zero or multiple
keys, and rejects any key not in this list.

| Predicate | Shape | Semantics |
|---|---|---|
| `all` | `Predicate[]` | True iff every child is true. An empty array is vacuously true. |
| `any` | `Predicate[]` | True iff at least one child is true. |
| `not` | `Predicate` | Negation of the child. |
| `moon` | `{ name: string; phase: [lo, hi] }` | True iff a moon named `name` exists in the day's `TimeContext.moons` and its `phase` (`[0,1)`, `0` = new, `0.5` = full) falls in `[lo, hi)` on the unit circle. The range wraps if `lo > hi`: `[0.9, 0.1]` covers the phases near new moon on both sides of `0`. If `lo === hi` the predicate is always false. If no moon of that name exists in the context, the predicate is false. |
| `yearPhase` | `[lo, hi]`, values in `[0, 1]` | Same wrap-around semantics on the circle as `moon.phase`, tested against `TimeContext.yearPhase`. |
| `dayOfYear` | `[lo, hi]`, numbers in `[0, 100000]` | Inclusive on both ends (`dayOfYear >= lo && dayOfYear <= hi`). The range does not wrap. False if the time context has no `dayOfYear`. |
| `tag` | `string` | True iff the string is present in the day's tags: `TimeContext.tags` (calendar-provided: seasons, eras, festivals) plus tags set by modifiers earlier in the list the same day. Spells replay earlier days and see only calendar tags. `WeatherReport.conditions` is not tested. |
| `regime` | `string` (a regime id) | True iff that regime is the one active on the day. The regime is only known at generation time. See the SpellSpec "Start probability" bullet for how this affects `spell` window estimation. |
| `chance` | `number`, `[0, 1]` | A per-day Bernoulli draw seeded by `hash(seed, zoneId, dayOrdinal, "mod:<modifierId>:chance")`. Each day is drawn independently, with no memory. Use this for a single freak day; use `spell` for a run of days. |

### `SpellSpec` — multi-day events

```ts
interface SpellSpec {
  meanStartsPerYear: number;   // > 0
  meanDurationDays: number;    // >= 1
}
```

A spell turns a `when` condition into a run of consecutive active days rather than a per-day test:

- **Start probability.** For each candidate day inside the `when` window, the per-day probability
  of a spell starting is `meanStartsPerYear / windowDays`. `windowDays` is the count of days
  (0–364, a reference year) on which the regime-stripped `when` predicate holds: any `regime`
  sub-predicate is treated as vacuously true for this estimate, because the regime for an
  arbitrary future day is not known in advance. The result is clamped to `≤ 1`. Draws are seeded
  by `hash(seed, zoneId, day, "mod:<id>:spell")`.
- **Duration.** Geometric with mean `meanDurationDays`, seeded by `hash(seed, zoneId, startDay,
  "mod:<id>:spell-duration")`.
- **No re-trigger while active.** A day already covered by a running spell is skipped as a
  candidate start, so a spell does not overlap itself.
- **Lookback.** To decide whether day `d` is inside an active spell, the engine scans backward from
  `d` for up to `min(400, ceil(meanDurationDays × 8) + 1)` days (`SPELL_LOOKBACK_MAX = 400`) and
  replays the start and duration draws. The result is therefore a pure function of `d`, whatever
  the query order or range. For this reason validation warns when `meanDurationDays > 50`.
- **Regime-gated spells** (a `when` that includes a `regime` predicate) use the current regime of
  the queried day for the entire lookback scan, not the regime that was active on each earlier
  candidate day. This is a documented approximation. Regime-gated spells are unusual, and regimes
  already have their own duration.

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

Ops apply in `apply` list order, then in declaration order across stacked modifiers and the regime.

`param` must be one of the closed paths in the `ClimateParams` table above (§6). `climate`-stage
ops may target any `CurvePath` or `ScalarPath`. `daily`-stage ops, and a `Regime.apply`, may target
only a `CurvePath` (the corresponding evaluated `DayParams` key). A daily-stage op or a regime
cannot touch `temperature.phase`, `temperature.persistence`, `precipitation.freezingPoint`,
`humidity.sd`, `cloud.sd`, or `wind.wetDayScale`.

#### Per-Curve-variant table (climate-stage ops on a `CurvePath`)

| op | on a constant | on a harmonic | on keyframes |
|---|---|---|---|
| `set` | replaced by `value` (see note) | replaced by `value` (see note) | replaced by `value` (see note) |
| `offset` | `curve + value` | `mean += value` (amplitude/phase untouched) | every keyframe's `value += value` |
| `scale` | `curve × value` | `mean ×= value`, `amplitude ×= value` (phase untouched) | every keyframe's `value ×= value` |
| `clamp` | clamped in place | Materialised to 24 evenly spaced keyframes, each clamped point-wise. This is a stated deviation from the design doc, which describes a runtime bound instead. The observable effect is the same, with one fewer Curve variant. | every keyframe's `value` clamped |

> **Note on `set`:** `value` is `number | Curve`, so a climate-stage `set` can replace the target
> with a whole annual shape (a constant, a `Harmonic`, or a `Keyframe[]`), whatever the target was
> before. The Climate Studio uses this to write a curve without mutating the zone's stored
> `climate`. A Curve value is allowed only at the climate stage and only on a `CurvePath`. A
> daily-stage op gets `apply[i].value: "set with a curve is climate stage only"`, and a
> climate-stage `set` of a curve on a `ScalarPath` is also an error. A numeric `value` behaves as
> before at both stages.

`clamp` requires at least one of `min`/`max`; the other ops require a finite numeric `value`.
On a daily-stage op, and on a climate-stage op that targets a `ScalarPath`, `clamp` is a plain
numeric clamp with no keyframe materialisation. In both cases the value is already a scalar, so
there is no Curve to sample.

#### `enabled` — the per-op power switch

Absent = enabled. `enabled: false` drops the op before it reaches the curves. This applies at both
stages and in every list that carries ops: a modifier's `apply`, a `Regime.apply`, and an
`Era.apply`. It is independent of the modifier's own `enabled`. A disabled op inside an enabled
modifier leaves the modifier active, so the modifier still contributes its `tag`. Disabling every
op of a modifier is therefore not the same as disabling the modifier.

#### `envelope` — an onset shape carried on a moon

```ts
envelope?: Array<[number, number]>;   // [[phase, strength], …]
```

A device that fires "on the full moon" usually should not switch on and off abruptly. An envelope
shapes the op's magnitude across the carrier moon's cycle, so the effect rises and falls gradually.

| Rule | Detail |
|---|---|
| Carrier | The moon named in a bare `when: { moon: … }` predicate; otherwise the first moon of the day. If the day has no moons, the envelope has no effect (factor 1). A `moon` nested inside `all`/`any`/`not` is not a bare `when.moon` and does not name the carrier. |
| Sampling | Points are sorted by `phase` and interpolated linearly. The segment from the last point back to the first wraps across `1 → 0`, so the shape is continuous around the cycle. A single point gives a constant strength. |
| Effect | Strength `s` scales the op's magnitude in the same way as a gate factor: `offset v → v · s`, `scale v → 1 + (v − 1) · s`. Gate factor and envelope strength multiply. |
| `set` / `clamp` | Ignore it. Validation raises a warning (`"envelope has no effect on set/clamp"`), not an error. |
| Stage | `daily` only. An envelope on a `climate`-stage op is an error. The engine strips `envelope` from the op before it reaches the curves. |
| Shape rules | The array must be non-empty. Each point is `[phase ∈ [0,1), strength ∈ [0,1]]`. Strength works as a dimmer: a strength above 1 is a validation error, so an envelope can shape a device's onset but cannot amplify it past the magnitude the author wrote. |

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
third-party calendar can name its own phases. The phases are display metadata only.

| Rule | Detail |
|---|---|
| `at` | A boundary on the moon's own cycle, in `[0,1)` (`0` = new, `0.5` = full). Names are unique and `at` values ascend. A named phase runs from its own `at` to the next boundary, wrapping past `1 → 0`. |
| The engine never sees a name | A UI compiles a selection of named phases to a single `moon.phase` range `[a, b)`, from the first selected phase's `at` to the boundary after the last selected phase. In the other direction, a range whose ends coincide with boundaries decompiles back to a phase selection. Any other range is shown as a custom range. |
| Not hashed | `phases` is not part of the config hash, so renaming or re-cutting phases cannot change generated weather. |

### Validation (errors block generation; warnings don't)

Run via `validateProfile(zone)`. `getReport`/`getRange` throw if any error-level issue is present.

| Path | Level | Condition |
|---|---|---|
| `id` | error | Zone `id` missing. |
| `climate` | error | `climate` object missing. All other climate checks are skipped. |
| `climate.<param>` (every required Curve path) | error | Not a valid Curve: not finite (constant), empty keyframe array, keyframe missing numeric `at`/`value`, `at` outside `[0,1)`, a harmonic missing numeric `mean`/`amplitude`/`phase`, or `phase` outside `[0,1)`. |
| `climate.temperature.persistence` | error | Missing or outside `[0, MAX_PERSISTENCE]` (`MAX_PERSISTENCE` = 0.95, from `src/core/generator.ts`). |
| `climate.temperature.persistence` | warning | Above `0.9`: "a faint seam may appear every 64 days" (the block-warm-up seam, §9). |
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
| `modifiers[i].when` | error | Predicate shape violations: wrong key count, unknown predicate key, or out-of-range values. The ranges are those in the Predicates table: `moon.phase`/`yearPhase` must be within `[0,1]`, `dayOfYear` within `[0, 100000]`, `chance` within `[0,1]`, and `tag`/`regime` must be non-empty strings. |
| `modifiers[i].spell.meanStartsPerYear` | error | Not `> 0`. |
| `modifiers[i].spell.meanDurationDays` | error | `< 1`. |
| `modifiers[i].spell.meanDurationDays` | warning | `> 50`: "very long spells (> 50 days) are looked back over at most 400 days". |
| `modifiers[i].apply` | error | Not an array; any op not an object; op's `param` not a valid path for the modifier's stage; op's `op` not one of `set`/`offset`/`scale`/`clamp`; `clamp` with neither `min` nor `max`; non-`clamp` op with a non-finite `value`. |
| `modifiers[i].enabled`, `modifiers[i].apply[j].enabled` | error | Present but not `true`/`false`. |
| `modifiers[i].mods` | error | Not an array, or present on a `climate`-stage modifier. |
| `modifiers[i].mods[j].source` | error | Not a non-empty string, or starting with `moon:`: "a gate is a tag; a moon is the carrier (use `when.moon`)". |
| `modifiers[i].mods[j].amount` | error | Not a number in `[0, 1]`: "gate strength: 1 restricts to the source, 0 is no gate". |
| `modifiers[i].mods[j].<field>` | warning | Unknown field on a gate. It is ignored. |
| `modifiers[i].apply[j].envelope` | error | Present on a `climate`-stage op, or not a non-empty array. |
| `modifiers[i].apply[j].envelope[k]` | error | Not `[phase ∈ [0,1), strength ∈ [0,1]]`. |
| `modifiers[i].apply[j].envelope` | warning | On a `set`/`clamp` op. Those ops ignore it. |
| `flipSeasons` | error | Present but not `true`/`false`. |
| `automation` | error | Present but not an array. |
| `automation[i].id` | error | Missing/blank, or duplicate within the zone. |
| `automation[i].param` | error | Not a `CurvePath` (a lane cannot target a scalar path). |
| `automation[i].op` | error | Not `offset`/`scale`. |
| `automation[i].enabled` | error | Present but not `true`/`false`. |
| `automation[i].points` | error | Missing or empty. A lane needs at least one `[year, value]` point. |
| `automation[i].points[j]` | error | Not a two-number `[year, value]` pair. |
| `automation[i].points[j][0]` | error | Year not finite, or not strictly greater than the previous point's year. |
| `automation[i].points[j][1]` | error | Value not finite. |
| `automation[i].<field>` | warning | Unknown field on a lane. It is ignored, as on eras. |

The complete list of paths this table can produce is checked in as
`test/fixtures/studio/validator-paths.json` (`EXPECTED_PATHS`). `test/validator-paths.test.ts`
fails unless the paths raised on the `test/fixtures/studio/trip-every-rule.json` fixtures plus a
few mini-fixtures equal that file. A rule with no path in that file has nowhere to appear in the UI.

---

## 7b. The era timeline

Eras are world-level and set in *Settings → Calendar → Eras*. They apply under any time adapter.
They are stored in `data.json` as `eras: Era[]`.

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
| Tags | Every era covering the year adds `era:<name>` to the day's `TimeContext.tags`, after the adapter's own tags and in list order. The `tag` predicate can read it. It is not copied into `conditions`. |
| Ops | An era with a non-empty `apply` becomes a synthetic daily modifier `{ id: "era:<name>", when: { tag: "era:<name>" }, apply }`. It is appended after the zone's own modifiers, so ops run zone → era. It has the same op semantics and validation as a daily-stage modifier (no scalar paths). |
| Overlap | Overlapping eras all apply, in list order. |
| `enabled` | Absent means on. `enabled: false` removes the era from the whole timeline: no `era:<name>` tag, no synthetic modifier, no ops. It is still hashed, so muting an era changes provenance. Individual ops inside `apply` carry their own `enabled` (§7). |
| Provenance | `calendarHash` gains `+eras:<hash>`, and the per-zone generator cache is keyed on it. Editing eras changes past weather. |
| Reserved | Zone modifier ids may not start with `era:` (validation error). |
| Validation | `name` is required and unique. `from`/`to` are whole years, with `to ≥ from`. `apply` is validated as daily ops. `enabled` must be boolean if present. Unknown fields produce a warning. The settings row does not save while there is an error. |
| Spells | A spell's start window is estimated over days 0–364 of the calendar. If the spell is gated on an era that starts later, no day qualifies and the window falls back to a whole year. `meanStartsPerYear` is therefore read as "per year inside the era". |

Eras are steps on the absolute timeline, not cycles. See `NON-GOALS.md`.

---

## 7c. The Climate Studio

The studio (*Zones → Open in studio*, or the *Open climate studio* command) is an editor for the
schema above. It adds no grammar of its own. Everything it produces is a `Modifier` (§7), an
[`AutomationLane`](#automationlane--a-value-that-moves-over-years), a
[`Regime`](#regime), [`flipSeasons`](#flipseasons--a-southern-hemisphere-view-of-the-calendar), an
[`Era`](#7b-the-era-timeline), or an `Override`. It does add a set of id conventions, so that it
can find a knob's value again the next time the zone is opened.

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
| `forcings:precipitation` | `climate` | `scale` on both `precipitation.pwd` and `precipitation.pww` | Forcings window, wetness |
| `automation` lane `frc.warmth` | — | `offset` on `temperature.mean` | The `FRC · warmth` lane in the playlist |

| Rule | Detail |
|---|---|
| The engine ignores these ids | Ids are a UI convention. The one reserved id prefix is `era:` (see [Id conventions](#id-conventions)). A hand-written zone may use any unique ids, and the generator behaves the same. |
| Order is meaningful | On save, the studio partitions `modifiers[]` as `layer:*` → devices in rack order → `forcings:*`. Ops stack in list order, so this partition is what puts the trim on top of the layers. Nothing enforces it. A file ordered by hand is left as it is. |
| Strays are kept as written | An id that carries a `layer:`/`forcings:` prefix but does not match the shape that prefix describes is shown as an ordinary device with a "custom" chip. The studio does not rewrite or drop it. |
| Anything else is a device | A modifier whose id is neither `layer:*` nor `forcings:*` is a device. It gets a mixer card and an editor window. If its `when` has a time shape, it also gets a lane. |
| Swing is derived | `layer:<param>:swing` is re-derived from the current effective base whenever the offset, scale or curve under it changes, so the three knobs stay independent. |
| Pins | The audition strip's right-click pin writes an ordinary `Override` (§4 `overridden`, *Settings → Pinned days*), not a modifier. |
| Colours | The colour indices on seasons, eras and regimes are view state on the studio leaf. They are not part of the schema. |

Seasons and moons belong to the active adapter, not the zone. Under a calendar plugin that
implements [`describe()`](#calendardescription), the Seasons and cycle windows show the plugin's
seasons and moons read-only.

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

Each option is one `key: value` line. `#`-prefixed lines and blank lines are ignored. An
unparseable line or unknown key is collected as a rendered
error. The block fails closed and shows all parse errors at once. It does not stop at the first
one.

| Key | Values | Default | Notes |
|---|---|---|---|
| `zone` | a zone id | the note's zone, else the first configured zone | Errors at render time if the id doesn't match a configured zone. Without `zone:`, the block asks the resolver chain about its own note (`{ kind: "note", path }`; Wadjet's `weather-zone` frontmatter resolver answers first, §5). If that gives no zone, it falls back to the first zone. A block without `zone:` re-renders when the note's metadata changes which zone it resolves to. |
| `date` | `today` \| `+N` \| `-N` \| an integer `dayOrdinal` \| an adapter-native date string | `today` | `+N`/`-N` are relative to the active adapter's current day (`now()`). `today`/`+N`/`-N` all error if no current day is set. A bare integer (optionally negative) is taken as a literal `dayOrdinal`. Anything else is passed to the active adapter's optional `parse()`. It errors if `parse()` returns `null` or the adapter has no `parse()`. |
| `hour` | a number in `[0, 24)` | none (whole-day report) | Adds `temperature.current` and `precipitation.active`. Error if outside the range. |
| `style` | `card` \| `line` \| `prose` \| `table` \| `value` | `card` | See below. |
| `range` | integer `1`–`366` | `7` | Used only by `style: table`, as the number of consecutive days starting at `date`. |
| `field` | a `ConvertedReport` leaf: `temperature.high` `temperature.low` `temperature.mean` `temperature.current` `precipitation.type` `precipitation.amount` `precipitation.intensity` `precipitation.active` `humidity` `cloudCover` `wind.speed` `wind.directionDeg` `visibility` `regime` `conditions` `descriptors.temperature` `descriptors.precipitation` `descriptors.wind` `descriptors.sky` `overridden` `units` | none | Required for `style: value`: leaving it out is an error. The other styles ignore it. An unknown leaf is an error. |
| `units` | `metric` \| `imperial` | the setting | Applies to every style. |
| `interpret` | interpreter ids, comma-separated | none | *(API 1)* For `card`, `line` and `prose`, adds one line per id under the block: the interpreter's label and its `format(result)`, or compact JSON when it has no `format`. An id that no plugin has registered shows as an error line. The block re-renders when interpreters are registered or unregistered. With `table` or `value`, it is an error. |

### Styles

| Style | Renders |
|---|---|
| `card` | Icon, one-line summary, and a temperature / precipitation / wind / sky / humidity / visibility / conditions grid. It uses the units given by `units:` when set, else the settings (metric/imperial). A pinned note appears when the day is overridden. |
| `line` | One line, e.g. `🌧 Year 3, day 14: Cold, steady rain, breezy from the WSW, overcast. 1.1 to 7.8 °C.` |
| `prose` | A short paragraph from `describe(report, "prose")`. The README flags it as "extremely rough for the alpha". |
| `table` | One row per day for `range` days starting at `date`. Pinned (overridden) days are marked with 📌. |
| `value` | The one `field`, bare, in a `<span class="wadjet-value">`: numbers as digits (no unit), lists comma-joined, booleans `yes`/`no`, and a missing field (e.g. `temperature.current` without `hour`) as empty. |

Day numbers count from the first day of the calendar's epoch year (year 1 by default), which is
`dayOrdinal 0`. `Y-D` date strings (e.g. `3-14`) are the internal calendar's own year-day
notation, parsed by `InternalCalendar.parse`. They are one adapter-native format; other adapters
may use others.

---

## 9. Determinism contract

A `WeatherReport` is a pure function of five inputs: the world seed, the generator version, the
zone's resolved profile (climate + regimes + modifiers), the calendar configuration, and the day
number (plus hour). Nothing else changes the output: not wall-clock time, not call order, and not
caching side effects. Two vaults with identical values for those five inputs produce
byte-identical reports.

Mechanism: every random draw on day `d` is `hash(worldSeed, zoneId, d, drawName)`. No running RNG
stream is carried across days. Query cost is bounded because each day's computation replays from a
grid-anchored warm-up. Day `d` belongs to a 64-day block. That block's computation always starts
90 days before the block, from a state hashed only from `(worldSeed, zoneId, blockIndex)`. There
is one warm-up for the whole chain. A single-day query and a range query that touch the same day
produce the identical result, because both replay the same sequence from the same anchor. The
agreement comes from this structure, not from the chain having "mixed enough". `persistence` is
still capped: a value above 0.95 (`MAX_PERSISTENCE`) is an error. The cap keeps the warm-up window
long enough relative to persistence that the block seam stays invisible in practice. Correctness
does not depend on it. A regime `meanDurationDays` above 30 draws a warning, not a cap.

**What changes past weather** (anything in the five-input domain): editing a zone's climate,
regimes, or modifiers; changing the world seed; changing the calendar's year length, epoch, or
moon configuration; a plugin update that changes the generator version. The era timeline (in `calendarHash`),
automation lanes (in `profileHash`) and `flipSeasons` (in the generator cache key) also change it.
Descriptor bands and pinned overrides change the report too.

**What does not:** which zone/day you queried, in what order, or from a single-day vs. range call.

Overrides are layered on top of the generated report and always win. They are stored with the rest
of the settings in `data.json` and survive any of the above changes. `provenance.generatorVersion`
reports the running version.
