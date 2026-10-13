import { route, ApiError, Raw } from "./http.js";
import { ValueError, pyRound, strftime, truthy, uuidHex } from "./py.js";

export const PAST_DAYS = 30;
export const FUTURE_DAYS = 365;
export const MAX_TEXT = 20_000_000;
export const MAX_PERIODS = 50_000;
const WEEKDAYS = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
const FREQUENCIES = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const UNSUPPORTED_PARTS = ["BYWEEKNO", "BYYEARDAY", "BYHOUR", "BYMINUTE", "BYSECOND"];
const ONE_OFF = "NOT EXISTS (SELECT 1 FROM RecurrenceRule r WHERE r.eventId = e.id AND r.deleted = 0)";
const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

export class OverflowError extends Error {}

function pyStrip(value) {
  return String(value).replace(STRIP_RE, "");
}

function pyInt(value) {
  const text = pyStrip(value);
  if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) throw new ValueError(`invalid literal for int() with base 10: '${value}'`);
  return Number(text.replace(/_/g, "")) + 0;
}

function wallMs(year, month, day, hour = 0, minute = 0, second = 0) {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

const MIN_WALL = wallMs(1, 1, 1);
const MAX_WALL = wallMs(9999, 12, 31, 23, 59, 59) + 999;

function isLeap(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function monthLen(year, month) {
  if (!(month >= 1 && month <= 12)) throw new ValueError(`bad month number ${month}; must be 1-12`);
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function mkDate(year, month, day, hour = 0, minute = 0, second = 0) {
  if (!(year >= 1 && year <= 9999)) throw new ValueError(`year ${year} is out of range`);
  if (!(month >= 1 && month <= 12)) throw new ValueError("month must be in 1..12");
  if (!(day >= 1 && day <= monthLen(year, month))) throw new ValueError("day is out of range for month");
  if (!(hour >= 0 && hour <= 23)) throw new ValueError("hour must be in 0..23");
  if (!(minute >= 0 && minute <= 59)) throw new ValueError("minute must be in 0..59");
  if (!(second >= 0 && second <= 59)) throw new ValueError("second must be in 0..59");
  return wallMs(year, month, day, hour, minute, second);
}

function add(wall, ms) {
  const out = wall + ms;
  if (!(out >= MIN_WALL && out <= MAX_WALL)) throw new OverflowError("date value out of range");
  return out;
}

function days(count) {
  if (Math.abs(count) > 999999999) throw new OverflowError(`days=${count}; must have magnitude <= 999999999`);
  return count * DAY;
}

function parts(wall) {
  const d = new Date(wall);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds(),
  };
}

function dateOf(wall) {
  return wall - (((wall % DAY) + DAY) % DAY);
}

function timeOf(wall) {
  return wall - dateOf(wall);
}

function weekday(wall) {
  return (new Date(wall).getUTCDay() + 6) % 7;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

function fmtDate(wall) {
  const p = parts(wall);
  return `${pad(p.year, 4)}${pad(p.month)}${pad(p.day)}`;
}

function fmtStamp(wall) {
  const p = parts(wall);
  return `${pad(p.year, 4)}${pad(p.month)}${pad(p.day)}T${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`;
}

function fromTimestamp(ms) {
  const d = new Date(ms);
  return wallMs(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) + d.getMilliseconds();
}

function wallToLocalMs(wall) {
  const p = parts(wall);
  const d = new Date(2000, 0, 1);
  d.setFullYear(p.year, p.month - 1, p.day);
  d.setHours(p.hour, p.minute, p.second, p.ms);
  return d.getTime();
}

function dateToWall(date) {
  return fromTimestamp(date.getTime());
}

class Comp {
  constructor(name) {
    this.name = name;
    this.props = [];
    this.children = [];
  }

  get(name) {
    return this.props.find((p) => p[0] === name) || null;
  }

  value(name) {
    const prop = this.get(name);
    return prop ? prop[2] : "";
  }

  all(name) {
    return this.props.filter((p) => p[0] === name);
  }
}

function lines(text) {
  const out = [];
  for (const raw of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if ((raw[0] === " " || raw[0] === "\t") && out.length) out[out.length - 1] += raw.slice(1);
    else if (pyStrip(raw)) out.push(raw);
  }
  return out;
}

function property(line) {
  let quoted = false;
  let head = null;
  let value = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      head = line.slice(0, i);
      value = line.slice(i + 1);
      break;
    }
  }
  if (head === null) return null;
  const pieces = [];
  let buf = "";
  quoted = false;
  for (const ch of head) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      pieces.push(buf);
      buf = "";
    } else buf += ch;
  }
  pieces.push(buf);
  const params = new Map();
  for (const part of pieces.slice(1)) {
    const at = part.indexOf("=");
    if (at >= 0) params.set(pyStrip(part.slice(0, at)).toUpperCase(), pyStrip(part.slice(at + 1)).replace(/^"+|"+$/g, ""));
  }
  return [pyStrip(pieces[0]).toUpperCase(), params, value];
}

