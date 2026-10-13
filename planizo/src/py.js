import crypto from "node:crypto";

export function dt(year, month = 1, day = 1, hour = 0, minute = 0, second = 0, ms = 0) {
  const d = new Date(2000, month - 1, day, hour, minute, second, ms);
  if (year !== 2000) d.setFullYear(year, month - 1, day);
  return d;
}

export function fields(d) {
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
    ms: d.getMilliseconds(),
  };
}

export function replace(d, changes) {
  const f = { ...fields(d), ...changes };
  return dt(f.year, f.month, f.day, f.hour, f.minute, f.second, f.ms);
}

export function shift(d, { days = 0, hours = 0, minutes = 0, seconds = 0, ms = 0 } = {}) {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours() + hours,
    d.getMinutes() + minutes,
    d.getSeconds() + seconds,
    d.getMilliseconds() + ms,
  );
}

function wallUtc(d) {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

export function wallDiffMs(a, b) {
  return wallUtc(a) - wallUtc(b);
}

export function wallDiffSeconds(a, b) {
  return wallDiffMs(a, b) / 1000;
}

export function sameInstant(a, b) {
  return a.getTime() === b.getTime();
}

export function pyWeekday(d) {
  return (d.getDay() + 6) % 7;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

export function isoLocal(d) {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function isoDate(d) {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

export function fromIsoFormat(text) {
  const m = ISO_RE.exec(String(text).trim());
  if (!m) throw new ValueError(`Invalid isoformat string: '${text}'`);
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", tz] = m;
  const ms = frac ? Math.floor(Number(frac.padEnd(6, "0")) / 1000) : 0;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) throw new ValueError(`Invalid isoformat string: '${text}'`);
  if (!tz) {
    const local = dt(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), ms);
    if (local.getDate() !== Number(d)) throw new ValueError(`day is out of range for month: '${text}'`);
    return local;
  }
  let offsetMin = 0;
  if (tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms) - offsetMin * 60000;
  return new Date(utc);
}

export class ValueError extends Error {}

export function pyRound(x, ndigits = 0) {
  const m = 10 ** ndigits;
  const v = x * m;
  const r = Math.round(v);
  const exactHalf = Math.abs(v - Math.trunc(v)) === 0.5;
  const result = exactHalf ? 2 * Math.round(v / 2) : r;
  return ndigits ? result / m : result;
}

export function mod(a, b) {
  return ((a % b) + b) % b;
}

export function floorDiv(a, b) {
  return Math.floor(a / b);
}

export function casefold(s) {
  return String(s ?? "").toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ");
}

export function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object" && !(v instanceof Date)) return Object.keys(v).length > 0;
  return true;
}

function cmpValue(a, b) {
  if (a === b) return 0;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      const c = cmpValue(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compare(a, b) {
  return cmpValue(a, b);
}

export function sorted(items, key = (x) => x, reverse = false) {
  const decorated = Array.from(items, (item, index) => [key(item), index, item]);
  decorated.sort((x, y) => {
    const c = cmpValue(x[0], y[0]);
    if (c !== 0) return reverse ? -c : c;
    return x[1] - y[1];
  });
  return decorated.map((x) => x[2]);
}

export function uuidHex() {
  return crypto.randomUUID().replace(/-/g, "");
}

export function uuid4() {
  return crypto.randomUUID();
}

export function nowMs() {
  return Date.now();
}

export function strftime(d, format) {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const map = {
    a: () => days[d.getDay()].slice(0, 3),
    A: () => days[d.getDay()],
    b: () => months[d.getMonth()].slice(0, 3),
    B: () => months[d.getMonth()],
    d: () => pad(d.getDate()),
    m: () => pad(d.getMonth() + 1),
    Y: () => pad(d.getFullYear(), 4),
    y: () => pad(d.getFullYear() % 100),
    H: () => pad(d.getHours()),
    I: () => pad(d.getHours() % 12 || 12),
    M: () => pad(d.getMinutes()),
    S: () => pad(d.getSeconds()),
    p: () => (d.getHours() < 12 ? "AM" : "PM"),
    j: () => pad(Math.floor((dt(d.getFullYear(), d.getMonth() + 1, d.getDate()) - dt(d.getFullYear(), 1, 1)) / 86400000) + 1, 3),
    "%": () => "%",
  };
  return format.replace(/%([aAbBdmYyHIMSpj%])/g, (_, c) => map[c]());
}
