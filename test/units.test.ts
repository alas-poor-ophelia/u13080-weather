import { describe, expect, test } from "bun:test";
import { gregorianTime } from "../src/core/generator";
import { createGenerator, validateProfile } from "../src/core/profile";
import { buildReport } from "../src/core/report";
import { REPORT_FIELDS, cToF, convertReport, fieldText, isReportField, mmToIn, reportField } from "../src/core/units";
import { PRESETS } from "../src/generated/presets";
import { parseCodeblock } from "../src/plugin/codeblock-parse";
import { zoneFromPreset } from "../src/plugin/zones";

const zone = zoneFromPreset({ name: "Greywold", preset: PRESETS.find((p) => p.id === "fjord-coast")!, existingIds: new Set() }).zone;
const g = createGenerator(zone, "units", gregorianTime).generator;
const report = (d: number, hour?: number) => buildReport(g.day(d), zone.id, { seed: "units", provenance: { profileHash: "x", calendarHash: "y" }, overrides: new Map() }, hour);

describe("units", () => {
  test("the zone is valid and conversions round like the report", () => {
    expect(validateProfile(zone).filter((i) => i.level === "error")).toEqual([]);
    expect(cToF(-1.1)).toBe(30);
    expect(cToF(20)).toBe(68);
    expect(mmToIn(4.2)).toBe(0.17);
  });

  test("convertReport: metric keeps values and renames keys; imperial converts every unit-bearing field", () => {
    const r = report(100, 14);
    const m = convertReport(r, "metric");
    expect(m.precipitation.amount).toBe(r.precipitation.amountMm);
    expect(m.wind.speed).toBe(r.wind.speedKph);
    expect(m.visibility).toBe(r.visibilityKm);
    expect(m.temperature.current).toBe(r.temperature.current);
    expect(m.labels.amount).toBe("mm");
    expect("amountMm" in m.precipitation).toBe(false);
    const i = convertReport(r, "imperial");
    expect(i.temperature.high).toBe(cToF(r.temperature.high));
    expect(i.temperature.current).toBe(cToF(r.temperature.current!));
    expect(i.precipitation.amount).toBe(mmToIn(r.precipitation.amountMm));
    expect(i.wind.speed).toBeCloseTo(r.wind.speedKph / 1.609344, 1);
    expect(i.visibility).toBeCloseTo(r.visibilityKm / 1.609344, 1);
    expect(i.wind.directionDeg).toBe(r.wind.directionDeg); // degrees are degrees
    expect(i.labels).toEqual({ temperature: "°F", amount: "in", speed: "mph", distance: "mi" });
    expect(i.provenance).toBe(r.provenance);
  });

  test("every listed field resolves on a converted report (current only with an hour)", () => {
    const c = convertReport(report(100, 14), "imperial");
    for (const f of REPORT_FIELDS) expect(reportField(c, f)).not.toBeUndefined();
    expect(reportField(convertReport(report(100), "metric"), "temperature.current")).toBeUndefined();
    expect(isReportField("precipitation.amountMm")).toBe(false);
  });

  test("fieldText", () => {
    expect(fieldText(4.2)).toBe("4.2");
    expect(fieldText(["fog", "stormtide"])).toBe("fog, stormtide");
    expect(fieldText(true)).toBe("yes");
    expect(fieldText(undefined)).toBe("");
  });

  test("codeblock: value style needs a field; units and field validate", () => {
    const ok = parseCodeblock("style: value\nfield: precipitation.amount\nunits: imperial");
    expect(ok.errors).toEqual([]);
    expect(ok.field).toBe("precipitation.amount");
    expect(ok.units).toBe("imperial");
    expect(parseCodeblock("style: value").errors[0]).toContain("needs a field");
    expect(parseCodeblock("field: precipitation.amountMm").errors[0]).toContain("unknown field");
    expect(parseCodeblock("units: cubits").errors[0]).toContain("units must be");
    expect(parseCodeblock("units: metric\nstyle: card").errors).toEqual([]);
  });
});
