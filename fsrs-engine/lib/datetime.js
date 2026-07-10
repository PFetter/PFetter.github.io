// Shared date coercion helpers.
// Extracted from scheduler.js on second use (queue.js/db.js/exportImport.js
// all need the same Date | ISO-string | epoch-ms -> canonical coercion),
// per the "extract on second use" rule in lib/ conventions.

export function toMs(value) {
  const ms =
    value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
    : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`invalid date: ${value}`);
  return ms;
}

export function toIso(value) {
  return new Date(toMs(value)).toISOString();
}