function tree(text) {
  const root = new Comp("ROOT");
  const stack = [root];
  for (const line of lines(text)) {
    const prop = property(line);
    if (!prop) continue;
    if (prop[0] === "BEGIN") {
      const comp = new Comp(pyStrip(prop[2]).toUpperCase());
      stack[stack.length - 1].children.push(comp);
      stack.push(comp);
    } else if (prop[0] === "END") {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].props.push(prop);
    }
  }
  return root;
}

function walk(comp, name, out = []) {
  for (const child of comp.children) {
    if (child.name === name) out.push(child);
    walk(child, name, out);
  }
  return out;
}

function unescapeText(value) {
  return pyStrip(value.replace(/\\([^\n])/g, (_, ch) => (ch === "n" || ch === "N" ? "\n" : ch)));
}

function stamp(value) {
  value = pyStrip(value);
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (m) return { wall: mkDate(Number(m[1]), Number(m[2]), Number(m[3])), isDate: true, utc: false };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/i.exec(value);
  if (m) {
    const wall = mkDate(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    return { wall, isDate: false, utc: Boolean(m[7]) };
  }
  return { wall: null, isDate: false, utc: false };
}

function offset(value) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(pyStrip(value));
  if (!m) return null;
  const size = Number(m[2]) * HOUR + Number(m[3]) * 60 * SECOND + Number(m[4] || 0) * SECOND;
  return m[1] === "-" ? -size : size;
}

function duration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(pyStrip(value).toUpperCase());
  if (!m) return null;
  const size =
    Number(m[2] || 0) * 7 * DAY + Number(m[3] || 0) * DAY + Number(m[4] || 0) * HOUR + Number(m[5] || 0) * 60 * SECOND + Number(m[6] || 0) * SECOND;
  return m[1] === "-" ? -size : size;
}

function parseRule(value) {
  const rule = new Map();
  for (const part of pyStrip(value).split(";")) {
    const at = part.indexOf("=");
    if (at >= 0) rule.set(pyStrip(part.slice(0, at)).toUpperCase(), pyStrip(part.slice(at + 1)));
  }
  return rule;
}

function ruleGet(rule, key, fallback = null) {
  return rule.has(key) ? rule.get(key) : fallback;
}

function ints(value) {
  return value.split(",").filter((x) => pyStrip(x)).map(pyInt);
}

function weekdaySpec(spec) {
  const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(pyStrip(spec).toUpperCase());
  if (!m) throw new ValueError(spec);
  return [m[1] !== undefined ? Number(m[1]) + 0 : null, WEEKDAYS[m[2]]];
}

function weekdaysInMonth(year, month, wd, nth) {
  const found = [];
  const last = monthLen(year, month);
  for (let d = 1; d <= last; d += 1) if (weekday(mkDate(year, month, d)) === wd) found.push(d);
  if (nth === null) return found;
  const index = nth > 0 ? nth - 1 : nth;
  return -found.length <= index && index < found.length ? [found[index < 0 ? found.length + index : index]] : [];
}

function numSort(values) {
  return [...values].sort((a, b) => a - b);
}

