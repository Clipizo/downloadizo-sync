import { dt, pyWeekday, replace, shift, strftime } from "../py.js";

export function msToLocal(ms) {
  return new Date(Number(ms));
}

export function localToMs(d) {
  return Math.trunc(d.getTime());
}

export function dateKey(d) {
  return `${String(d.getFullYear()).padStart(4, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseDateKey(key) {
  const parts = String(key).split("-");
  if (parts.length !== 3) throw new Error(`not enough values to unpack: ${key}`);
  const [year, month, day] = parts.map((p) => {
    if (!/^\s*[+-]?\d+\s*$/.test(p)) throw new Error(`invalid literal for int(): '${p}'`);
    return Number(p);
  });
  const d = dt(year, month, day);
  if (month < 1 || month > 12 || d.getDate() !== day || d.getMonth() !== month - 1) throw new Error("day is out of range for month");
  return d;
}

export function startOfDay(d) {
  return replace(d, { hour: 0, minute: 0, second: 0, ms: 0 });
}

export function endOfDay(d) {
  return replace(d, { hour: 23, minute: 59, second: 59, ms: 999 });
}

export function addDays(d, days) {
  return shift(d, { days });
}

export function eachDay(fromDt, toDt) {
  const days = [];
  let cursor = startOfDay(fromDt);
  const end = startOfDay(toDt);
  while (cursor <= end) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function startOfWeek(d) {
  const start = startOfDay(d);
  return shift(start, { days: -pyWeekday(start) });
}

export function endOfWeek(d) {
  return endOfDay(shift(startOfWeek(d), { days: 6 }));
}

export function endOfMonth(d) {
  const nxt = d.getMonth() === 11
    ? replace(d, { year: d.getFullYear() + 1, month: 1, day: 1 })
    : replace(d, { month: d.getMonth() + 2, day: 1 });
  return shift(nxt, { seconds: -1 });
}

export function startOfMonth(d) {
  return replace(d, { day: 1, hour: 0, minute: 0, second: 0, ms: 0 });
}

export function calendarMonthRange(d) {
  return [startOfWeek(startOfMonth(d)), endOfWeek(endOfMonth(d))];
}

export function withTime(day, source) {
  const base = startOfDay(day);
  return replace(base, { hour: source.getHours(), minute: source.getMinutes(), second: source.getSeconds(), ms: source.getMilliseconds() });
}

export function formatTime(d, timeFormat = "h12") {
  if (timeFormat === "h24") return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const h = d.getHours() % 12 || 12;
  const am = d.getHours() < 12 ? "AM" : "PM";
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${am}`;
}

export function formatTimeRange(startAt, endAt, timeFormat = "h12") {
  return `${formatTime(startAt, timeFormat)} - ${formatTime(endAt, timeFormat)}`;
}

export function labelDate(key) {
  return strftime(parseDateKey(key), "%a, %b %d");
}
