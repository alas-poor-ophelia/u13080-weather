/** Every P1 calendar and the canonical text file that holds it (scripts/seshat-fixtures.ts writes them). */
import { BAHAI, BALINESE, COPTIC, ETHIOPIAN, FRENCH_REPUBLICAN, FRENCH_REPUBLICAN_EQUINOX, GREGORIAN, HARPTOS, HEBREW, ISLAMIC_CIVIL, ISLAMIC_TBLA, MAYA, ROMAN, type CalendarAst } from "../../../src/seshat";

export const SESHAT_FIXTURES: Record<string, CalendarAst> = {
  "gregorian.seshat": GREGORIAN,
  "islamic-civil.seshat": ISLAMIC_CIVIL,
  "islamic-tbla.seshat": ISLAMIC_TBLA,
  "coptic.seshat": COPTIC,
  "ethiopian.seshat": ETHIOPIAN,
  "french-republican.seshat": FRENCH_REPUBLICAN,
  "french-republican-equinox.seshat": FRENCH_REPUBLICAN_EQUINOX,
  "harptos.seshat": HARPTOS,
  "hebrew.seshat": HEBREW,
  "maya.seshat": MAYA,
  "balinese.seshat": BALINESE,
  "roman.seshat": ROMAN,
  "bahai.seshat": BAHAI,
};
