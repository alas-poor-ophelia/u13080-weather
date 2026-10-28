# Calendars

A world in U+13080 Weather runs on a **calendar definition**: a short text that says how long its
years are, what its months, weeks and moons are, where its seasons start, and which days are
festivals. The text is written in **Seshat**, the plugin's calendar language. This page has a
guide that builds one calendar step by step, a list of the commonest mistakes, and a reference to
every part of the language, its limits and its messages. To go straight to one task, see
[How do I…](#how-do-i).

## What this is not

- **It describes time, not weather.** A calendar says which day is which: its date, its season, its
  moon phase and its tags. It never sees the weather, the zones, the eras or the world seed, and a
  calendar rule cannot test a regime, a chance or a weather value. Weather reads the calendar, never
  the other way round: a zone's modifier can match a calendar tag (`{ "tag": "feast" }`) or a
  season.
- **It is not iCalendar (RFC 5545).** The text borrows iCalendar's look (`BEGIN:VCALENDAR`,
  `RRULE:FREQ=…`) and some of its words, but it is a different language. You cannot import an
  `.ics` file, and an iCalendar rule pasted in will not mean the same thing. `FREQ` names a unit of
  your own calendar (`year`, `month`), not `YEARLY` or `MONTHLY`; there is no `DTSTART`, no
  `BYMONTH`, no `BYDAY=MO`; and a rule is a test a day passes or fails, not a list of events to
  expand.
- **It does not compute real astronomy.** A moon is a clock that turns at the exact period you give
  it. Nothing here knows the real Moon, the Sun, solstices, equinoxes, sunrise or the motion of
  real bodies. Seasons start where you put them.
- **It is not a calendar view or a planner.** There is no month grid, no event list, no notes
  attached to dates and no date picker.
- **It counts whole days.** There is no time of day, no hours and no time zones. A day is a whole
  number on one line of days, from −10,000,000 to 10,000,000.
- **It does not keep your layout.** Saving a definition stores it in one canonical form: blocks are
  put in a fixed order and comments are removed.

## Where you edit a definition

A new world starts on a plain definition: 365-day years from year 1, one moon, no seasons, named
"Calendar". You can change it in three places.

- **The Studio's Calendar window.** The ruler's `Calendar ⚑` button opens it. On a world that runs
  a definition it has the tabs **Seasons**, **Year**, **Months**, **Week** and **Exceptions**, which
  edit the definition through fields. Field edits are saved with the Studio's Save. A part the
  fields cannot show (a year that follows a moon, or a month with a leap rule of its own) says so
  and offers *Edit as text*. *Edit as text* opens the stored definition, so it does not open while
  the window has unsaved field edits: it asks you to save or undo them first.
- ***Settings → Calendar → Edit definition.*** Opens the *Calendar definition* dialog: the
  definition as text. *Save* checks it; a problem is shown under the text and nothing is saved.
- ***Settings → Calendar → Change calendar…*** Opens the *Change calendar* dialog. *Start from*
  offers the real-world calendars by name and *Paste a definition (Seshat text)* (or, when one is
  already stored, *The stored definition (edit it below)*). *Bring this world's seasons and moons*
  carries the current ones over. *Day numbers* chooses between *Keep day numbers* and *Anchor today
  to a date*; *Today is* takes that date. *Switch calendar* applies it.

Every change to the definition the world runs goes through the ***Save calendar changes?*** dialog
(unless the stored definition cannot run, when there is nothing to compare it with).
It says which days' weather the change can reach and, when the change moves where years start,
asks again about *Day numbers*. *Undo the last calendar change* (Settings → Calendar) puts the
previous calendar back.

Your weather, pins and the current day are stored as **day numbers**. A definition decides which
date each day number is. Day numbers appear in the text as `D` followed by the number: `D0`,
`D1500`, `D-365`.

## How do I…