export function expand(start, rule, until, windowStart, windowEnd) {
  const freq = String(ruleGet(rule, "FREQ", "")).toUpperCase();
  if (!FREQUENCIES.has(freq) || UNSUPPORTED_PARTS.some((k) => rule.has(k))) throw new ValueError("unsupported repeat rule");
  const interval = Math.max(1, pyInt(truthy(ruleGet(rule, "INTERVAL")) ? rule.get("INTERVAL") : 1));
  const count = truthy(ruleGet(rule, "COUNT")) ? pyInt(rule.get("COUNT")) : null;
  const months = truthy(ruleGet(rule, "BYMONTH")) ? ints(rule.get("BYMONTH")) : null;
  const monthdays = truthy(ruleGet(rule, "BYMONTHDAY")) ? ints(rule.get("BYMONTHDAY")) : null;
  const weekdays = truthy(ruleGet(rule, "BYDAY")) ? rule.get("BYDAY").split(",").filter((x) => pyStrip(x)).map(weekdaySpec) : null;
  const setpos = truthy(ruleGet(rule, "BYSETPOS")) ? ints(rule.get("BYSETPOS")) : null;
  const wkstKey = String(ruleGet(rule, "WKST", "MO")).toUpperCase();
  const wkst = Object.prototype.hasOwnProperty.call(WEEKDAYS, wkstKey) ? WEEKDAYS[wkstKey] : 0;
  const hasMonths = truthy(months);
  const hasMonthdays = truthy(monthdays);
  const hasWeekdays = truthy(weekdays);
  if (freq === "YEARLY" && hasWeekdays && !hasMonths && weekdays.some(([nth]) => truthy(nth))) throw new ValueError("unsupported repeat rule");
  const startDate = dateOf(start);
  const startParts = parts(start);
  const startTime = timeOf(start);
  const weekdaySet = new Set(hasWeekdays ? weekdays.map(([, wd]) => wd) : []);

  function wantedDays(last) {
    return new Set(monthdays.map((m) => (m > 0 ? m : last + 1 + m)));
  }

  function monthDays(year, month) {
    const last = monthLen(year, month);
    const wanted = hasMonthdays ? wantedDays(last) : null;
    if (hasWeekdays) {
      const found = new Set();
      for (const [nth, wd] of weekdays) for (const d of weekdaysInMonth(year, month, wd, nth)) found.add(d);
      return numSort(found).filter((d) => wanted === null || wanted.has(d));
    }
    if (wanted !== null) return numSort([...wanted].filter((d) => d >= 1 && d <= last));
    return startParts.day <= last ? [startParts.day] : [];
  }

  function period(index) {
    if (freq === "DAILY") {
      const day = add(startDate, days(index * interval));
      const p = parts(day);
      let ok = (!hasMonths || months.includes(p.month)) && (!hasWeekdays || weekdaySet.has(weekday(day)));
      if (ok && hasMonthdays) ok = wantedDays(monthLen(p.year, p.month)).has(p.day);
      return [day, ok ? [day] : []];
    }
    if (freq === "WEEKLY") {
      const first = add(add(startDate, -days((((weekday(start) - wkst) % 7) + 7) % 7)), days(index * interval * 7));
      const chosen = hasWeekdays ? weekdaySet : new Set([weekday(start)]);
      const found = numSort([...chosen].map((wd) => add(first, days((((wd - wkst) % 7) + 7) % 7))));
      return [first, found.filter((d) => !hasMonths || months.includes(parts(d).month))];
    }
    if (freq === "MONTHLY") {
      const total = startParts.month - 1 + index * interval;
      const year = startParts.year + Math.floor(total / 12);
      const month = (total % 12) + 1;
      if (hasMonths && !months.includes(month)) return [mkDate(year, month, 1), []];
      const begins = mkDate(year, month, 1);
      return [begins, monthDays(year, month).map((d) => mkDate(year, month, d))];
    }
    const year = startParts.year + index * interval;
    const chosenMonths = hasMonths ? months : !(hasWeekdays || hasMonthdays) ? [startParts.month] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const begins = mkDate(year, 1, 1);
    const found = [];
    for (const m of chosenMonths) for (const d of monthDays(year, m)) found.push(mkDate(year, m, d));
    return [begins, numSort(found)];
  }

  let firstIndex = 0;
  if (count === null) {
    const gap = Math.round((dateOf(windowStart) - startDate) / DAY);
    if (gap > 0) {
      const span = { DAILY: 1, WEEKLY: 7, MONTHLY: 28, YEARLY: 365 }[freq] * interval;
      firstIndex = Math.max(0, Math.floor(gap / span) - 2);
    }
  }
  const limit = until !== null ? Math.min(until, windowEnd) : windowEnd;
  const limitDate = dateOf(limit);
  const out = windowStart <= start && start <= windowEnd ? [start] : [];
  let produced = 1;
  for (let index = firstIndex; index < firstIndex + MAX_PERIODS; index += 1) {
    let [begins, found] = period(index);
    if (begins > limitDate) break;
    if (truthy(setpos) && found.length) {
      const picked = new Set();
      for (const p of setpos) {
        const i = p > 0 ? p - 1 : p;
        if (-found.length <= i && i < found.length) picked.add(found[i < 0 ? found.length + i : i]);
      }
      found = numSort(picked);
    }
    let stop = false;
    for (const day of found) {
      const occurrence = day + startTime;
      if (occurrence <= start) continue;
      if ((until !== null && occurrence > until) || (count !== null && produced >= count) || occurrence > windowEnd) {
        stop = true;
        break;
      }
      produced += 1;
      if (occurrence >= windowStart) out.push(occurrence);
    }
    if (stop) break;
  }
  return out;
}

