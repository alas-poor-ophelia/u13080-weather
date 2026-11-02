/** Every Seshat name types/wadjet.d.ts declares, from where the plugin defines it (conformance.ts compares the two). */
export type * from "../../src/seshat";
export type { HostKey, By, Recur, RuleAst } from "../../src/seshat/rule";
export type { GearAst } from "../../src/seshat/gear";
export type { Rational } from "../../src/seshat/rational";
export type { SeshatAPI, SeshatCalendarView, SeshatMark, SeshatMarks } from "../../src/plugin/seshat-api";
