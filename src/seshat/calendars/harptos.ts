/**
 * The Calendar of Harptos (Forgotten Realms) as a Seshat AST (§12): twelve
 * 30-day months of three tendays, with festival days between them that
 * belong to no month and no tenday. Shieldmeet follows Midsummer in every
 * year divisible by 4: a filler slot of length 0, plus one day in a leap year.
 *
 * Fictional, so the day line is ours to place: day 0 is 1 Hammer, 1 DR, and
 * year index i is year i + 1 DR.
 */
import type { CalendarAst, SlotAst } from "../ast";

const month = (name: string): SlotAst => ({ name, length: 30 });
const festival = (name: string): SlotAst => ({ name, length: 1, filler: true });

export const HARPTOS: CalendarAst = {
  name: "Harptos",
  // festival days are named alone: "Midwinter 1372 DR"
  formats: [
    { name: "default", pattern: "{month:day} {month:name} {year} DR" },
    { name: "filler", pattern: "{month:name} {year} DR" },
  ],
  gears: [{ id: "shieldmeet", on: "year", kind: "intervals", terms: [{ every: 4, offset: -1, sign: 1 }] }],
  units: [
    { id: "year", kind: "cycle", number: 1, anchor: 0, length: 365, gears: [{ gear: "shieldmeet", add: 1 }] },
    {
      id: "month",
      kind: "slots",
      in: "year",
      slots: [
        month("Hammer"),
        festival("Midwinter"),
        month("Alturiak"),
        month("Ches"),
        month("Tarsakh"),
        festival("Greengrass"),
        month("Mirtul"),
        month("Kythorn"),
        month("Flamerule"),
        festival("Midsummer"),
        { name: "Shieldmeet", length: 0, gears: [{ gear: "shieldmeet", add: 1 }], filler: true },
        month("Eleasis"),
        month("Eleint"),
        festival("Highharvestide"),
        month("Marpenoth"),
        month("Uktar"),
        festival("Feast of the Moon"),
        month("Nightal"),
      ],
    },
    { id: "tenday", kind: "slots", in: "month", slots: [{ length: 10 }, { length: 10 }, { length: 10 }] },
  ],
};