class Zone {
  constructor(comp) {
    this.observances = [];
    this.onsets = new Map();
    for (const child of comp.children) {
      if (child.name !== "STANDARD" && child.name !== "DAYLIGHT") continue;
      const begin = stamp(child.value("DTSTART")).wall;
      const offsetTo = offset(child.value("TZOFFSETTO"));
      if (begin === null || offsetTo === null) continue;
      const extra = [];
      for (const prop of child.all("RDATE")) {
        for (const item of prop[2].split(",")) {
          const when = stamp(item);
          if (when.wall !== null && !when.isDate) extra.push(when.wall);
        }
      }
      const rule = child.get("RRULE") ? parseRule(child.value("RRULE")) : null;
      const from = offset(child.value("TZOFFSETFROM"));
      this.observances.push([begin, rule, extra, from ? from : offsetTo, offsetTo]);
    }
  }

  onsetsFor(index, year) {
    const key = `${index}:${year}`;
    if (!this.onsets.has(key)) {
      const [begin, rule, extra] = this.observances[index];
      let found = [begin, ...extra];
      if (rule && rule.size) {
        const until = stamp(ruleGet(rule, "UNTIL", ""));
        let untilWall = until.wall;
        if (untilWall !== null && until.isDate) untilWall = add(untilWall, 23 * HOUR + 59 * 60 * SECOND + 59 * SECOND);
        try {
          found = found.concat(expand(begin, rule, untilWall, mkDate(year - 1, 1, 1), mkDate(year, 12, 31, 23, 59, 59)));
        } catch (exc) {
          if (!(exc instanceof ValueError)) throw exc;
        }
      }
      this.onsets.set(key, found);
    }
    return this.onsets.get(key);
  }

  utcoffset(wall) {
    let best = null;
    const year = parts(wall).year;
    this.observances.forEach((observance, index) => {
      for (const onset of this.onsetsFor(index, year)) {
        if (onset <= wall && (best === null || onset > best[0])) best = [onset, observance[4]];
      }
    });
    if (best) return best[1];
    if (this.observances.length) {
      let first = this.observances[0];
      for (const o of this.observances) if (o[0] < first[0]) first = o;
      return first[3];
    }
    return null;
  }
}

const NAMED_ZONES = new Map();

class NamedZone {
  constructor(format) {
    this.format = format;
  }

  offsetAt(instant) {
    const at = Math.floor(instant / SECOND) * SECOND;
    const f = {};
    for (const part of this.format.formatToParts(new Date(at))) f[part.type] = part.value;
    let year = Number(f.year);
    if (f.era && /^B/i.test(f.era)) year = 1 - year;
    return wallMs(year, Number(f.month), Number(f.day), Number(f.hour) % 24, Number(f.minute), Number(f.second)) - at;
  }

  utcoffset(wall) {
    const before = this.offsetAt(wall - DAY);
    const after = this.offsetAt(wall + DAY);
    return this.offsetAt(wall - Math.max(before, after));
  }
}

function namedZone(tzid) {
  if (NAMED_ZONES.has(tzid)) return NAMED_ZONES.get(tzid);
  let zone = null;
  if (/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tzid) && !tzid.includes("..")) {
    try {
      zone = new NamedZone(
        new Intl.DateTimeFormat("en-US", {
          timeZone: tzid,
          hourCycle: "h23",
          era: "short",
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
        }),
      );
    } catch {
      zone = null;
    }
  }
  NAMED_ZONES.set(tzid, zone);
  return zone;
}

