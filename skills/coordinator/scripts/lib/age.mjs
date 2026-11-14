// How long something has run, in plain words, for the run cards ("age 2 h 11 min").
// The live page runs this same function (lib/parts.mjs SERVED) to keep ages current,
// so it stays self-contained: no imports, no outside names.
export function ageText(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}