| To … | Read |
| --- | --- |
| give a year named months of any length | [Step 1](#1-a-year-and-its-months), [Units](#units) |
| add a leap day (every fourth year, or a table such as 7 years in 19) | [Step 2](#2-a-leap-rule), [Gears](#gears-leap-rules) |
| make a week of my own length, with my own day names | [Step 3](#3-a-week) |
| add a moon, and name its phases | [Step 4](#4-a-moon-and-a-month-that-follows-it), [Bodies and moons](#bodies-and-moons) |
| make months or years follow a moon (a lunar calendar) | [Step 4](#4-a-moon-and-a-month-that-follows-it), [Crossings](#crossings) |
| start seasons on a date, a day of the year or a fraction of the year | [Step 5](#5-seasons), [Seasons](#seasons) |
| put a festival on a fixed date | [Step 6](#6-festivals), [Rules](#rules) |
| put a festival on the day after another one | [Step 6](#6-festivals) (Ashmorn), [Rules](#rules) (`SHIFT`) |
| put a festival on the first full moon after a day, as Easter does | [Step 6](#6-festivals) (the Harvest Moon), [Rules](#rules) (`FIRST`) |
| name one day that happened once | [Step 7](#7-exceptions), [Exceptions](#exceptions) (`RDATE`) |
| cancel one year's feast | [Step 7](#7-exceptions), [Exceptions](#exceptions) |
| add festival days that belong to no month or week | [Units](#units) (filler slots) |
| move one year's start, or change the rules from a year on (a reform) | [Exceptions](#exceptions) |
| start a year a day late when it would fall on a given weekday | [Stages](#stages) |
| choose how dates are written and typed | [Step 8](#8-how-dates-are-written), [Formats](#formats) |
| make the weather react to a season or a festival | [Calendar tags in the weather](#calendar-tags-in-the-weather) |
| understand why Save refused my text | [When Save refuses your text](#when-save-refuses-your-text), [Messages](#messages) |

## Guide: building the Calendar of the Vale

This guide builds one made-up calendar in eight steps. By the end it has a numbered year with named
months, a leap rule, a six-day week, a moon with a month that follows it, four seasons, three
festivals, two one-off exceptions and three date formats. Each step shows the blocks it adds or
changes; the last section shows the whole calendar. You can paste the whole calendar into *Change
calendar…* (*Paste a definition (Seshat text)*) to try it.

### 1. A year and its months

Start with the backbone: a year that numbers itself, and the months that divide it.

```seshat
BEGIN:VCALENDAR
SESHAT:1
NAME:Calendar of the Vale

BEGIN:VUNIT
UID:year
NUMBER:1
ANCHOR:D0
LENGTH:365
END:VUNIT

BEGIN:VUNIT
UID:month
IN:year
SLOT:Thaw=30
SLOT:Seedfall=30
SLOT:Greening=30
SLOT:Bloom=30
SLOT:Highsun=30
SLOT:Haymonth=30
SLOT:Reaping=30
SLOT:Leaffall=30
SLOT:Mists=30
SLOT:Frost=30
SLOT:Deepcold=30
SLOT:Longnight=30
SLOT:Yearsend=5
END:VUNIT

END:VCALENDAR
```

Every definition starts with `BEGIN:VCALENDAR` and `SESHAT:1`, has a `NAME`, and ends with
`END:VCALENDAR`. Each line is a `KEY:value` pair; keys are upper case.

A calendar is made of **units**. The first one here is a **cycle unit**: `year` repeats for ever,
each occurrence `LENGTH` days long, and the occurrence counted as 0 starts on day `D0` (`ANCHOR`).
`NUMBER:1` says that occurrence 0 is *year 1*; without it, the first year would be year 0. A world
calendar must have a cycle unit with the id `year`.

The second is a **slot unit**: `month` divides each `year` (`IN:year`) into slots, in order. Each
`SLOT` line is a name and a length in days. The slots must add up to the year exactly: twelve
months of 30 days and *Yearsend* of 5 make 365.

`UID` gives each unit an id. Ids are lower case letters, digits and hyphens, starting with a
letter. Names (*Thaw*, *Calendar of the Vale*) can be any text, with six characters escaped
(step 6).

That is a working calendar already; every step after this one builds on it.

### 2. A leap rule

Add a leap year: every fourth year, *Yearsend* gains a day.

```seshat
BEGIN:VGEAR
UID:leap
RRULE:FREQ=year;INTERVAL=4;OFFSET=3
END:VGEAR

BEGIN:VUNIT
UID:year
NUMBER:1
ANCHOR:D0
LENGTH:365
GEAR:leap*1
END:VUNIT

BEGIN:VUNIT
UID:month
IN:year
SLOT:Thaw=30
SLOT:Seedfall=30
SLOT:Greening=30
SLOT:Bloom=30
SLOT:Highsun=30
SLOT:Haymonth=30
SLOT:Reaping=30
SLOT:Leaffall=30
SLOT:Mists=30
SLOT:Frost=30
SLOT:Deepcold=30
SLOT:Longnight=30
BEGIN:VSLOT
NAME:Yearsend
LENGTH:SLACK
END:VSLOT
END:VUNIT
```

A **gear** (`VGEAR`) picks out some occurrences of a cycle unit. `RRULE:FREQ=year;INTERVAL=4;OFFSET=3`
picks every fourth year. `OFFSET` counts occurrences, not year numbers: the first year is
occurrence 0, so `OFFSET=3` picks occurrences 3, 7, 11 and so on, which are years 4, 8 and 12.

`GEAR:leap*1` on the year adds one day to every year the gear picks, so years 4, 8, 12 … have
366 days.

The extra day has to go somewhere in the months. *Yearsend* is now written as a block (`VSLOT`)
with `LENGTH:SLACK`: a slack slot takes whatever the other slots leave. It has 5 days in a common
year and 6 in a leap year, so 6 Yearsend 4 is the leap day (day 1460).

### 3. A week

Add a six-day week with named days, so dates can name a weekday and rules can match one.

```seshat
BEGIN:VUNIT
UID:week
ANCHOR:D0
LENGTH:6
END:VUNIT

BEGIN:VUNIT
UID:weekday
ANCHOR:D0
LENGTH:1
LABEL:Moonday
LABEL:Ironday
LABEL:Wellday
LABEL:Thornday
LABEL:Fireday
LABEL:Restday
END:VUNIT
```

The Vale has a six-day week. The day names sit on `weekday`, a cycle unit one day long: `LABEL`
lines name its occurrences in turn, so day 0 is a Moonday, day 1 an Ironday, and day 6 a Moonday
again. Labels name occurrences of their own unit, which is why they go on a one-day cycle and not
on the six-day `week` (labels there would name whole weeks).

`week` itself is a six-day cycle that starts with the first day name. Rules and dates can count
weeks with it, and the Studio's **Week** tab shows a week as fields when both units are there.

### 4. A moon, and a month that follows it

Add a moon with named phases, and a month that starts at each new moon.

```seshat
BEGIN:VBODY
UID:moon
PERIOD:59/2
EPOCH:0
MOON:Lantern
PHASE:New=0
PHASE:Waxing=0.05
PHASE:Full=0.45
PHASE:Waning=0.55
END:VBODY

BEGIN:VUNIT
UID:lunar-month
CROSSING:BODY=moon;MARK=0
END:VUNIT
```

A **body** (`VBODY`) is a clock that turns once every `PERIOD` days. The period is an exact
fraction: `59/2` is 29.5 days. `EPOCH` is the body's phase on day 0, as a fraction of a turn (0 is
a new moon here, `1/2` would be full). `MOON:Lantern` makes the body one of the world's moons, under
that name: zone moon conditions match it by this name. `PHASE` lines name points of the turn. A
named phase lasts from its point to the next one, so *Full* covers phases 0.45 up to 0.55, about
three days of each turn.

`lunar-month` is a cycle unit with no fixed length. `CROSSING:BODY=moon;MARK=0` starts a new
occurrence each time the moon passes phase 0 — at every new moon. An occurrence starts on
the day that holds the new moon; add `;START=after` to start on the first day that begins at or
after it instead. With a 29.5-day moon the lunar months here start on days 0, 29, 59, 88, 118 and
so on: 29 and 30 days in turn.

A year can follow a moon in the same way, for a lunar calendar.

### 5. Seasons

Mark where each season starts; every day then carries its season as a tag that zones and rules can
test.

```seshat
BEGIN:VSEASONS
UNIT:year
MARK:Winter=0
MARK:Spring=month:3.1
MARK:Summer=DAY:150
MARK:Autumn=0.7
END:VSEASONS
```

`VSEASONS` lists where each season starts in the year. A mark is one of three things:

- a **fraction** of the year: `Winter=0` starts on the first day; `Autumn=0.7` starts on the first
  day at least 70% of the way through the year, which is 17 Mists in a 365-day year and 18 Mists
  in a 366-day one;
- a **day of a month**: `Spring=month:3.1` starts on day 1 of month 3 (1 Greening), whatever the
  year's length;
- a **day of the year**: `Summer=DAY:150` starts on the 150th day (30 Highsun).

A day belongs to the last season that started on or before it. Every day carries its season as a
tag, `season:<name>` (`season:Spring`), which zones and calendar rules can test.

### 6. Festivals

Tag the festival days: a zone can match a festival's tag, and a date format can print its name.

```seshat
BEGIN:VRULE
UID:lanterns
NAME:Feast of Lanterns
TAGS:feast,lanterns
RRULE:FREQ=year;BYNTH=month:6;BYDAY=month:15
END:VRULE

BEGIN:VRULE
UID:ashmorn
NAME:Ashmorn
TAGS:ashmorn
BEGIN:SHIFT
DAYS:1
TAG:lanterns
END:SHIFT
END:VRULE

BEGIN:VRULE
UID:harvest-moon
NAME:Harvest Moon
TAGS:harvest-moon
BEGIN:FIRST
WITHIN:30
BEGIN:AFTER
BEGIN:ALL
TAG:season\:Autumn
BEGIN:NOT
BEGIN:SHIFT
DAYS:1
TAG:season\:Autumn
END:SHIFT
END:NOT
END:ALL
END:AFTER
PHASE:BODY=moon;NAME=Full
END:FIRST
END:VRULE
```

A **named rule** (`VRULE`) is a test every day passes or fails. On each day it passes, the day
carries the rule's `TAGS`, which a zone can match (`{ "tag": "feast" }`), and the rule's `NAME`,
which a date format can print (step 8).

- **The Feast of Lanterns** is the 15th of the sixth month. `RRULE:FREQ=year` looks at each year;
  `BYNTH=month:6` keeps the days in its sixth month and `BYDAY=month:15` the 15th day of that month.
  It falls on 15 Haymonth: day 164 in year 1.
- **Ashmorn** is the day after the feast. `TAG:lanterns` reads the feast's tag, and `SHIFT` with
  `DAYS:1` moves the test one day later: Ashmorn holds on a day when the feast held on the day
  before. It falls on 16 Haymonth.
- **The Harvest Moon** is the first day of a full moon on or after the first day of Autumn.
  `FIRST` finds the first day that passes its rule (`PHASE:BODY=moon;NAME=Full`) on or after a day
  that passes its `AFTER` rule, at most `WITHIN` days after it. The `AFTER` rule finds the first
  day of Autumn: a day in Autumn (`TAG:season\:Autumn`) whose day before was not (`NOT` of a
  `SHIFT`). In year 1, Autumn starts on 17 Mists and the Harvest Moon falls on 10 Frost.

The colon in `season\:Autumn` is written with a backslash. In most values the characters
`\ , ; : = #` must be escaped like this; the reference lists where.

A recurrence matches nothing before occurrence 0 of its `FREQ` unit. The Feast of Lanterns above
starts in year 1; a world whose story runs into year 0 and earlier gives the rule an earlier
`ANCHOR` (`RRULE:FREQ=year;ANCHOR=D-10000000;BYNTH=month:6;BYDAY=month:15`).

### 7. Exceptions

Handle the days the rules get wrong: a coronation that happened once, and one year the feast was
not held.

```seshat
RDATE:D1500;NAME=Coronation of Queen Ilse;TAGS=coronation

BEGIN:VRULE
UID:lanterns
NAME:Feast of Lanterns
TAGS:feast,lanterns
BEGIN:ALL
RRULE:FREQ=year;BYNTH=month:6;BYDAY=month:15
BEGIN:NOT
DATES:D894
END:NOT
END:ALL
END:VRULE
```

Some days follow no rule. `RDATE` names one day, by its day number, with a name and tags: day 1500
is 10 Seedfall 5, the day of a coronation.

In year 3 the feast was not held. The feast's rule becomes `ALL` of two tests: the old recurrence,
and `NOT` the day 894 (`DATES:D894`, 15 Haymonth 3). Ashmorn reads the feast's tag, so it does not
happen in year 3 either.

These are the shapes the Studio's **Exceptions** tab writes when you name a single day or cancel
one day of a named rule. It also moves one year's first day, sets one year's month lengths, and
changes a unit's rule from a year onward; the reference shows those lines.

### 8. How dates are written

Decide how dates are written, and how you type them.

```seshat
FORMAT:default={month\:day} {month\:name} {year}
FORMAT:long={weekday\:name}\, {month\:day} {month\:name} {year}\, day {lunar-month\:day} of the moon
FORMAT:almanac={month\:day} {month\:name} {year}\: {@season}\, {@phase\:moon}\, {@name}
```

A `FORMAT` line is a name, `=`, and a pattern. Words in braces are tokens: `{year}` is the year's
number, `{month:name}` the month's name, `{month:day}` the day of the month, `{weekday:name}` the
day's name, `{lunar-month:day}` the day of the lunar month. Tokens starting with `@` are
placeholders: `{@season}`, `{@phase:moon}` (the moon's named phase) and `{@name}` (the names of
the day's `RDATE` and of the rules that hold on it).

In a `FORMAT` line the colons and commas are escaped (`\:`, `\,`), the same as in any other value.

| Format | Day 164 |
| --- | --- |
| `default` | 15 Haymonth 1 |
| `long` | Wellday, 15 Haymonth 1, day 18 of the moon |
| `almanac` | 15 Haymonth 1: Summer, Waning, Feast of Lanterns |

The format named `default` is how the plugin writes dates, and how you type them: in *Current
day*, *Today is* and the Exceptions tab, "15 Haymonth 1" is day 164. The default cannot hold a
placeholder, so that every date it writes can be typed back. Other formats can be chosen in
*Settings → Calendar → Date display*, or by a weather block's `format:` line.

A placeholder with nothing to print is empty, and the text around it stays: on a day with no
festival the almanac reads "1 Thaw 5: Winter, Full, ".

### The whole calendar

```seshat
BEGIN:VCALENDAR
SESHAT:1
NAME:Calendar of the Vale
FORMAT:default={month\:day} {month\:name} {year}
FORMAT:long={weekday\:name}\, {month\:day} {month\:name} {year}\, day {lunar-month\:day} of the moon
FORMAT:almanac={month\:day} {month\:name} {year}\: {@season}\, {@phase\:moon}\, {@name}
RDATE:D1500;NAME=Coronation of Queen Ilse;TAGS=coronation

BEGIN:VSEASONS
UNIT:year
MARK:Winter=0
MARK:Spring=month:3.1
MARK:Summer=DAY:150
MARK:Autumn=0.7
END:VSEASONS

BEGIN:VBODY
UID:moon
PERIOD:59/2
EPOCH:0
MOON:Lantern
PHASE:New=0
PHASE:Waxing=0.05
PHASE:Full=0.45
PHASE:Waning=0.55
END:VBODY

BEGIN:VGEAR
UID:leap
RRULE:FREQ=year;INTERVAL=4;OFFSET=3
END:VGEAR

BEGIN:VUNIT
UID:year
NUMBER:1
ANCHOR:D0
LENGTH:365
GEAR:leap*1
END:VUNIT

BEGIN:VUNIT
UID:month
IN:year
SLOT:Thaw=30
SLOT:Seedfall=30
SLOT:Greening=30
SLOT:Bloom=30
SLOT:Highsun=30
SLOT:Haymonth=30
SLOT:Reaping=30
SLOT:Leaffall=30
SLOT:Mists=30
SLOT:Frost=30
SLOT:Deepcold=30
SLOT:Longnight=30
BEGIN:VSLOT
NAME:Yearsend
LENGTH:SLACK
END:VSLOT
END:VUNIT

BEGIN:VUNIT
UID:week
ANCHOR:D0
LENGTH:6
END:VUNIT

BEGIN:VUNIT
UID:weekday
ANCHOR:D0
LENGTH:1
LABEL:Moonday
LABEL:Ironday
LABEL:Wellday
LABEL:Thornday
LABEL:Fireday
LABEL:Restday
END:VUNIT

BEGIN:VUNIT
UID:lunar-month
CROSSING:BODY=moon;MARK=0
END:VUNIT

BEGIN:VRULE
UID:lanterns
NAME:Feast of Lanterns
TAGS:feast,lanterns
BEGIN:ALL
RRULE:FREQ=year;BYNTH=month:6;BYDAY=month:15
BEGIN:NOT
DATES:D894
END:NOT
END:ALL
END:VRULE

BEGIN:VRULE
UID:ashmorn
NAME:Ashmorn
TAGS:ashmorn
BEGIN:SHIFT
DAYS:1
TAG:lanterns
END:SHIFT
END:VRULE

BEGIN:VRULE
UID:harvest-moon
NAME:Harvest Moon
TAGS:harvest-moon
BEGIN:FIRST
WITHIN:30
BEGIN:AFTER
BEGIN:ALL
TAG:season\:Autumn
BEGIN:NOT
BEGIN:SHIFT
DAYS:1
TAG:season\:Autumn
END:SHIFT
END:NOT
END:ALL
END:AFTER
PHASE:BODY=moon;NAME=Full
END:FIRST
END:VRULE

END:VCALENDAR
```

The real-world calendars offered by *Change calendar…* are complete definitions too. Switch a test
world to one and open *Edit definition* to read it.

## Calendar tags in the weather

Festivals and seasons reach the weather as tags. A zone modifier's `when` can test any tag the calendar gives a day with `{ "tag": "<tag>" }`: the season as `season:Autumn`, and
the `TAGS` of named rules, slots, labels and `RDATE` lines as written (`{ "tag": "feast" }`). The
match is the exact text, capitals included; a rule's `NAME` is not a tag. In a zone set to flip its
seasons, `season:` reads the season half a year away. See [Modifiers](../README.md#modifiers) and
[Eras](../README.md#eras) in the README.

## When Save refuses your text

Save checks the whole text and shows the first problem it finds; nothing is saved until it is
fixed. A problem in the text itself starts with its line number. These are the commonest:

| Mistake | What Save says |
| --- | --- |
| A line is indented, or its key is in lower case | `Line 12: expected KEY:VALUE, got "  UID:x"` |
| A colon or comma in a name, tag or format is not escaped | `Line 13: "," must be escaped as "\,"` (write `\,`, `\:`) |
| A key is misspelled | `Line 7: VUNIT has no property LENTH` |
| A block is not closed | `Line 8: END:VCALENDAR closes BEGIN:VUNIT` |
| An id has capitals or spaces | `Line 5: "Year" is not an id ([a-z][a-z0-9-]*)` |
| A space after a number | `Line 7: "365 " is not a number` |
| A moon's period is written as a decimal | `Line 13: "29.5" is not a rational (n or n/d)` (write `59/2`) |
| A line is left empty | `Line 13: an empty value is written \0` |
| Two blocks share an id | `id "year" is declared more than once` |
| The year unit has another id | `a world calendar needs a cycle unit with the id "year"` |
| The months do not add up to the year | `unit "month": slots total 364 days but its parent occurrence is 365 (always)` |
| A leap rule adds a day the months have no room for | `unit "month": slots total 365 days but its parent occurrence is 366 (leap=1)` (make one month `LENGTH:SLACK`, as in [step 2](#2-a-leap-rule)) |
| An iCalendar rule is pasted in | `Line 14: RRULE has no parameter BYMONTH`, or `rule "x" freq: no unit "yearly"` |
| A rule names a phase the moon does not have | `rule "x": names phase "Full" of body "moon", which has no such phase (its phases: "New")` |
| A rule holds two tests side by side | `Line 11: a VRULE holds exactly one rule` (wrap them in `ALL` or `ANY`) |
| The default format holds `{@season}`, `{@phase:…}` or `{@name}` | `format "default": a placeholder (…) cannot be in the default format, which must stay one a date can be typed in; put it in another format` |

The numbers and names in these messages are your own. [Messages](#messages) lists the rest.

## Reference

Every line and block of the language, then its limits and its messages.

### The text

| Rule | Detail |
| --- | --- |
| Lines | One `KEY:value` per line. The key is upper case letters and hyphens, at the very start of the line: no indentation. |
| Blank lines | Ignored. |
| Comments | A line starting with `#` in its first column. Comments are removed when the definition is saved. |
| Blocks | `BEGIN:<TYPE>` … `END:<TYPE>`, nested as each block allows. Blocks and lines may come in any order, except where the order is the meaning: slots, labels, exceptions and the rules inside `ALL` and `ANY`. Saving puts the rest in a fixed order. |
| Values | Taken exactly as written: nothing is trimmed, so a trailing space is part of the value (and makes a number unreadable). |
| Empty value | Written `\0`. A raw empty value is refused, except on marker lines (below). |
| Parameters | Some values are `KEY=value` pairs separated by `;` (`RRULE:FREQ=year;INTERVAL=4`). Some start with one plain value before the pairs (`RDATE:D1500;NAME=…`). Each parameter appears once unless the table says it may repeat. |
| Lists | Comma-separated: `TAGS:feast,lanterns`, `AT=0,3,6`. |
| Ids | `[a-z][a-z0-9-]*`: a lower case letter, then lower case letters, digits and hyphens. Units, gears, bodies and rules share one set of ids, so no two may have the same id. |
| Numbers | Decimal, with an optional sign, fraction and exponent: `365`, `-1`, `0.45`. Most numbers must be whole; the tables say which. |
| Fractions | `n` or `n/d` in lowest terms with `d` above 1: `59/2`, `36524219/100000`. Used for periods, epochs and crossing instants. A decimal is not accepted there. |
| Day numbers | `D<n>`: `D0`, `D-719528`. A crossing instant may add a fraction of a day: `D-45942+266419/300000`. |
| Line endings | LF or CRLF; a leading byte-order mark is ignored. |

**Escaping.** Six characters have a meaning in values: `\` `,` `;` `:` `=` `#`. In names, tags,
patterns and other text values, each of them must be written with a backslash before it (`\,`,
`\:`, `\#`), a newline as `\n` and a carriage return as `\r`. A raw one is refused. This applies to
`NAME`, `TAGS`, `TAG`, `SLOT` names, `LABEL`, `MOON`, `PHASE` names, `MARK` names, `FORMAT` names
and patterns, and the text parts of `RDATE` and `BYLABEL`. It does **not** apply inside the
structured part of a season mark: write `MARK:Spring=month:3.1` and `MARK:Summer=DAY:150` with
plain colons.

**Markers.** `BODIES:`, `DAYS:`, `RULES:`, `FORMATS:`, `MARKS:`, `PHASES:`, `LABELS:`, `LEDGER:`,
`GEARS:`, `STAGES:` (and `BY=` inside an `RRULE`) stand alone with no value and mean "an empty
list". Saving writes them only to keep an empty list that was stored empty; you never need one.
A marker cannot be combined with items of the same list.

### The calendar

`BEGIN:VCALENDAR` … `END:VCALENDAR`. Nothing may follow `END:VCALENDAR`.

| Line or block | Value | Notes |
| --- | --- | --- |
| `SESHAT` | `1` | Required. The language version. |
| `NAME` | text | Required. The calendar's name, as settings and the Studio show it. No control characters (a tab, or `\n`). |
| `FORMAT` | `<name>=<pattern>` | Any number. See [Formats](#formats). |
| `RDATE` | `D<n>[;NAME=<text>][;TAGS=<list>]` | A named or tagged day. See [Exceptions](#exceptions). |
| `VSEASONS` | block | At most one. See [Seasons](#seasons). |
| `VBODY` | block | Any number. See [Bodies and moons](#bodies-and-moons). |
| `VGEAR` | block | Any number. See [Gears](#gears-leap-rules). |
| `VUNIT` | block | Any number. See [Units](#units). |
| `VRULE` | block | Any number. See [Rules](#rules). |

### Units

A unit is a sequence of occurrences on the day line. A **cycle unit** repeats for ever and counts
its occurrences: 0, then 1, 2, … forwards and −1, −2, … backwards. Which one is occurrence 0
depends on how the unit says where its occurrences start (its `ANCHOR` and `LENGTH`, or its
`CROSSING`; some messages call this the unit's **base**):

- with `ANCHOR` and `LENGTH`, occurrence 0 is the one that starts on the `ANCHOR` day;
- with `CROSSING:<period>@<instant>`, it is the one that starts at `<instant>`;
- with `CROSSING:BODY=…`, it is the one that starts when the body reaches `MARK` during the turn
  that holds day 0 (a turn runs from phase 0 to the next phase 0), so it can start a little before
  day 0. `K` moves it that many turns later.

A **slot unit** divides each occurrence
of a parent unit into named slots and starts again with every parent. A `VUNIT` with an `IN` line
is a slot unit; one without is a cycle unit.

**A cycle unit** (`VUNIT` without `IN`):

| Line or block | Value | Notes |
| --- | --- | --- |
| `UID` | id | Required. |
| `NUMBER` | whole number | The number dates print for occurrence 0. Default 0. Within ±2^40. |
| `ANCHOR` | `D<n>` | With `LENGTH`: occurrence 0 starts on this day. Within ±10,000,000. |
| `LENGTH` | whole number | With `ANCHOR`: days in each occurrence, before gear terms. |
| `CROSSING` | see [Crossings](#crossings) | Instead of `ANCHOR` and `LENGTH`: occurrences start at a body's or a fixed clock's crossings. |
| `GEAR` | `<gear id>*<days>` | Any number. Adds `<days>` (may be negative) to each occurrence the gear picks. The gear must read this unit. |
| `VSTAGE` | block | Any number, applied in order. See [Stages](#stages). |
| `LABEL` | text | Any number. Names occurrences in turn: occurrence *k* carries label *k* mod the number of labels, so occurrence 0 carries the first. |
| `VLABEL` | block: `NAME`, `TAGS` | A label with tags (or tags alone). Each day of an occurrence carrying it has its tags. |
| `STARTS`, `SLOTS`, `VSWITCH` | see [Exceptions](#exceptions) | The unit's one-off corrections. |

Each occurrence must be at least one day long, however the gears and stages combine.

**A slot unit** (`VUNIT` with `IN`):

| Line or block | Value | Notes |
| --- | --- | --- |
| `UID` | id | Required. |
| `IN` | unit id | Required. The parent: a cycle unit, or another slot unit (a week of ten days inside a month). |
| `NUMBER` | whole number | The number dates print for the first slot. Default 1. |
| `SLOT` | `<name>=<days>` | A slot with a fixed length. |
| `VSLOT` | block | A slot with more settings (below). |

`SLOT` lines and `VSLOT` blocks may be mixed; their order is the slots' order. In every occurrence
of the parent, the slots must add up to the parent's length exactly. A slot may be 0 days long: it
is then absent that time, but keeps its place and number.

**A slot block** (`VSLOT`):

| Line | Value | Notes |
| --- | --- | --- |
| `NAME` | text | Optional. Dates print it with `{<unit>:name}`. |
| `TAGS` | list | Every day in the slot carries them. |
| `LENGTH` | `<days>`, `SLACK` or `KEYED` | Required. Parameters below. |
| `GEAR` | `<gear id>*<days>` | Any number, on a fixed length only. The gear must read the cycle unit at the top of this slot unit's parents. |
| `FILLER` | `TRUE` or `FALSE` | A filler slot belongs to its parent but has no children: a slot unit inside this one skips it (a festival day that is in no week). |

| `LENGTH` form | Parameters | Meaning |
| --- | --- | --- |
| `<days>` | none | A fixed length, 0 or more. |
| `SLACK` | `MIN=<days>`, `MAX=<days>`, `FILL=<n>` | Takes what the fixed slots leave. With several slack slots, each gets its `MIN` (default 0), then the remaining days are handed out in `FILL` order (lowest first; slots without `FILL` last, ties in slot order), each up to its `MAX` (default no limit). |
| `KEYED` | `TABLE=<parent days>:<days>,…` | The length depends on the parent's length: `TABLE=355:28,377:23` is 28 days in a 355-day year and 23 in a 377-day one. Every parent length that occurs needs a row. |

```seshat
BEGIN:VCALENDAR
SESHAT:1
NAME:Slot forms

BEGIN:VGEAR
UID:leap
RRULE:FREQ=year;INTERVAL=4;OFFSET=3
END:VGEAR

BEGIN:VUNIT
UID:year
NUMBER:1
ANCHOR:D0
LENGTH:364
GEAR:leap*1
END:VUNIT

BEGIN:VUNIT
UID:month
IN:year
SLOT:First Month=91
BEGIN:VSLOT
NAME:Midyear
TAGS:festival
LENGTH:0
GEAR:leap*1
FILLER:TRUE
END:VSLOT
SLOT:Second Month=91
SLOT:Third Month=91
SLOT:Fourth Month=91
END:VUNIT

BEGIN:VUNIT
UID:part
IN:month
SLOT:Early=30
SLOT:Middle=30
BEGIN:VSLOT
NAME:Late
LENGTH:SLACK;MIN=30;MAX=31
END:VSLOT
END:VUNIT

END:VCALENDAR
```

Here *Midyear* is 0 days long, plus one in each leap year (a gear term on the slot itself), and
tagged `festival`. It is a filler, so the `part` unit inside the months skips it: on Midyear the
day has a month (*Midyear*) but no part.

### Gears (leap rules)

A gear picks out occurrences of one cycle unit by their count. A `GEAR` line on a unit or slot
then adds days to the occurrences it picks. One gear can serve several units.

| Line | Value | Notes |
| --- | --- | --- |
| `UID` | id | Required. |
| `RRULE` | `FREQ=<unit>;INTERVAL=<n>[;OFFSET=<n>]` | Picks every `INTERVAL`-th occurrence, counting from `OFFSET`. |
| `EXRULE` | same | Takes those occurrences back out. |
| `POSITIONS` | `ON=<unit>;PERIOD=<n>;AT=<list>[;OFFSET=<n>]` | Picks the listed positions (0 to `PERIOD` − 1) in every run of `PERIOD` occurrences: a table, such as 7 leap years in 19. |

A gear has either `RRULE`/`EXRULE` lines, all with the same `FREQ`, or one `POSITIONS` line.
A gear written with only an `ON:<unit>` line, and no `RRULE`, `EXRULE` or `POSITIONS`, is read,
but it picks nothing and Save refuses it with `gear "<id>": no intervals`.

The count is the occurrence number, not the number dates print: with `NUMBER:1`, year 4 is
occurrence 3. An occurrence *n* is picked by `RRULE:…;INTERVAL=i;OFFSET=o` when *n* − *o* is a
multiple of *i*; by `POSITIONS` when (*n* − `OFFSET`) mod `PERIOD` is listed. `RRULE` and `EXRULE`
lines must nest, so that every occurrence is counted once or not at all (the Gregorian pattern:
every 4, except every 100, except every 400).

```seshat
BEGIN:VGEAR
UID:leap
RRULE:FREQ=year;INTERVAL=4;OFFSET=3
EXRULE:FREQ=year;INTERVAL=100;OFFSET=99
RRULE:FREQ=year;INTERVAL=400;OFFSET=399
END:VGEAR
```

```seshat
BEGIN:VGEAR
UID:leap
POSITIONS:ON=year;PERIOD=19;AT=2,5,7,10,13,16,18
END:VGEAR
```

### Bodies and moons

| Line | Value | Notes |
| --- | --- | --- |
| `UID` | id | Required. |
| `PERIOD` | fraction | Required. Days per turn, as `n` or `n/d` (29.53 days is `2953/100`). Positive. |
| `EPOCH` | fraction | Required. The phase on day 0, as a fraction of a turn: `0`, `1/4`. |
| `MOON` | text | Makes the body one of the world's moons, under this name. Two moons cannot share a name. |
| `PHASE` | `<name>=<number>` | Any number, on a moon only. A named point of the turn, from 0 up to (not including) 1. |

A body's phase on a day is the fraction of a turn it has made: (day ÷ `PERIOD` + `EPOCH`), without
its whole turns. A body without `MOON` is not a moon of the world: units and rules can still follow
it.

A **named phase** lasts from its point to the next point of the same moon, the last wrapping round
to the first; a moon with a single phase is in it all the time. Dates print the current one with
`{@phase:<body id>}`, and a rule tests it with `PHASE:BODY=<body id>;NAME=<name>`. Phase names do
not change the weather; moon names do (zone moon conditions match by name).

### Crossings

`CROSSING` replaces `ANCHOR` and `LENGTH` on a cycle unit (or in a `VSWITCH`). Its occurrences
start at a clock's crossings instead of at fixed intervals.

| Form | Meaning |
| --- | --- |
| `CROSSING:BODY=<body id>;MARK=<phase>` | A crossing each time the body passes phase `MARK` (a decimal or fraction, from 0 up to 1). The body's period must be at least one day. |
| `CROSSING:<period>@<instant>` | A crossing every `<period>` days (a fraction), crossing 0 at `<instant>`, a day number with an optional fraction of a day (`D0`, `D-45942+266419/300000`). |

| Parameter | Value | Meaning |
| --- | --- | --- |
| `START` | `contains` or `after` | `contains` (the default): an occurrence starts on the day that holds the crossing. `after`: on the first day that begins at or after it. |
| `OFFSET` | fraction | `BODY` form only. Moves every crossing by this many days, which may be negative or less than one (for a day that starts at sunset rather than at midnight). |
| `K` | whole number | `BODY` form only. Renumbers the occurrences: occurrence 0 is the crossing `K` turns later. |
| `INDEX` | `<a>/<c>/<L>` | Reads crossing number ⌊(*k*·*a* + *c*) ÷ *L*⌋ for occurrence *k*: a year that starts at every twelfth-or-thirteenth new moon, as the Hebrew calendar does. |

```seshat
BEGIN:VBODY
UID:sun
PERIOD:36524219/100000
EPOCH:0
END:VBODY

BEGIN:VUNIT
UID:solar-year
CROSSING:BODY=sun;MARK=0;START=after
END:VUNIT
```

### Stages

A stage moves occurrence starts by whole days after the base and the gear terms, as calendar
postponement rules do. Each `VSTAGE` holds one or more rules; the first rule that matches an
occurrence's start moves it, and a stage reads only the starts the stage before it produced.

| Line | Parameters | Meaning |
| --- | --- | --- |
| `RESIDUE:<mod>` | `IN=<list>`, `ADD=<days>`, `OFFSET=<n>` | Moves the start by `ADD` days when (start − `OFFSET`) mod `<mod>` is in the list: "if the year would start on a Wednesday, start it a day later". |
| `LENGTH` | `AT=<n>`, `IS=<days>`, `ADD=<days>` | Moves the start by `ADD` days when occurrence *k* + `AT` (as the stage below has it) is `IS` days long. `AT` is within ±8. |

```seshat
BEGIN:VUNIT
UID:year
NUMBER:1
ANCHOR:D0
LENGTH:365
GEAR:leap*1
BEGIN:VSTAGE
RESIDUE:6;IN=5;ADD=1
END:VSTAGE
END:VUNIT
```

In the Vale, day 0 is a Moonday and the week has six days, so a day number that leaves 5 when
divided by 6 is a Restday. This stage starts a year one day later when it would start on a
Restday; the slack *Yearsend* of the year before takes the extra day.

### Seasons

`BEGIN:VSEASONS` … `END:VSEASONS`, at most one per calendar.

| Line | Value | Notes |
| --- | --- | --- |
| `UNIT` | unit id | Required. A cycle unit; on a world calendar, `year`. |
| `MARK` | `<name>=<fraction>` | Starts on the first day whose position in the year (days since the year began ÷ the year's length) is at least the fraction, from 0 up to 1. |
| `MARK` | `<name>=DAY:<n>` | Starts on day *n* of the year, from 1. Skipped in a year with fewer days. |
| `MARK` | `<name>=<slot unit>:<slot>.<day>` | Starts on day `<day>` (from 1) of slot `<slot>`, numbered as dates print it (so `month:3.1` is the third month with the default numbering). The slot unit must sit directly in the seasons unit, and the slot may not be a filler. A day past the slot's end is its last day; in a year where the slot has no days, the mark is skipped. |

A day is in the last season that started on or before it in its year; before the first mark of a
year, it is still in the last season of the year before. Each day carries the tag
`season:<name>`. A zone set to flip its seasons flips its own season tag; calendar rules always
read the calendar's own seasons.

### Exceptions

One-off corrections. `RDATE` is a line of the calendar; the others are lines and blocks of a cycle
unit. `FROM` is an occurrence number, counted as in [Gears](#gears-leap-rules) (with `NUMBER:1`,
year 5 is `FROM=4`).

| Line or block | Value | Meaning |
| --- | --- | --- |
| `RDATE` | `D<n>[;NAME=<text>][;TAGS=<list>]` | Day *n* carries this name (printed by `{@name}`) and these tags. |
| `STARTS` | `FROM=<k>;ON=D<n>[;LENGTHS=<list>]` | Occurrence *k* starts on day *n*. Each length in `LENGTHS` pins one more start: occurrence *k* + 1 starts that many days later, and so on. |
| `SLOTS` | `FROM=<k>;UNIT=<slot unit>;LENGTHS=<list>[;PATH=<list>]` | In occurrence *k*, the slot unit's slots have exactly these lengths (one per slot; they must fill the parent). `PATH` names the slot of each slot unit in between, for a unit nested deeper (from 0). |
| `VSWITCH` | block: `FROM:<k>`, then `ANCHOR`+`LENGTH` or `CROSSING`, and optional `GEAR` and `VSTAGE` | From occurrence *k* on (until the next switch) the unit follows this rule instead: a calendar reform. Switches come in increasing order of `FROM`. |

To cancel one day of a named rule, wrap its rule as `ALL` of the rule and `NOT` a `DATES` list, as
in the guide.

```seshat
BEGIN:VUNIT
UID:year
NUMBER:1
ANCHOR:D0
LENGTH:365
GEAR:leap*1
STARTS:FROM=9;ON=D3289
SLOTS:FROM=4;UNIT=month;LENGTHS=31,29,30,30,30,30,30,30,30,30,30,30,5
BEGIN:VSWITCH
FROM:20
ANCHOR:D5
LENGTH:365
END:VSWITCH
END:VUNIT
```

Here year 10 starts on day 3289, two days late: year 9 is two days longer (367 days) and year 10
two days shorter (363), and their *Yearsend* slots take the difference. In year 5 the first two
months are 31 and 29 days. From year 21 on, the leap rule stops: the switch's rule is written as
if it had always run, so its `ANCHOR` is where its occurrence 0 would have started (day 5 puts
occurrence 20 on day 7305, where year 21 starts anyway).

### Rules

`BEGIN:VRULE` … `END:VRULE`. Every day the rule holds carries its tags.

| Line | Value | Notes |
| --- | --- | --- |
| `UID` | id | Required. |
| `NAME` | text | What `{@name}` prints on a day the rule holds. Does not change the weather. |
| `TAGS` | list | What the day carries. A rule without tags sets nothing (its `NAME` can still be printed). |
| one rule | a line or block below | Required: exactly one. |

**Rule lines and blocks.** Blocks hold the rules they combine.

| Form | Holds on a day when … |
| --- | --- |
| `RRULE:<parameters>` | the day passes the recurrence (next table). |
| `TAG:<tag>` | the day carries the tag (see "Which tags a rule reads" below). |
| `DATES:D<n>,D<n>,…` | the day is one of these day numbers. |
| `PHASE:BODY=<body>;NAME=<phase>` | the body is in its named phase. |
| `PHASE:BODY=<body>;FROM=<x>;TO=<y>` | the body's phase is from `x` up to (not including) `y`. When `x` is greater than `y` the range wraps past 0; when they are equal, nothing matches. |
| `PHASE:UNIT=<unit>;FROM=<x>;TO=<y>` | the day's position in its occurrence of the unit (days since it began ÷ its length) is in that range, as above. |
| `DAYIN:UNIT=<unit>;FROM=<a>;TO=<b>` | the day is between the `a`-th and `b`-th day of its occurrence of the unit, both included, **counting from 0** (the first day is 0). |
| `INDEX:UNIT=<unit>[;FROM=<a>][;TO=<b>]` | the occurrence number of the cycle unit holding the day is between `a` and `b`, both included (a missing bound is open). The occurrence number, not the printed year: with `NUMBER:1`, year 1 is 0. `UNIT=day` reads the day number. |
| `BEGIN:ALL` … `END:ALL` | every rule inside holds. |
| `BEGIN:ANY` … `END:ANY` | at least one rule inside holds. |
| `BEGIN:NOT` … `END:NOT` | the one rule inside does not hold. |
| `BEGIN:SHIFT` `DAYS:<n>` … `END:SHIFT` | the one rule inside held `n` days earlier. `DAYS:1` is "the day after"; `DAYS:-1` is "the day before". |
| `BEGIN:FIRST` `WITHIN:<n>` `BEGIN:AFTER` … `END:AFTER` … `END:FIRST` | the day is the first that passes the rule inside, on or after a day that passes the `AFTER` rule, at most `n` days after it. |

**`RRULE` parameters** (inside a `VRULE`; a gear's `RRULE` is different, see [Gears](#gears-leap-rules)):

| Parameter | Value | Meaning |
| --- | --- | --- |
| `FREQ` | unit id or `day` | Required. The period: each occurrence of this unit, or each day. |
| `INTERVAL` | whole number ≥ 1 | Every *n*-th period from the anchor's. Above 1 only for a cycle unit or `day`. |
| `ANCHOR` | `D<n>` | The period holding this day counts first. Default: occurrence 0 of a cycle unit, or day 0 for `day`. **Nothing matches before the anchor's period.** |
| `BYNTH` | `<unit>:<list>` | The day's occurrence of the unit is the *n*-th of those that start in the period (−1 is the last). For a slot unit directly inside `FREQ`, its declared slot number counts, even for a slot that has 0 days this time. May repeat. |
| `BYLABEL` | `<unit>:<list>` | The day's label in the unit (a cycle's `LABEL`, a slot's name) is one of these; `\#<tag>` matches a tag on it instead. May repeat. |
| `BYDAY` | `<unit>:<list>` | The day is the *n*-th day of its occurrence of the unit, counting from 1 (−1 is the last). May repeat. |
| `SETPOS` | list | Among the period's days that pass every `BY…` filter, only these positions (1 is the first, −1 the last). |
| `COUNT` | whole number ≥ 1 | Only the first *n* matching days from the anchor's period. |
| `UNTIL` | `D<n>` | No day after this one. |

All `BY…` filters must hold. A world calendar refuses `COUNT`, and allows `SETPOS` only when
`FREQ` is `day` or a cycle unit with a fixed length of at most 400 days and no gears, stages or
exceptions. "The third Restday of Thaw" therefore uses a range of days instead of `SETPOS`:

```seshat
BEGIN:VRULE
UID:third-restday
NAME:Thornwake
TAGS:thornwake
RRULE:FREQ=year;BYNTH=month:1;BYDAY=month:13,14,15,16,17,18;BYLABEL=weekday:Restday
END:VRULE

BEGIN:VRULE
UID:market
TAGS:market
BEGIN:ANY
RRULE:FREQ=day;ANCHOR=D-10000000;BYLABEL=weekday:Restday
RRULE:FREQ=lunar-month;ANCHOR=D-10000000;BYDAY=lunar-month:1
END:ANY
END:VRULE

BEGIN:VRULE
UID:first-week
TAGS:first-week
BEGIN:ALL
DAYIN:UNIT=year;FROM=0;TO=5
INDEX:UNIT=year;FROM=0
END:ALL
END:VRULE
```

**Which tags a rule reads.** A day's tags come from: the season (`season:<name>`), labels and
slots of every unit holding the day, `RDATE` lines, and named rules. `TAG:x` reads them like this:

- if only named rules set `x`, the rule reads those rules for that day (this is how Ashmorn
  follows the feast);
- otherwise it reads the season, labels, slots and `RDATE` lines only, and not rules that also
  set `x`.

Rules may read each other in chains, but not in a circle (a rule that reads, through others, its
own tag is refused). A calendar rule cannot read era tags, zone tags or anything from the
weather.

**Limits on world rules.** A world calendar has at most 64 named rules. A `FIRST` cannot hold
another `FIRST`. Along any path through a rule, and through the rules it reads by tag, the `SHIFT`
days and `FIRST` windows add up to at most 400 days. A `SHIFT` or `FIRST` that looks past the day
line (±10,000,000) reads nothing there.

### Formats

`FORMAT:<name>=<pattern>`. The pattern is text with tokens in braces; `{{` and `}}` are literal
braces. Escape `:`, `,`, `;`, `=`, `#` and `\` in the line as in any value.

| Token | Prints |
| --- | --- |
| `{<unit>}` | The occurrence's number: its count plus the unit's `NUMBER` (for a cycle, from 0 by default; for a slot unit, the slot's position from 1 by default). |
| `{<unit>:name}` | The label of the day's occurrence (a cycle's `LABEL`, a slot's name). |
| `{<unit>:day}` | The day within the occurrence, from 1. |
| `{<unit>:day0}` | The day within the occurrence, from 0. |
| `…:pad<N>` | Added to a number token (`{year:pad4}`, `{month:day:pad2}`): zero-pads to *N* digits, 1 to 9. A sign stays in front. |

| Placeholder | Prints |
| --- | --- |
| `{@season}` | The day's season. |
| `{@phase:<body id>}` | The body's named phase on the day. |
| `{@name}` | The day's `RDATE` name, then the `NAME` of each named rule that holds on it, joined by ", ". |

A token for a unit the day is not in (a filler day has no week) prints nothing; so does a
placeholder with nothing to say.

**Which format is used.** The format named `default` (or the first, when none is) writes every
date the plugin shows. A format named `filler`, when there is one, writes the days in filler slots
instead. Other formats are offered by *Settings → Calendar → Date display* and a weather block's
`format:` line. A calendar with no formats writes dates as "Year 3, day 14 (Summer)" and reads
"3-14".

**Typing a date.** A typed date is read in any format that can be read back, and is accepted only
if the day it names prints exactly as typed. A whole number is always a day number. A format can
be read back when its tokens pin down one day: the number of a top cycle unit, the number (or the
name, if every slot has a different name) of each slot unit below it, and the day within the
deepest one. A format cannot be read back when it holds a placeholder, when two tokens touch with
nothing between them (`{year}{month}`), or when a filler slot sits above its deepest unit (the
default is allowed this when a `filler` format covers those days). The default and `filler`
formats may not hold placeholders.

### Limits

| What | Limit |
| --- | --- |
| The day line | Days −10,000,000 to 10,000,000. A unit's `ANCHOR` and a crossing's first instant lie on it. |
| Lengths and gear terms | Whole numbers of days within ±20,000,000. |
| Occurrence length | At least 1 day, in every combination of gears, stages and exceptions. |
| Displayed numbers (`NUMBER`) | Whole, within ±2^40. |
| Gear intervals and periods | 1 to 100,000; the combined period of a gear's intervals at most 100,000. |
| Gears per slot unit | At most 8 different gears read by one slot unit and the units above it. |
| Crossing period | At least one day. A crossing whose numbers are too fine to compute exactly across the day line is refused. |
| Stage window (`LENGTH:AT=`) | Within ±8 occurrences. |
| Stage `RESIDUE` modulus | 1 to 100,000. |
| Checked occurrences | A slot unit under a cycle with stages or a derived index is checked occurrence by occurrence: at most 1,000,000 occurrences on the day line. |
| Exceptions per unit | At most 1,000 `VSWITCH` blocks and 100,000 pinned starts. `FROM` within ±30,000,000. |
| `SHIFT` days | 1 to 400 either way; not 0. |
| `FIRST` window | 1 to 400 days. |
| Rule nesting | 64 levels of `ALL`, `ANY`, `NOT`, `SHIFT`, `FIRST`. Blocks nest at most 200 deep. |
| `SETPOS` | Over a period of at most 400 days. |
| World calendars | A cycle unit named `year`; seasons on `year`; at most 64 named rules; no `COUNT`; `SETPOS` only over `day` or a fixed cycle of at most 400 days; no `FIRST` inside a `FIRST`; at most 400 days of reach through `SHIFT` and `FIRST`. |
| Studio fields | The Year tab's *Days* field takes 1 to 10,000. The text has no such limit. |

### Messages

A definition that cannot be read or cannot run is not saved. The dialog shows the first problem.
A problem reading the text names its line. Most others name the part they are about (`unit
"month"`, `rule "lanterns"`, `format "long"`); a problem inside a rule adds where in the rule
(`rule "x".all[1].not`). Some messages end in a code such as `(V3)`: it names the check and can be
ignored. Below, `<…>` stands for the name or number in the message.

#### Reading the text

| Message | Meaning |
| --- | --- |
| `expected KEY:VALUE, got "<line>"` | A line is not `KEY:value`: an indented line, a lower case key, or a stray line. |
| `a calendar starts with BEGIN:VCALENDAR` | The first line (after comments and blank lines) is something else. |
| `END:<a> closes BEGIN:<b>` · `BEGIN:<a> is never closed` · `text after END:VCALENDAR` | The blocks do not pair up. |
| `<BLOCK> has no property <KEY>` · `<BLOCK> cannot hold <BLOCK>` | A line or block in a place that does not take it (often a misspelled key). |
| `<BLOCK> needs <KEY>` · `<BLOCK> has <KEY> twice` | A required line is missing, or a single line is repeated. |
| `SESHAT:<v> is not a version this reader knows (1)` | Write `SESHAT:1`. |
| `"<c>" must be escaped as "\<c>"` | A raw `\ , ; : = #` in a value. See [The text](#the-text). |
| `an empty value is written \0` · `bad escape "\<c>"` | An empty value, or a backslash before a character that needs none. |
| `<KEY> is a marker and takes no value` · `<KEY>: marks an empty list and stands alone` | A marker line with a value, or beside items. |
| `"<value>" is not a number` · `… is not a whole day` · `… is not a day literal (D<n>)` | A number or day number in the wrong form (check for trailing spaces). |
| `"<value>" is not a rational (n or n/d)` · `… is not in lowest terms with a denominator above 1` | A period, epoch or fraction written as a decimal, or not reduced (`2/4`). |
| `"<value>" is not an id ([a-z][a-z0-9-]*)` | An id with upper case letters, spaces or other characters. |
| `"<part>" in <KEY> is not KEY=VALUE` · `<KEY> has no parameter <P>` · `<KEY> has <P> twice` · `<KEY> needs <P>` | A parameter list is malformed. |
| `blocks nest deeper than 200` | Too many nested blocks. |

#### Ids and names

| Message | Meaning |
| --- | --- |
| `id "<id>" is declared more than once` | Two units, gears, bodies or rules share an id. |
| `the calendar's name must be a string without control characters` | `NAME` holds a tab or a `\n`. |
| `<where>: name "<text>" has a control character` · `<where>: a tag has a control character` | The same for a label, slot, rule or `RDATE`. |
| `<where>: tags must be a list of non-empty strings` · `<where>: a tag is listed twice` | A tag written `\0`, or the same tag twice in one list. |
| `"<text>" is not well-formed text (a lone surrogate)` | Broken characters in a name or tag. |

#### Years and other cycle units

| Message | Meaning |
| --- | --- |
| `a cycle needs CROSSING, or ANCHOR and LENGTH` · `a base is CROSSING or ANCHOR + LENGTH, not both` | A cycle unit has no base, or two. |
| `unit "<u>": anchor <n> is not a whole day within ±10000000` | `ANCHOR` is off the day line. |
| `unit "<u>": length <n> is not a whole number of days within ±20000000` | `LENGTH` is out of range. |
| `unit "<u>": an occurrence can be <n> days long; every occurrence needs at least one day (V3)` | Negative gear terms or stages can shorten an occurrence to nothing. |
| `unit "<u>": labels must be a non-empty list` | `LABELS:` on its own. |
| `unit "<u>": stage <j> has no rules` · `… stage <j> rule <i>: …` | A `VSTAGE` is empty, or one of its numbers is out of range (modulus, residues, window offset within ±8, length at least 1). |

#### Leap rules (gears)

| Message | Meaning |
| --- | --- |
| `a gear has POSITIONS, or RRULE/EXRULE terms, or (with no terms) ON` | A gear mixes forms or has none. |
| `every term of a gear reads the same unit (one FREQ)` | `RRULE` and `EXRULE` lines with different `FREQ`. |
| `gear "<g>": no unit "<u>"` · `gear "<g>": reads "<u>", which is not a cycle unit` | The gear reads a unit that is missing or a slot unit. |
| `gear "<g>": no intervals` | A gear written `ON:<unit>`. |
| `gear "<g>": interval <n> is not a whole number in 1..100000` · `gear "<g>": period <n> is too long to check (max 100000)` | An interval, or the intervals combined, too long. |
| `gear "<g>": index <n> is counted <s> times; include/exclude intervals must nest` | `RRULE` and `EXRULE` lines that do not nest (every 4 and every 6, say). |
| `gear "<g>": period <n> is not a whole number in 1..100000` · `gear "<g>": position <p> is outside 0..<n>` · `gear "<g>": a position is listed twice` | A `POSITIONS` table out of range. |
| `gear "<g>": offset <n> is not a whole number within ±20000000` | `OFFSET` out of range. |
| `GEAR is <id>*<add>` | A `GEAR` line on a unit or slot in the wrong form. |
| `<where>: no gear "<g>"` · `<where>: gear "<g>" reads "<u>", not "<v>"` | A `GEAR` line names a missing gear, or a gear that reads another unit. |
| `<where>: gear "<g>" adds <n>, not a whole number of days within ±20000000` | The days added are out of range. |

#### Months and other slot units

| Message | Meaning |
| --- | --- |
| `unit "<u>": no parent unit "<p>"` · `unit "<u>": its parents loop back on themselves; …` | `IN` names a missing unit, or units contain each other. |
| `unit "<u>": slots total <a> days but its parent occurrence is <b> (<case>)` | The slots do not add up to the parent. `<case>` says when: `always`, a gear setting such as `leap=1`, or one occurrence (`"year" 9: 367 days`). |
| `unit "<u>": slots take at least <a> days …` · `… take at most <a> days …` | Slack slots cannot stretch or shrink enough (`MIN`, `MAX`). |
| `unit "<u>": slot <i> has no length for a parent occurrence of <n> days` | A `KEYED` table lacks a row for a parent length that occurs. |
| `unit "<u>": slot <i> is <n> days` | Negative gear terms take a slot below 0. |
| `unit "<u>" slot <i>: a slack slot takes what is left and cannot carry gear terms` · `… a keyed slot takes its length from its table and cannot carry gear terms` · `… min, max and fill belong to slack slots only` | A setting on a slot that cannot take it. |
| `unit "<u>" slot <i>: length <n> is not a whole number of days in 0..20000000` · `min …` · `max …` · `fill …` · `table row … is not [parent length ≥ 1, length ≥ 0]` · `table lists parent length <n> twice` | A slot's numbers out of range. |
| `SLOT is <name>=<length>` · `TABLE belongs to a KEYED length` · `FILLER is TRUE or FALSE` | A slot line in the wrong form. |
| `unit "<u>": reads <n> gears; at most 8` | Too many different gears above one slot unit. |
| `unit "<u>": "<c>" has <n> occurrences within ±10000000; …` | A cycle with stages has too many occurrences to check its slots. |

#### Moons, bodies and crossings

| Message | Meaning |
| --- | --- |
| `moon "<name>" is declared more than once` | Two moons share a `MOON` name. |
| `PHASE lines belong to a body with a MOON line` | Phases on a body that is not a moon. |
| `moon "<name>" phases: mark "<p>" must be at a phase in [0, 1)` | A phase point of 1 or more, or negative. |
| `body "<b>": a body's period must be positive (…)` · `body "<b>": … is too fine for safe-integer phases` | `PERIOD` is 0 or negative, or its fraction is too fine. |
| `CROSSING is <period>@<at> or BODY=<id>;MARK=<mark>, not both` · `CROSSING has MARK only with BODY` · `START is after or contains, not "<x>"` · `INDEX is <a>/<c>/<L>` | A `CROSSING` line in the wrong form. |
| `unit "<u>": crossing follows body "<b>", which is not declared` | `BODY=` names a missing body. |
| `unit "<u>": crossing following body "<b>": mark must be a rational n/d in lowest terms in [0, 1)` | `MARK` is 1 or more, or negative. |
| `unit "<u>": crossing follows body "<b>", whose period <p> is shorter than one day (V8)` · `… crossing period <p> is shorter than one day (V8)` | Occurrences would be shorter than a day. |
| `unit "<u>": crossing instant <x> is outside ±10000000` | The first crossing is off the day line. |
| `unit "<u>": … is too fine for exact integer days within ±10000000 (V5): use a coarser period or instant` · `… puts its instant past safe integers (V5): …` | The fractions are too fine to compute exactly; use fewer digits. |

#### Seasons

| Message | Meaning |
| --- | --- |
| `a calendar has one VSEASONS block` | Two `VSEASONS` blocks. |
| `seasons: no unit "<u>"` · `seasons: "<u>" is a slot unit; seasons follow a cycle unit's phase` | `UNIT` is missing or a slot unit. |
| `"<value>" is not a season mark (a fraction, DAY:<n> or <unit>:<slot>.<day>)` | A mark in another form (for example `month\:3.1`, with an escaped colon). |
| `seasons: mark "<n>" must be at a phase in [0, 1)` | A fraction of 1 or more, or negative. |
| `seasons: mark "<n>" must be on a whole day of the year from 1` | `DAY:0` or less. |
| `seasons: mark "<n>": "<u>" is not a slot unit directly in the seasons unit "<y>"` · `… "<u>" has no slot <k>` · `… slot <k> of "<u>" is a filler slot; a season cannot start in one` · `… the day in the slot must be a whole number from 1` | A month mark names the wrong unit, a missing or filler slot, or day 0. |
| `seasons: mark <i> needs a name` | A mark named `\0`. |

#### Exceptions

Most begin `unit "<u>": ledger entry <i>: …` (the *i*-th `STARTS`, `SLOTS` or `VSWITCH` of the unit).

| Message | Meaning |
| --- | --- |
| `from <k> is not a whole occurrence index within ±30000000` | `FROM` out of range. |
| `switches must come in increasing order of from` | `VSWITCH` blocks out of order. |
| `startsOn <x> is not a whole day within ±20000000` · `lengths must be whole numbers of days ≥ 1` · `its last pinned start, day <n>, is outside ±20000000` | A `STARTS` line out of range. |
| `occurrence <k> is pinned twice` · `more than 100000 pinned starts` | `STARTS` lines overlap, or too many. |
| `unit "<x>" is not a slot unit under "<u>"` · `path must name one non-filler slot of each of the <n> slot unit(s) between …` · `lengths must be <n> whole numbers of days ≥ 0, one per slot of "<x>"` · `occurrence <k> of "<x>" is overridden twice` | A `SLOTS` line names the wrong unit, a wrong `PATH`, the wrong number of lengths, or repeats. |
| `unit "<u>": the ledger's slot lengths total <a> days but its parent occurrence is <b> …` | A `SLOTS` line's lengths do not fill the occurrence. |
| `unit "<u>": occurrence <k> is both pinned and a switch's first occurrence; pin the next one instead` | A `STARTS` and a `VSWITCH` on the same occurrence. |
| `unit "<u>": occurrence <k> would be <n> days long (it starts on day <a>, the next on day <b>); every occurrence needs at least one day (V7)` | A pinned start or a switch makes an occurrence end before it starts. |
| `<n> ledger switches; at most 1000` | Too many `VSWITCH` blocks. |
| `day label <i>: …` | An `RDATE` line's name or tags (the *i*-th `RDATE`). |

#### Rules

Most begin `rule "<id>"`, then where in the rule; those about the shape of the text begin with
the line number.

| Message | Meaning |
| --- | --- |
| `a VRULE holds exactly one rule` · `NOT holds exactly one rule` · `SHIFT holds exactly one rule` · `FIRST holds exactly one rule besides its AFTER block` · `FIRST needs exactly one AFTER block` · `AFTER holds exactly one rule` | A block holds the wrong number of rules (combine several with `ALL` or `ANY`). |
| `…: no unit "<u>"` · `… freq: no unit "<u>"` · `…: no body "<b>"` | A rule names a missing unit or body. |
| `…: phase names exactly one of unit and body` · `PHASE has NAME or FROM and TO, not both` | A `PHASE` line in the wrong form. |
| `…: names phase "<p>" of body "<b>", which has no such phase (its phases: …)` · `… which has no named phases` · `… which is not declared` · `… which has more than one phase named …` · `… more than one phase at …` · `…: a named phase belongs to a body (BODY=), not a unit` | `NAME=` cannot be found on that body. |
| `…: index reads a cycle unit; "<u>" is a slot unit` | `INDEX` on a slot unit. |
| `…: a tag is a non-empty string` | `TAG:\0`. |
| `…: dates must be a non-empty list of whole numbers` | `DATES:` with no days. |
| `…: SHIFT DAYS must be a whole number of days, not 0, at most 400 either way` · `…: FIRST WITHIN must be a whole number from 1 to 400` | `DAYS` or `WITHIN` out of range. |
| `…: interval must be a whole number ≥ 1` · `…: interval > 1 needs a cycle unit; "<u>" is a slot unit, which has no global count` | `INTERVAL` out of range, or above 1 on a slot unit. |
| `…: count must be a whole number ≥ 1` · `…: count over slot unit "<u>" needs an anchor (a slot unit has no occurrence 0)` | `COUNT` out of range, or over a slot unit without `ANCHOR`. |
| `…: setpos must be a non-empty list of non-zero whole numbers` · `…: setpos over "<u>", whose <n>-day period is past the 400-day limit` | `SETPOS` out of range, or over too long a period. |
| `… by[<i>]: nth must be …` · `… by[<i>]: day must be …` · `… by[<i>]: label must be a non-empty list of names or #tags` | A `BY…` list is empty or holds 0. |
| `BYNTH is <unit>:<values>` · `BY= marks an empty filter list and stands alone` · `RRULE takes only parameters` | An `RRULE` in the wrong form. |
| `…: rules nest deeper than 64` | Too many nested blocks in one rule. |
| `rules read each other's tags in a cycle: "<a>" → "<b>" → "<a>"` | Rules that read each other in a circle. |

#### Formats

Most begin `format "<name>": …`.

| Message | Meaning |
| --- | --- |
| `FORMAT is <name>=<pattern>` | No `=` in the line. |
| `format "<name>" is declared more than once` · `a format needs a name` | Two formats share a name, or a name is `\0`. |
| `a lone "}" at <i> (write "}}" for a brace)` · `"{" at <i> is never closed` | Unpaired braces. |
| `no unit "<u>"` · `unknown field ":<f>" in {<token>}` | A token names a missing unit, or a field other than `name`, `day`, `day0`, `pad1`–`pad9`. |
| `unknown placeholder {<p>} (the placeholders are {@season}, {@phase:<body>}, {@name})` · `{<p>} is not a phase placeholder (write {@phase:<body id>})` · `{@phase:<b>} names no declared body "<b>"` | A placeholder that does not exist, or a phase placeholder without a known body. |
| `a placeholder (…) cannot be in the default format, which must stay one a date can be typed in; put it in another format` | The same for the `filler` format, or for the first format when none is named `default`. |
| `unit "<u>" has a parent chain that loops` | Units contain each other. |
| `unit "<u>": number <n> is not a whole number within ±2^40` | `NUMBER` out of range. |

#### What a world calendar needs

These are checked on top of everything above, because a world's weather reads its calendar every
day.

| Message | Meaning |
| --- | --- |
| `a world calendar needs a cycle unit with the id "year"` | Add a `year` cycle unit, or rename yours. |
| `a world calendar's seasons run over its year, not "<u>"` | `VSEASONS` must have `UNIT:year`. |
| `a world calendar has at most 64 named rules` | Too many `VRULE` blocks. |
| `rule "<id>": a world calendar's rules cannot use COUNT` | Use `UNTIL` or `DATES` instead. |
| `rule "<id>": a world calendar's BYSETPOS needs a constant period of at most 400 days` | Use a range of `BYDAY` values instead (see [Rules](#rules)). |
| `rule "<id>": a world calendar's rules cannot hold a FIRST inside a FIRST` | Split the inner `FIRST` into its own rule and read its tag. |
| `rule "<id>": a world calendar's rule reaches <n> days through SHIFT and FIRST (with the rules it reads); the limit is 400` | Shorten the `SHIFT` days or `FIRST` windows along the chain. |