function toLocalExact(wall, zone) {
  if (zone === null) return [wall, null];
  const size = zone === "utc" ? 0 : zone.utcoffset(wall);
  if (size === null) return [wall, null];
  const instant = add(wall, -size);
  return [fromTimestamp(instant), instant];
}

function toLocal(wall, zone) {
  return toLocalExact(wall, zone)[0];
}

function fromUtc(utc, zone) {
  if (zone === null) return fromTimestamp(utc);
  if (zone === "utc") return utc;
  let size = zone.utcoffset(utc) || 0;
  size = zone.utcoffset(add(utc, size)) || size;
  return add(utc, size);
}

function wholeDays(start, end) {
  return end > start && timeOf(start) === 0 && timeOf(end) === 0;
}

function existingKey(title, start, end) {
  return JSON.stringify([title, start, end]);
}

export function planImport(text, existing = [], now = null) {
  const nowWall = dateToWall(now || new Date());
  const windowStart = add(nowWall, -days(PAST_DAYS));
  const windowEnd = add(nowWall, days(FUTURE_DAYS));
  const root = tree(text);
  const zones = new Map();
  for (const comp of walk(root, "VTIMEZONE")) {
    const tzid = pyStrip(comp.value("TZID"));
    if (tzid) zones.set(tzid, new Zone(comp));
  }
  const calendar = walk(root, "VCALENDAR").find((c) => c.value("X-WR-CALNAME"));
  const name = calendar ? unescapeText(calendar.value("X-WR-CALNAME")) : "";
  const counts = { duplicates: 0, outside: 0, cancelled: 0, unsupported: 0 };

  function when(prop) {
    if (!prop) return null;
    const [, params, value] = prop;
    const found = stamp(value);
    if (found.wall === null) return null;
    if (found.isDate) return ["date", found.wall, null];
    if (found.utc) return ["time", found.wall, "utc"];
    const tzid = pyStrip(params.has("TZID") ? params.get("TZID") : "");
    const zone = tzid ? zones.get(tzid) || namedZone(tzid) : null;
    return ["time", found.wall, zone];
  }

  function keyOf(moment) {
    const [kind, wall, zone] = moment;
    if (kind === "date") return fmtDate(wall);
    return fmtStamp(toLocal(wall, zone));
  }

  function details(ev) {
    const title = unescapeText(ev.value("SUMMARY")) || "Untitled event";
    let notes = unescapeText(ev.value("DESCRIPTION"));
    const location = unescapeText(ev.value("LOCATION"));
    if (location) notes = (notes ? notes + "\n\n" : "") + "Location: " + location;
    return [title, notes || null];
  }

  function span(ev, begin) {
    const [kind, wall, zone] = begin;
    const finish = when(ev.get("DTEND")) || when(ev.get("DUE"));
    let size;
    if (finish) {
      size = kind === "date" ? finish[1] - wall : toLocal(finish[1], finish[2]) - toLocal(wall, zone);
    } else {
      size = ev.get("DURATION") ? duration(ev.value("DURATION")) : null;
    }
    if (size === null || size <= 0) size = kind === "date" ? DAY : HOUR;
    return size;
  }

  function instance(ev, begin, size) {
    const [kind, wall, zone] = begin;
    const [start, startMs] = kind === "date" ? [wall, null] : toLocalExact(wall, zone);
    const end = kind === "date" ? add(start, days(Math.max(1, pyRound(size / DAY)))) : add(start, size);
    return [...details(ev), start, end, startMs];
  }

  function cancelled(ev) {
    return pyStrip(ev.value("STATUS")).toUpperCase() === "CANCELLED";
  }

  const found = [];
  const singles = [];
  const masters = new Map();
  const overrides = new Map();
  for (const ev of walk(root, "VEVENT")) {
    const uid = pyStrip(ev.value("UID"));
    if (ev.get("RECURRENCE-ID") && uid) {
      if (!overrides.has(uid)) overrides.set(uid, []);
      overrides.get(uid).push(ev);
    } else if (ev.get("RRULE")) {
      masters.set(uid || `no-uid-${masters.size}`, ev);
    } else {
      singles.push(ev);
    }
  }

  for (const ev of singles) {
    const begin = when(ev.get("DTSTART"));
    if (!begin) continue;
    if (cancelled(ev)) {
      counts.cancelled += 1;
      continue;
    }
    found.push(instance(ev, begin, span(ev, begin)));
  }

  for (const [uid, ev] of masters) {
    const begin = when(ev.get("DTSTART"));
    if (!begin) continue;
    if (cancelled(ev)) {
      counts.cancelled += 1;
      continue;
    }
    const [kind, wall, zone] = begin;
    const size = span(ev, begin);
    const moved = new Map();
    const mine = overrides.has(uid) ? overrides.get(uid) : [];
    overrides.delete(uid);
    for (const override of mine) {
      const original = when(override.get("RECURRENCE-ID"));
      if (original) moved.set(keyOf(original), override);
    }
    const skippedDates = new Set();
    const skippedTimes = new Set();
    for (const prop of ev.all("EXDATE")) {
      for (const item of prop[2].split(",")) {
        const moment = when([prop[0], prop[1], item]);
        if (moment) (moment[0] === "date" ? skippedDates : skippedTimes).add(keyOf(moment));
      }
    }
    const rule = parseRule(ev.value("RRULE"));
    const untilStamp = stamp(ruleGet(rule, "UNTIL", ""));
    let until = untilStamp.wall;
    if (until !== null && untilStamp.isDate) until = add(until, 23 * HOUR + 59 * 60 * SECOND + 59 * SECOND);
    else if (until !== null && untilStamp.utc && kind === "time") until = fromUtc(until, zone);
    const margin = days(2);
    let walls;
    try {
      walls = expand(wall, rule, until, add(add(windowStart, -margin), -size), add(windowEnd, margin));
    } catch (exc) {
      if (!(exc instanceof ValueError)) throw exc;
      counts.unsupported += 1;
      walls = [wall];
    }
    for (const prop of ev.all("RDATE")) {
      for (const item of prop[2].split(",")) {
        const moment = when([prop[0], prop[1], item]);
        if (moment && !walls.includes(moment[1])) walls.push(moment[1]);
      }
    }
    for (const occurrenceWall of numSort(walls)) {
      const moment = [kind, occurrenceWall, zone];
      const key = keyOf(moment);
      if (skippedTimes.has(key) || skippedDates.has(key.slice(0, 8))) continue;
      const override = moved.has(key) ? moved.get(key) : null;
      moved.delete(key);
      if (override !== null) {
        if (cancelled(override)) {
          counts.cancelled += 1;
          continue;
        }
        const overrideBegin = when(override.get("DTSTART")) || moment;
        found.push(instance(override, overrideBegin, span(override, overrideBegin)));
      } else {
        found.push(instance(ev, moment, size));
      }
    }
    for (const override of moved.values()) {
      if (cancelled(override)) continue;
      const overrideBegin = when(override.get("DTSTART"));
      if (overrideBegin) found.push(instance(override, overrideBegin, span(override, overrideBegin)));
    }
  }

  for (const leftovers of overrides.values()) {
    for (const ev of leftovers) {
      const begin = when(ev.get("DTSTART"));
      if (!begin || cancelled(ev)) continue;
      found.push(instance(ev, begin, span(ev, begin)));
    }
  }

  const events = [];
  const seen = new Set();
  for (const item of existing) seen.add(typeof item === "string" ? item : existingKey(item[0], item[1], item[2]));
  for (const [title, notes, start, end, exact] of [...found].sort((a, b) => a[2] - b[2])) {
    if (end <= windowStart || start >= windowEnd) {
      counts.outside += 1;
      continue;
    }
    const startMs = exact !== null ? exact : wallToLocalMs(start);
    const endMs = wallToLocalMs(end);
    const key = existingKey(title, startMs, endMs);
    if (seen.has(key)) {
      counts.duplicates += 1;
      continue;
    }
    seen.add(key);
    events.push([title, notes, new Date(startMs), new Date(endMs)]);
  }
  return { name, events, ...counts };
}

