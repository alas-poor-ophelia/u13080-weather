/**
 * What a calendar change does to the world's year-keyed data (wadjet-91c): eras and automation lane points are
 * stored as the calendar's own year numbers, so after a change they count in the new calendar's years and can
 * cover other days, whichever day-number choice is made. Null when the world has none.
 */
export function yearKeyedNote(eras: readonly { readonly name: string }[], zones: readonly { readonly automation?: readonly unknown[] }[]): string | null {
  const lanes = zones.reduce((n, z) => n + (z.automation?.length ?? 0), 0);
  const parts = [
    ...(eras.length ? [`${eras.length} ${eras.length === 1 ? "era" : "eras"}`] : []),
    ...(lanes ? [`${lanes} automation ${lanes === 1 ? "lane" : "lanes"}`] : []),
  ];
  if (!parts.length) return null;
  const they = eras.length + lanes === 1 ? "It is" : "They are";
  return `This world's ${parts.join(" and ")} ${eras.length + lanes === 1 ? "is" : "are"} placed by year number. ${they} kept as ${eras.length + lanes === 1 ? "a number" : "numbers"}, so after this change ${eras.length + lanes === 1 ? "it counts" : "they count"} in the new calendar's years and can fall on other days; check ${eras.length + lanes === 1 ? "it" : "them"} in the Studio.`;
}
