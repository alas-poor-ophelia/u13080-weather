/**
 * types/wadjet.d.ts conformance, checked by `tsc --noEmit` (this file is in
 * the tsconfig project; it has no runtime tests of its own). Every shared
 * type in the standalone declaration file must be IDENTICAL to the one the
 * plugin is built from: a drift on either side stops the typecheck, and with
 * it `bun run build`.
 *
 * API_KEYS is the runtime half: test/api-surface.test.ts compares it with
 * Object.keys() of a real API object. It is typed against keyof WadjetAPI in
 * both directions, so it cannot fall out of step with the interface.
 */
import type * as D from "../../types/wadjet";
import type { WadjetAPI } from "../../src/plugin/api";
import type { Classification, PrecipitationClass, VisibilityClass } from "../../src/core/classify";
import type { GlyphKey } from "../../src/core/glyphs";
import type { PrecipType } from "../../src/core/generator";
import type { Provenance, WeatherReport } from "../../src/core/report";
import type { ConvertedReport, Units } from "../../src/core/units";
import type * as E from "../../src/plugin/events";
import type { InterpretContext, InterpreterInfo, WeatherInterpreter } from "../../src/plugin/interpreters";
import type { CalendarDescription, TimeAdapter, TimeContext } from "../../src/plugin/time/adapter";
import type { ZoneLocator, ZoneResolver } from "../../src/plugin/world";

/** Strict type identity (not mere assignability). */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type Expect<T extends true> = T;

export type Conformance = [
  Expect<Equal<WadjetAPI, D.WadjetAPI>>,
  Expect<Equal<WeatherReport, D.WeatherReport>>,
  Expect<Equal<Provenance, D.Provenance>>,
  Expect<Equal<PrecipType, D.PrecipType>>,
  Expect<Equal<Units, D.Units>>,
  Expect<Equal<ConvertedReport, D.ConvertedReport>>,
  Expect<Equal<TimeContext, D.TimeContext>>,
  Expect<Equal<TimeAdapter, D.TimeAdapter>>,
  Expect<Equal<CalendarDescription, D.CalendarDescription>>,
  Expect<Equal<ZoneLocator, D.ZoneLocator>>,
  Expect<Equal<ZoneResolver, D.ZoneResolver>>,
  Expect<Equal<Classification, D.Classification>>,
  Expect<Equal<PrecipitationClass, D.PrecipitationClass>>,
  Expect<Equal<VisibilityClass, D.VisibilityClass>>,
  Expect<Equal<GlyphKey, D.GlyphKey>>,
  Expect<Equal<WeatherInterpreter, D.WeatherInterpreter>>,
  Expect<Equal<WeatherInterpreter<{ n: number }>, D.WeatherInterpreter<{ n: number }>>>,
  Expect<Equal<InterpretContext, D.InterpretContext>>,
  Expect<Equal<InterpreterInfo, D.InterpreterInfo>>,
  Expect<Equal<E.WadjetEvent, D.WadjetEvent>>,
  Expect<Equal<E.WadjetEventPayloads, D.WadjetEventPayloads>>,
  Expect<Equal<E.ReadyPayload, D.ReadyPayload>>,
  Expect<Equal<E.ProfilesChangedPayload, D.ProfilesChangedPayload>>,
  Expect<Equal<E.TimeChangedPayload, D.TimeChangedPayload>>,
  Expect<Equal<E.AdaptersChangedPayload, D.AdaptersChangedPayload>>,
  Expect<Equal<E.ResolversChangedPayload, D.ResolversChangedPayload>>,
  Expect<Equal<E.InterpretersChangedPayload, D.InterpretersChangedPayload>>,
  Expect<Equal<E.UnloadPayload, D.UnloadPayload>>,
];

/** Every WadjetAPI member, in docs order. */
export const API_KEYS = [
  "version",
  "apiVersion",
  "ready",
  "schemaVersion",
  "generatorVersion",
  "rngVersion",
  "getReport",
  "getRange",
  "now",
  "listZones",
  "timeAt",
  "format",
  "parse",
  "canSetNow",
  "setNow",
  "advance",
  "registerTimeAdapter",
  "registerZoneResolver",
  "resolveZone",
  "resolveZoneAsync",
  "calendar",
  "listTimeAdapters",
  "describe",
  "units",
  "convert",
  "classify",
  "glyphKey",
  "glyph",
  "registerInterpreter",
  "listInterpreters",
  "getInterpreter",
  "interpret",
  "on",
] as const satisfies ReadonlyArray<keyof D.WadjetAPI>;

/** Exhaustiveness: no member of the interface is missing from API_KEYS. */
export type KeysComplete = Expect<Equal<Exclude<keyof D.WadjetAPI, (typeof API_KEYS)[number]>, never>>;
