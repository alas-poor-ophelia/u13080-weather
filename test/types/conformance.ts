/**
 * types/wadjet.d.ts conformance, checked by `tsc --noEmit` (this file is in
 * the tsconfig project; it has no runtime tests of its own). Every shared
 * type in the standalone declaration file must be IDENTICAL to the one the
 * plugin is built from: a drift on either side stops the typecheck, and with
 * it `bun run build`.
 *
 * API_KEYS is the runtime half: test/integration-api.test.ts compares it with
 * Object.keys() of a real API object (and test/typecheck.test.ts runs this
 * typecheck inside `bun test`). It is typed against keyof WadjetAPI in
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
import type * as S from "./seshat-names";

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
  Expect<Equal<S.Rational, D.Rational>>,
  Expect<Equal<S.GearAst, D.GearAst>>,
  Expect<Equal<S.SeasonMark, D.SeasonMark>>,
  Expect<Equal<S.DaySeasonMark, D.DaySeasonMark>>,
  Expect<Equal<S.SlotSeasonMark, D.SlotSeasonMark>>,
  Expect<Equal<S.DateSeasonMark, D.DateSeasonMark>>,
  Expect<Equal<S.SeasonMarkAst, D.SeasonMarkAst>>,
  Expect<Equal<S.HostKey, D.HostKey>>,
  Expect<Equal<S.RuleAst, D.RuleAst>>,
  Expect<Equal<S.Recur, D.Recur>>,
  Expect<Equal<S.By, D.By>>,
  Expect<Equal<S.GearTerm, D.GearTerm>>,
  Expect<Equal<S.CrossingAst, D.CrossingAst>>,
  Expect<Equal<S.LiteralCrossingAst, D.LiteralCrossingAst>>,
  Expect<Equal<S.BodyCrossingAst, D.BodyCrossingAst>>,
  Expect<Equal<S.BodyRef, D.BodyRef>>,
  Expect<Equal<S.StageAst, D.StageAst>>,
  Expect<Equal<S.StageRule, D.StageRule>>,
  Expect<Equal<S.ConstantRule, D.ConstantRule>>,
  Expect<Equal<S.CrossingRule, D.CrossingRule>>,
  Expect<Equal<S.CycleRule, D.CycleRule>>,
  Expect<Equal<S.ConstantCycleAst, D.ConstantCycleAst>>,
  Expect<Equal<S.CrossingCycleAst, D.CrossingCycleAst>>,
  Expect<Equal<S.CycleUnitAst, D.CycleUnitAst>>,
  Expect<Equal<S.LedgerEntry, D.LedgerEntry>>,
  Expect<Equal<S.LabelAst, D.LabelAst>>,
  Expect<Equal<S.SlotAst, D.SlotAst>>,
  Expect<Equal<S.KeyedLength, D.KeyedLength>>,
  Expect<Equal<S.SlotsUnitAst, D.SlotsUnitAst>>,
  Expect<Equal<S.UnitAst, D.UnitAst>>,
  Expect<Equal<S.DayLabelAst, D.DayLabelAst>>,
  Expect<Equal<S.RuleDefAst, D.RuleDefAst>>,
  Expect<Equal<S.BodyAst, D.BodyAst>>,
  Expect<Equal<S.MoonAst, D.MoonAst>>,
  Expect<Equal<S.SeasonsAst, D.SeasonsAst>>,
  Expect<Equal<S.FormatAst, D.FormatAst>>,
  Expect<Equal<S.CalendarAst, D.CalendarAst>>,
  Expect<Equal<S.Problem, D.Problem>>,
  Expect<Equal<S.Position, D.Position>>,
  Expect<Equal<S.SeshatCalendarView, D.SeshatCalendarView>>,
  Expect<Equal<S.SeshatAPI, D.SeshatAPI>>,
  Expect<Equal<S.SeshatMark, D.SeshatMark>>,
  Expect<Equal<S.SeshatMarks, D.SeshatMarks>>,
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
  "seshat",
  "on",
] as const satisfies ReadonlyArray<keyof D.WadjetAPI>;

/** Exhaustiveness: no member of the interface is missing from API_KEYS. */
export type KeysComplete = Expect<Equal<Exclude<keyof D.WadjetAPI, (typeof API_KEYS)[number]>, never>>;
