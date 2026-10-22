/**
 * The Calendar window's half of the hint tables (docs/SESHAT-v0.md §15.4).
 * Same house rules as `hints.ts`: product microcopy, sentence case, no
 * trailing full stop; the name says what the control is, the detail what it
 * does or writes.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const CALENDAR_HINTS: Record<string, Hint> = {
  "calendar.tabs": ["Calendar parts", "seasons, and the year, its months and its week; one at a time"],
  "calendar.leapToggle": ["Leap rules", "shows the rules as fields, or folds them back into their sentence"],
  "calendar.source": ["Calendar source", "a definition is edited here; the legacy calendar and plugin calendars are described"],
  "calendar.name": ["Calendar name", "what settings and the studio call this calendar"],
  "calendar.days": ["Days in a year", "a common year's length; changing it moves where years start"],
  "calendar.firstYear": ["First year", "the number of the year that starts on the calendar's first day; leap years keep their year numbers"],
  "calendar.leapDays": ["Leap days", "days a leap year adds"],
  "calendar.leapEvery": ["Every", "years between the years this rule matches"],
  "calendar.leapFrom": ["Counting from", "a year this rule matches"],
  "calendar.leapSign": ["Adds or removes", "whether matching years are leap years, or exceptions to a rule above"],
  "calendar.leapRemove": ["Remove rule", "drops this leap rule"],
  "calendar.leapNew": ["Add a leap rule", "a rule for which years are leap years; the first one makes leap years"],
  "calendar.monthName": ["Month name", "the name dates write"],
  "calendar.monthLength": ["Month length", "days, or rest: this month takes what the year leaves"],
  "calendar.monthRemove": ["Remove month", "its days go to the month marked rest"],
  "calendar.monthNew": ["Add a month", "a new month at the end of the year"],
  "calendar.dayName": ["Day name", "a day of the week, in order from the week's first day"],
  "calendar.dayRemove": ["Remove day", "the week gets one day shorter; weekday rules move"],
  "calendar.dayNew": ["Add a day", "the week gets one day longer; weekday rules move"],
  "calendar.weekNew": ["Add a week", "named days repeating in a week"],
  "calendar.asText": ["Edit as text", "opens the definition; this part is written in a way the fields cannot show"],
  "calendar.ledgerRemove": ["Remove exception", "the calendar's regular rules apply here again"],
  "calendar.ledgerKind": ["What to change", "name a single day, cancel one day of a rule, move one year's first day, set one year's month lengths, or change a rule from a year onward"],
  "calendar.ledgerDate": ["Date", "written as the calendar writes dates, or a day number"],
  "calendar.ledgerName": ["Day name", "what the day is called, e.g. Coronation"],
  "calendar.ledgerTags": ["Tags", "labels zone conditions can test for on this day"],
  "calendar.ledgerRule": ["Rule", "the named rule that does not apply on this day"],
  "calendar.ledgerYear": ["Year", "the year this exception changes, by its number"],
  "calendar.ledgerLengths": ["Month lengths", "one per month, in order; they must fill the year"],
  "calendar.ledgerAdd": ["Add exception", "adds it to the draft; Save stores it"],
  "calendar.change": ["Change calendar", "switches this world to a calendar definition, or another one"],
};

/**
 * The keys the Calendar window uses. `test/studio-hints-calendar.test.ts`
 * scans `src/studio/ui/windows/calendar.ts` and asserts this list is exactly
 * what it asks for.
 */
export const CALENDAR_HINT_KEYS: readonly string[] = Object.keys(CALENDAR_HINTS);

/** The `data-hint` attribute value for `key`. */
export const calendarHint: HintLookup = makeHintLookup(CALENDAR_HINTS);