function escapeText(value) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n/g, "\n").replace(/\n/g, "\\n");
}

function utf8Width(cp) {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

function fold(line) {
  if (Buffer.byteLength(line, "utf-8") <= 75) return line;
  const pieces = [];
  let current = "";
  let size = 0;
  let limit = 75;
  for (const ch of line) {
    const width = utf8Width(ch.codePointAt(0));
    if (size + width > limit) {
      pieces.push(current);
      current = "";
      size = 0;
      limit = 74;
    }
    current += ch;
    size += width;
  }
  pieces.push(current);
  return pieces.join("\r\n ");
}

function utcStamp(ms) {
  const d = new Date(Math.floor(Number(ms) / SECOND) * SECOND);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export function exportCalendar(rows, name = "Planizo", now = null) {
  const stampNow = utcStamp((now || new Date()).getTime());
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Clipizo//Planizo//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:" + escapeText(name)];
  for (const row of rows) {
    const start = fromTimestamp(Number(row.startAt));
    const end = fromTimestamp(Number(row.endAt));
    out.push("BEGIN:VEVENT", `UID:${pyStr(row.id)}@calendizo`, `DTSTAMP:${stampNow}`);
    if (wholeDays(start, end)) out.push(`DTSTART;VALUE=DATE:${fmtDate(start)}`, `DTEND;VALUE=DATE:${fmtDate(end)}`);
    else out.push(`DTSTART:${utcStamp(row.startAt)}`, `DTEND:${utcStamp(row.endAt)}`);
    out.push("SUMMARY:" + escapeText(truthy(row.title) ? row.title : "Untitled event"));
    if (truthy(row.notes)) out.push("DESCRIPTION:" + escapeText(row.notes));
    if (truthy(row.updatedAt)) out.push("LAST-MODIFIED:" + utcStamp(Math.trunc(Number(row.updatedAt))));
    out.push("END:VEVENT");
  }
  out.push("END:VCALENDAR");
  return Buffer.from(out.map(fold).join("\r\n") + "\r\n", "utf-8");
}

function codePointPrefix(text, count) {
  if (text.length <= count) return text;
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (n >= count) break;
    out += ch;
    n += 1;
  }
  return out;
}

function codePointLength(text) {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

function pyTypeName(value) {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return typeof value;
}

function pyIter(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  if (value && typeof value === "object") return Object.keys(value);
  throw new TypeError(`'${pyTypeName(value)}' object is not iterable`);
}

export function register(deps) {
  function oneOffRows(columns) {
    const { db, userId } = deps();
    return db.sql.all(`SELECT ${columns} FROM Event e WHERE e.deleted = 0 AND e.userId = ? AND ${ONE_OFF} ORDER BY e.startAt`, [userId]);
  }

  route("POST", "/api/ics/import", (ctx) => {
    const text = ctx.b("text");
    if (typeof text !== "string" || !codePointPrefix(text, 20000).toUpperCase().includes("BEGIN:VCALENDAR")) {
      throw new ApiError(400, "That isn't a calendar file (.ics).");
    }
    if (text.length > MAX_TEXT && codePointLength(text) > MAX_TEXT) throw new ApiError(413, "That calendar file is too big to import.");
    const existing = new Set(
      oneOffRows("e.title, e.startAt, e.endAt").map((r) => existingKey(r.title, Math.trunc(Number(r.startAt)), Math.trunc(Number(r.endAt)))),
    );
    const plan = planImport(text, existing);
    const result = {};
    for (const key of ["name", "duplicates", "outside", "cancelled", "unsupported"]) result[key] = plan[key];
    result.events = plan.events.length;
    if (truthy(ctx.b("preview"))) return result;
    const { db, userId } = deps();
    const now = Date.now();
    const ids = [];
    db.sql.tx(() => {
      for (const [title, notes, start, end] of plan.events) {
        const eventId = uuidHex();
        db.sql.run(
          "INSERT INTO Event (id, userId, title, notes, startAt, endAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [eventId, userId, title, notes, start.getTime(), end.getTime(), now, now],
        );
        ids.push(eventId);
      }
    });
    result.ids = ids;
    return result;
  });

  route("POST", "/api/ics/remove", (ctx) => {
    const raw = ctx.b("ids");
    const ids = (truthy(raw) ? pyIter(raw) : []).filter((i) => typeof i === "string");
    const { db, userId } = deps();
    db.sql.tx(() => {
      for (const i of ids) db.sql.run("UPDATE Event SET deleted = 1 WHERE id = ? AND userId = ?", [i, userId]);
    });
    return { removed: ids.length };
  });

  route("GET", "/api/ics/export", () => {
    const rows = oneOffRows("e.id, e.title, e.notes, e.startAt, e.endAt, e.updatedAt");
    const filename = `Planizo-${strftime(new Date(), "%Y-%m-%d")}.ics`;
    return new Raw(exportCalendar(rows), "text/calendar; charset=utf-8", { "Content-Disposition": `attachment; filename="${filename}"` });
  });
}
