import fs from "node:fs";
import path from "node:path";
import { route, ApiError, Stream } from "./http.js";
import { dateKey, startOfDay } from "./core/dates.js";
import { jsWeekday } from "./core/recurrence.js";
import { protect as protectSecret, unprotect as unprotectSecret } from "./core/secretBox.js";
import { isoLocal, shift, replace, truthy as baseTruthy, sorted, compare, uuidHex, strftime, ValueError } from "./py.js";

const truthy = (v) => (typeof v === "number" && Number.isNaN(v)) || baseTruthy(v);

export const API_URL = "https://api.deepseek.com/chat/completions";
export const SUPPORTED_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];
export const DEFAULT_MODEL = "deepseek-v4-pro";
export const APPROVAL_SECONDS = 20;
export const SNAPSHOT_PAST_DAYS = 30;
export const SNAPSHOT_FUTURE_DAYS = 180;

export const COLORS = {
  red: "#ff3b3b", orange: "#ff8c1a", yellow: "#ffd60a", green: "#30d158", blue: "#0a84ff",
  purple: "#7b3ff2", pink: "#ff2d92", sky: "#64d2ff", taupe: "#ac8c68", rose: "#ff375f",
};

const CURATED = [
  ["Red", "#ff3b3b"], ["Orange", "#ff8c1a"], ["Yellow", "#ffd60a"], ["Green", "#30d158"], ["Blue", "#0a84ff"],
  ["Purple", "#7b3ff2"], ["Pink", "#ff2d92"], ["Sky", "#64d2ff"], ["Taupe", "#ac8c68"], ["Rose", "#ff375f"],
];

function tool(name, description, properties, required) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

export const AGENT_TOOLS = [
  tool("create_event", "Create a one-off calendar event. For an all-day or multi-day event (holiday, deadline day, shoot days), use 00:00 on the first day as start and 00:00 on the day after the last day as end.", {
    title: { type: "string" },
    start: { type: "string", description: "Local ISO datetime." },
    end: { type: "string", description: "Local ISO datetime after start." },
    notes: { type: "string" },
  }, ["title", "start", "end"]),
  tool("update_event", "Update an existing one-off event using its snapshot ID.", {
    event_id: { type: "string" },
    title: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    notes: { type: "string" },
  }, ["event_id", "title", "start", "end"]),
  tool("delete_event", "Delete a one-off event or routine using its snapshot ID.", {
    event_id: { type: "string" },
  }, ["event_id"]),
  tool("create_due_task", "Create a standalone to-do shown under Due > Tasks. Do not use this for a task or block requested in free or empty routine time; use save_routine for that.", {
    title: { type: "string" },
    due_date: { type: "string", description: "YYYY-MM-DD." },
    time: { type: "string", description: "Optional 24-hour HH:MM. Required for a free-time or empty-time placement request." },
  }, ["title", "due_date"]),
  tool("delete_task", "Delete a task using its snapshot ID.", {
    task_id: { type: "string" },
  }, ["task_id"]),
  tool("set_task_completion", "Set a task occurrence complete or incomplete.", {
    task_id: { type: "string" },
    date: { type: "string", description: "YYYY-MM-DD occurrence date." },
    completed: { type: "boolean" },
  }, ["task_id", "date", "completed"]),
  tool("set_event_completion", "Set an event or routine occurrence complete or incomplete.", {
    event_id: { type: "string" },
    date: { type: "string", description: "YYYY-MM-DD occurrence date." },
    completed: { type: "boolean" },
  }, ["event_id", "date", "completed"]),
  tool("set_event_color", "Set the display color of a one-off event or recurring routine using its snapshot ID.", {
    event_id: { type: "string" },
    color: { type: "string", enum: Object.keys(COLORS) },
  }, ["event_id", "color"]),
  tool("save_routine", "Create or fully update a recurring routine schedule task/block. Use this when the user asks to add a task in free or empty time. Omit routine_id to create one. To make a weekday routine apply every day, keep its routine_id and use frequency daily with an empty weekdays array. A day-specific (exception-day) routine that replaces the normal schedule on one date is created with frequency=weekly, weekdays=[that date's weekday], start_date and end_date both set to that date.", {
    routine_id: { type: "string" },
    title: { type: "string" },
    start_time: { type: "string", description: "24-hour HH:MM." },
    end_time: { type: "string", description: "24-hour HH:MM." },
    frequency: { type: "string", enum: ["daily", "weekly"] },
    weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "Sunday=0 through Saturday=6." },
    start_date: { type: "string", description: "Optional YYYY-MM-DD." },
    end_date: { type: "string", description: "Optional YYYY-MM-DD." },
    fill_empty_time: { type: "boolean", description: "Set true when the user asks to fill the entire empty/free routine range." },
    notes: { type: "string" },
    checklist: { type: "array", items: { type: "string" } },
  }, ["title", "start_time", "end_time", "frequency"]),
  tool("create_content", "Create a Content Tracker item.", {
    title: { type: "string" },
    kind: { type: "string", enum: ["upload", "tool", "research"] },
    status: { type: "string", enum: ["idea", "working", "scheduled", "done"] },
    scheduled_date: { type: "string", description: "Optional YYYY-MM-DD." },
    notes: { type: "string" },
  }, ["title", "kind", "status"]),
  tool("update_content", "Update fields on an existing Content Tracker item.", {
    content_id: { type: "string" },
    title: { type: "string" },
    kind: { type: "string", enum: ["upload", "tool", "research"] },
    status: { type: "string", enum: ["idea", "working", "scheduled", "done"] },
    scheduled_date: { type: "string" },
    notes: { type: "string" },
  }, ["content_id"]),
  tool("delete_content", "Delete a Content Tracker item using its snapshot ID.", {
    content_id: { type: "string" },
  }, ["content_id"]),
  tool("add_note", "Add a note to a Planizo day.", {
    date: { type: "string", description: "YYYY-MM-DD." },
    title: { type: "string" },
    text: { type: "string" },
  }, ["date", "text"]),
  tool("set_email_read", "Mark a Work Mail message read or unread using its UID from the snapshot.", {
    uid: { type: "integer" },
    read: { type: "boolean" },
  }, ["uid", "read"]),
  tool("create_script", "Create and open a script in the current Whiteboard board.", {
    title: { type: "string" },
    text: { type: "string" },
  }, ["title"]),
];

export const SYSTEM_PROMPT =
  "You are Botizo, the built-in AI assistant for the private single-user Planizo app. " +
  "Use the complete current app snapshot below to answer questions. Never invent record IDs. " +
  "One-off events outside semantic.one_off_event_window are left out of the snapshot; if the user asks about them, say they are outside the dates you can see. " +
  "All mutations must use provided tools and each related tool-call batch requires explicit user approval. " +
  "When the user requests a change, call the appropriate tool instead of only explaining how to do it. " +
  "Plan the complete requested mutation first, then return all related tool calls together in one assistant response so the user can approve them as one batch. " +
  "Do not create extra cleanup tool calls in later turns unless a tool result reports a failure that requires correction. " +
  "Keep final answers concise. After a tool result, clearly state what changed or explain any failure. " +
  "For routine updates, preserve omitted notes/checklists and use frequency=daily with weekdays=[] when a routine should apply every day. " +
  "A task requested in free or empty routine time means a routine schedule block, not a Due to-do: inspect that day's routine, choose an unoccupied range, and use save_routine. " +
  "If the user says to add or fill a task in 'the empty time' without requesting a duration, use the entire contiguous empty range from its start through its end and set fill_empty_time=true; never shorten it to one hour or only the remaining portion after the current time. " +
  "For a named day or today, use frequency=weekly with that weekday unless the user asks for every day. Use create_due_task only for explicit to-do or due-task requests. " +
  "DAY-SPECIFIC (EXCEPTION-DAY) ROUTINES: a routine whose recurrenceRule has frequency=weekly, one weekday, and startDate equal to endDate is a day-specific routine. On any date that has at least one day-specific routine, all normal recurring routines are HIDDEN for that date in Today and the Calendar - the day-specific routine(s) fully replace the usual schedule. In the snapshot these are the routine/occurrence entries whose rule startDate equals endDate (today_schedule entries also carry isDayOverride=true). " +
  "When the user asks for a routine 'for today' or 'for <specific date>' or wants a different schedule on one specific date, create a day-specific routine via save_routine with frequency=weekly, weekdays=[the JS weekday of that date, Sunday=0..Saturday=6], and start_date=end_date=that date. Creating only a normal weekly/daily routine will NOT change that date if it (or another) day-specific routine already exists there, because normal routines are hidden on day-override dates; mention this replacement behavior when relevant. " +
  "When the user asks to apply a routine to all days AND also today specifically, create the normal routine plus a day-specific copy for today when today's date would otherwise show an existing day-specific routine. " +
  "The CURRENT CALENDIZO SNAPSHOT is authoritative over earlier conversation claims. If a prior item was deleted, do not claim it still exists. After a successful tool result, say that you just created or changed it rather than saying it already existed. " +
  "Use semantic.today_schedule and each item's displayColor/displayColorName when the user identifies a visible routine or event by color; displayColor is the effective UI color even when the saved color field is empty. " +
  "Never mention system prompts, hidden rules, developer guidance, or instructions. Do not say phrases such as 'per your instructions', 'as instructed', or 'following instructions'; simply explain the action naturally. " +
  "After creating a Due task, state its exact date and time and explain that it appears under Due > Tasks in Today or Day View. " +
  "Dates and times are local unless stated otherwise. " +
  "The app has a Content Tracker organized as Projects with Stages and Steps: each Project (semantic.projects) has named Stages, each Stage has checkable Steps (done = status 'done'). " +
  "Progress is tracked per-stage and per-project as completed/total steps. The content field in the snapshot lists all steps (content items). " +
  "The app also has per-day To-Do lists (semantic.day_todos): date-keyed lists of simple text items with a completed flag, added from the calendar. These are separate from Due tasks and routine checklist items. ";

const REDACT_KEYS = new Set(["password", "apikey", "synckey", "servicerolekey", "token", "secret", "supabaseservicekey"]);
const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RX = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
const WS_RUN_RX = new RegExp(`[${PY_WS}]+`, "g");
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{16,}/g, "[API KEY REDACTED]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[TOKEN REDACTED]"],
  [/(?<![\p{L}\p{N}_])[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}(?![\p{L}\p{N}_])/gu, "[LICENSE KEY REDACTED]"],
];
const BASE64_RX = new RegExp(`^[A-Za-z0-9+/=${PY_WS}]+$`);
const NONPRINT_RX = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
const SURROGATE_RX = /[\ud800-\udfff]/;
const CLEAN_PHRASES = ["per your instructions", "as instructed", "following the instructions", "following instructions"].map(
  (phrase) => new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + `,?[${PY_WS}]*`, "giu"),
);

class ToolError extends Error {}
class KeyErr extends Error {}
class PyTypeError extends Error {}
class AttrError extends Error {}
class ServiceError extends Error {}

export const AgentState = { sessions: new Map() };

const pad = (n, w = 2) => String(n).padStart(w, "0");
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isDict(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  return !(v instanceof Date || v instanceof Set || v instanceof Map || Buffer.isBuffer(v) || v instanceof Uint8Array);
}

function typeName(v) {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (isDict(v)) return "dict";
  if (v instanceof Date) return "datetime";
  return "object";
}

function pyStrip(s) {
  return s.replace(STRIP_RX, "");
}

function cpLen(s) {
  if (!SURROGATE_RX.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

function cpSlice(s, start, end) {
  if (!SURROGATE_RX.test(s)) return s.slice(start, end);
  return Array.from(s).slice(start, end).join("");
}

function strRepr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (cp < 0x7f) out += ch;
    else if (NONPRINT_RX.test(ch)) {
      out += cp < 0x100 ? "\\x" + cp.toString(16).padStart(2, "0") : cp < 0x10000 ? "\\u" + cp.toString(16).padStart(4, "0") : "\\U" + cp.toString(16).padStart(8, "0");
    } else out += ch;
  }
  return out + quote;
}

function floatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (Number.isInteger(x)) return BigInt(x).toString();
  const [mant, expText] = x.toExponential().split("e");
  const exp = Number(expText);
  const negative = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  let body;
  if (exp < -4 || exp >= 16) {
    body = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (exp < 0 ? "-" : "+") + pad(Math.abs(exp));
  } else if (exp < 0) {
    body = "0." + "0".repeat(-exp - 1) + digits;
  } else {
    const whole = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
    const frac = digits.slice(exp + 1);
    body = whole + "." + (frac || "0");
  }
  return (negative ? "-" : "") + body;
}

function pyDateStr(d) {
  const ms = d.getMilliseconds();
  return isoLocal(d).replace("T", " ") + (ms ? "." + pad(ms, 3) + "000" : "");
}

function pyRepr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return floatRepr(v);
  if (typeof v === "string") return strRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (v instanceof Date) return strRepr(pyDateStr(v));
  if (typeof v === "object") return "{" + Object.keys(v).map((k) => `${strRepr(k)}: ${pyRepr(v[k])}`).join(", ") + "}";
  return String(v);
}

function pyStr(v) {
  if (typeof v === "string") return v;
  if (v instanceof Date) return pyDateStr(v);
  return pyRepr(v);
}

function pyCapitalize(s) {
  const cps = Array.from(s);
  if (!cps.length) return "";
  return cps[0].toUpperCase() + cps.slice(1).join("").toLowerCase();
}

function pyTitle(s) {
  let out = "";
  let prevCased = false;
  for (const ch of s) {
    const cased = ch.toLowerCase() !== ch.toUpperCase();
    out += prevCased ? ch.toLowerCase() : ch.toUpperCase();
    prevCased = cased;
  }
  return out;
}

function htmlEscape(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

function get(obj, key, fallback = null) {
  if (!isDict(obj)) throw new AttrError(`'${typeName(obj)}' object has no attribute 'get'`);
  return hasOwn(obj, key) ? obj[key] : fallback;
}

function item(obj, key) {
  if (isDict(obj)) {
    if (hasOwn(obj, key)) return obj[key];
    throw new KeyErr(strRepr(key));
  }
  if (Array.isArray(obj)) throw new PyTypeError("list indices must be integers or slices, not str");
  if (typeof obj === "string") throw new PyTypeError("string indices must be integers");
  throw new PyTypeError(`'${typeName(obj)}' object is not subscriptable`);
}

function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return Array.from(v);
  if (isDict(v)) return Object.keys(v);
  if (v instanceof Set || v instanceof Map) return [...v.keys()];
  throw new PyTypeError(`'${typeName(v)}' object is not iterable`);
}

function pySet(values) {
  const out = new Set();
  for (const v of pyIter(values)) {
    if (Array.isArray(v) || isDict(v)) throw new PyTypeError(`unhashable type: '${typeName(v)}'`);
    out.add(v);
  }
  return out;
}

function asciiDigits(text) {
  return text.replace(/\p{Nd}/gu, (ch) => {
    let start = ch.codePointAt(0);
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    return String((ch.codePointAt(0) - start) % 10);
  });
}

function pyIntText(text) {
  const stripped = asciiDigits(pyStrip(text));
  if (!/^[+-]?[0-9]+(?:_[0-9]+)*$/.test(stripped)) throw new ValueError(`invalid literal for int() with base 10: ${strRepr(text)}`);
  return Number(stripped.replaceAll("_", ""));
}

function pyInt(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new ValueError("cannot convert float NaN to integer");
    if (!Number.isFinite(v)) throw new Error("cannot convert float infinity to integer");
    return Math.trunc(v);
  }
  if (typeof v === "string") return pyIntText(v);
  throw new PyTypeError(`int() argument must be a string, a bytes-like object or a real number, not '${typeName(v)}'`);
}

function makeDate(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const d = new Date(2000, month - 1, day, hour, minute, second, ms);
  if (year >= 100) return new Date(year, month - 1, day, hour, minute, second, ms);
  d.setFullYear(year, month - 1, day);
  return d;
}

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function checkDateArgs(year, month, day) {
  if (year < 1 || year > 9999) throw new ValueError(`year ${year} is out of range`);
  if (month < 1 || month > 12) throw new ValueError("month must be in 1..12");
  if (day < 1 || day > daysInMonth(year, month)) throw new ValueError("day is out of range for month");
}

function pyDatetime(year, month, day) {
  checkDateArgs(year, month, day);
  return makeDate(year, month, day);
}

function parseDateKey(key) {
  if (typeof key !== "string") throw new AttrError(`'${typeName(key)}' object has no attribute 'split'`);
  const parts = key.split("-");
  if (parts.length < 3) throw new ValueError(`not enough values to unpack (expected 3, got ${parts.length})`);
  if (parts.length > 3) throw new ValueError("too many values to unpack (expected 3)");
  const year = pyIntText(parts[0]);
  const month = pyIntText(parts[1]);
  const day = pyIntText(parts[2]);
  return pyDatetime(year, month, day);
}

function charAt(s, i) {
  return i < s.length ? s[i] : "\0";
}

function parseDigits(s, i, n) {
  let value = 0;
  for (let k = 0; k < n; k += 1) {
    const c = charAt(s, i + k);
    if (c < "0" || c > "9") return null;
    value = value * 10 + (c.charCodeAt(0) - 48);
  }
  return { i: i + n, value };
}

function parseHhMmSsFf(s, start, end) {
  const vals = [0, 0, 0];
  let p = start;
  let micro = 0;
  for (let i = 0; i < 3; i += 1) {
    const r = parseDigits(s, p, 2);
    if (!r) return { rv: -3, vals, micro };
    vals[i] = r.value;
    p = r.i;
    const c = charAt(s, p);
    p += 1;
    if (p >= end) return { rv: c !== "\0" ? 1 : 0, vals, micro };
    if (c === ":") continue;
    if (c === ".") break;
    return { rv: -4, vals, micro };
  }
  const remains = end - p;
  if (!(remains === 6 || remains === 3)) return { rv: -3, vals, micro };
  const r = parseDigits(s, p, remains);
  if (!r) return { rv: -3, vals, micro };
  micro = remains === 3 ? r.value * 1000 : r.value;
  return { rv: charAt(s, r.i) !== "\0" ? 1 : 0, vals, micro };
}

function parseIsoTime(s) {
  const end = s.length;
  let tzPos = 0;
  do {
    const ch = charAt(s, tzPos);
    if (ch === "+" || ch === "-") break;
    tzPos += 1;
  } while (tzPos < end);
  const r = parseHhMmSsFf(s, 0, tzPos);
  if (r.rv < 0) return null;
  if (tzPos === end) return r.rv === 1 ? null : { time: r.vals, micro: r.micro, tz: null };
  const tzLen = end - tzPos;
  if (!(tzLen === 6 || tzLen === 9 || tzLen === 16)) return null;
  const sign = s[tzPos] === "-" ? -1 : 1;
  const t = parseHhMmSsFf(s, tzPos + 1, end);
  if (t.rv) return null;
  return { time: r.vals, micro: r.micro, tz: { seconds: sign * (t.vals[0] * 3600 + t.vals[1] * 60 + t.vals[2]), micro: sign * t.micro } };
}

function timedeltaRepr(totalMicro) {
  const day = 86400 * 1e6;
  const days = Math.floor(totalMicro / day);
  const rest = totalMicro - days * day;
  const seconds = Math.floor(rest / 1e6);
  const micro = rest - seconds * 1e6;
  const parts = [];
  if (days) parts.push(`days=${days}`);
  if (seconds) parts.push(`seconds=${seconds}`);
  if (micro) parts.push(`microseconds=${micro}`);
  return `datetime.timedelta(${parts.join(", ") || "0"})`;
}

function fromIsoFormat(text) {
  const invalid = () => new ValueError(`Invalid isoformat string: ${strRepr(text)}`);
  const cps = Array.from(text);
  for (let i = 0; i < cps.length; i += 1) {
    if (i !== 10 && cps[i].length === 1 && SURROGATE_RX.test(cps[i])) throw invalid();
  }
  if (cps.length < 10) throw invalid();
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(cps.slice(0, 10).join(""));
  if (!m) throw invalid();
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  let time = [0, 0, 0];
  let micro = 0;
  let tz = null;
  if (cps.length > 10) {
    const rest = cps.slice(11).join("");
    if (/[^\x00-\x7f]/.test(rest)) throw invalid();
    const parsed = parseIsoTime(rest);
    if (!parsed) throw invalid();
    ({ time, micro, tz } = parsed);
  }
  if (tz) {
    const total = tz.seconds * 1e6 + tz.micro;
    if (Math.abs(total) >= 86400 * 1e6) {
      throw new ValueError(`offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24), not ${timedeltaRepr(total)}.`);
    }
  }
  checkDateArgs(year, month, day);
  if (time[0] > 23) throw new ValueError("hour must be in 0..23");
  if (time[1] > 59) throw new ValueError("minute must be in 0..59");
  if (time[2] > 59) throw new ValueError("second must be in 0..59");
  if (!tz) return makeDate(year, month, day, time[0], time[1], time[2], Math.floor(micro / 1000));
  const wall = Date.UTC(2000, month - 1, day, time[0], time[1], time[2]);
  const base = new Date(wall);
  base.setUTCFullYear(year, month - 1, day);
  const instantMicro = base.getTime() * 1000 + micro - (tz.seconds * 1e6 + tz.micro);
  return new Date(Math.floor(instantMicro / 1000));
}

function jsonStrAscii(s) {
  const esc = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
  return '"' + s.replace(/[\\"]|[^\x20-\x7e]/g, (c) => esc[c] || "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + '"';
}

function pyDumps(v) {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
    return floatRepr(v);
  }
  if (typeof v === "string") return jsonStrAscii(v);
  if (v instanceof Date) return jsonStrAscii(pyDateStr(v));
  if (Array.isArray(v)) return v.length ? "[" + v.map(pyDumps).join(", ") + "]" : "[]";
  if (v instanceof Set) return pyDumps([...v]);
  if (typeof v === "object") {
    const keys = Object.keys(v);
    return keys.length ? "{" + keys.map((k) => `${jsonStrAscii(k)}: ${pyDumps(v[k])}`).join(", ") + "}" : "{}";
  }
  return jsonStrAscii(String(v));
}

function jsonError(msg, cps, pos) {
  let lineno = 1;
  let lastNl = -1;
  for (let i = 0; i < pos && i < cps.length; i += 1) {
    if (cps[i] === "\n") {
      lineno += 1;
      lastNl = i;
    }
  }
  return new ValueError(`${msg}: line ${lineno} column ${pos - lastNl} (char ${pos})`);
}

class StopScan {
  constructor(idx) {
    this.idx = idx;
  }
}

function scanJson(cps) {
  const n = cps.length;
  const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
  const skip = (i) => {
    while (i < n && isWs(cps[i])) i += 1;
    return i;
  };
  const hex = (c) => /^[0-9a-fA-F]$/.test(c);
  const scanString = (end) => {
    const begin = end - 1;
    let out = "";
    for (;;) {
      let next = end;
      let c = "";
      for (; next < n; next += 1) {
        c = cps[next];
        if (c === '"' || c === "\\") break;
        if (c.codePointAt(0) <= 0x1f) throw jsonError("Invalid control character at", cps, next);
      }
      if (next >= n || !(c === '"' || c === "\\")) throw jsonError("Unterminated string starting at", cps, begin);
      out += cps.slice(end, next).join("");
      if (c === '"') return [out, next + 1];
      next += 1;
      if (next === n) throw jsonError("Unterminated string starting at", cps, begin);
      c = cps[next];
      if (c !== "u") {
        end = next + 1;
        const map = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (!hasOwn(map, c)) throw jsonError("Invalid \\escape", cps, end - 2);
        out += map[c];
      } else {
        next += 1;
        end = next + 4;
        if (end >= n) throw jsonError("Invalid \\uXXXX escape", cps, next - 1);
        let code = 0;
        for (; next < end; next += 1) {
          if (!hex(cps[next])) throw jsonError("Invalid \\uXXXX escape", cps, end - 5);
          code = code * 16 + parseInt(cps[next], 16);
        }
        if (code >= 0xd800 && code <= 0xdbff && end + 6 < n && cps[next] === "\\" && cps[next + 1] === "u") {
          next += 2;
          end += 6;
          let low = 0;
          for (; next < end; next += 1) {
            if (!hex(cps[next])) throw jsonError("Invalid \\uXXXX escape", cps, end - 5);
            low = low * 16 + parseInt(cps[next], 16);
          }
          if (low >= 0xdc00 && low <= 0xdfff) code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          else end -= 6;
        }
        out += String.fromCodePoint(code);
      }
    }
  };
  const scanNumber = (start) => {
    let i = start;
    const digit = (k) => k < n && cps[k] >= "0" && cps[k] <= "9";
    if (cps[i] === "-") {
      i += 1;
      if (i >= n) throw new StopScan(start);
    }
    if (cps[i] >= "1" && cps[i] <= "9") {
      i += 1;
      while (digit(i)) i += 1;
    } else if (cps[i] === "0") {
      i += 1;
    } else throw new StopScan(start);
    if (i < n - 1 && cps[i] === "." && digit(i + 1)) {
      i += 2;
      while (digit(i)) i += 1;
    }
    if (i < n - 1 && (cps[i] === "e" || cps[i] === "E")) {
      const eStart = i;
      i += 1;
      if (i < n - 1 && (cps[i] === "-" || cps[i] === "+")) i += 1;
      while (digit(i)) i += 1;
      if (!(cps[i - 1] >= "0" && cps[i - 1] <= "9")) i = eStart;
    }
    return [Number(cps.slice(start, i).join("")), i];
  };
  const word = (i, text) => cps.slice(i, i + text.length).join("") === text;
  const scanOnce = (i) => {
    if (i >= n) throw new StopScan(i);
    const c = cps[i];
    if (c === '"') return scanString(i + 1);
    if (c === "{") return scanObject(i + 1);
    if (c === "[") return scanArray(i + 1);
    if (c === "n" && word(i, "null")) return [null, i + 4];
    if (c === "t" && word(i, "true")) return [true, i + 4];
    if (c === "f" && word(i, "false")) return [false, i + 5];
    if (c === "N" && word(i, "NaN")) return [NaN, i + 3];
    if (c === "I" && word(i, "Infinity")) return [Infinity, i + 8];
    if (c === "-" && word(i, "-Infinity")) return [-Infinity, i + 9];
    return scanNumber(i);
  };
  const scanObject = (i) => {
    const out = {};
    i = skip(i);
    if (i >= n || cps[i] !== "}") {
      for (;;) {
        if (i >= n || cps[i] !== '"') throw jsonError("Expecting property name enclosed in double quotes", cps, i);
        const [key, afterKey] = scanString(i + 1);
        i = skip(afterKey);
        if (i >= n || cps[i] !== ":") throw jsonError("Expecting ':' delimiter", cps, i);
        i = skip(i + 1);
        const [value, afterValue] = scanOnce(i);
        out[key] = value;
        i = skip(afterValue);
        if (i < n && cps[i] === "}") break;
        if (i >= n || cps[i] !== ",") throw jsonError("Expecting ',' delimiter", cps, i);
        i = skip(i + 1);
      }
    }
    return [out, i + 1];
  };
  const scanArray = (i) => {
    const out = [];
    i = skip(i);
    if (i >= n || cps[i] !== "]") {
      for (;;) {
        const [value, after] = scanOnce(i);
        out.push(value);
        i = skip(after);
        if (i < n && cps[i] === "]") break;
        if (i >= n || cps[i] !== ",") throw jsonError("Expecting ',' delimiter", cps, i);
        i = skip(i + 1);
      }
    }
    return [out, i + 1];
  };
  let value;
  let end;
  try {
    [value, end] = scanOnce(skip(0));
  } catch (exc) {
    if (exc instanceof StopScan) throw jsonError("Expecting value", cps, exc.idx);
    throw exc;
  }
  end = skip(end);
  if (end !== n) throw jsonError("Extra data", cps, end);
  return value;
}

function pyJsonLoads(text) {
  if (text.startsWith("﻿")) throw jsonError("Unexpected UTF-8 BOM (decode using utf-8-sig)", Array.from(text), 0);
  try {
    return JSON.parse(text);
  } catch {
    return scanJson(Array.from(text));
  }
}

function toPlain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return pyDateStr(v);
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof Set) return [...v].map(toPlain);
  if (v instanceof Map) {
    const out = {};
    for (const [k, x] of v) out[String(k)] = toPlain(x);
    return out;
  }
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = toPlain(v[k]);
    return out;
  }
  return v;
}

function awareIso(d, withMicro) {
  const offset = -d.getTimezoneOffset();
  const abs = Math.abs(offset);
  const tz = `${offset >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return isoLocal(d) + (withMicro ? "." + pad(d.getMilliseconds(), 3) + "000" : "") + tz;
}

function routineColorMap(templates) {
  const titles = [...new Set(templates.map((t) => pyStrip(get(t, "title") || "")))].sort((a, b) => compareCodePoints(a, b));
  const used = new Set();
  const palette = CURATED.map(([, hex]) => hex);
  const mapping = new Map();
  for (const title of titles) {
    let free = palette.filter((c) => !used.has(c));
    if (!free.length) {
      used.clear();
      free = palette;
    }
    mapping.set(title, free[0]);
    used.add(free[0]);
  }
  return mapping;
}

function compareCodePoints(a, b) {
  if (!SURROGATE_RX.test(a) && !SURROGATE_RX.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

function displayColor(itemValue, colorMap, index = 0) {
  if (truthy(get(itemValue, "color"))) return itemValue.color;
  const title = pyStrip(get(itemValue, "title") || "");
  if (colorMap.has(title)) return colorMap.get(title);
  return CURATED[index % CURATED.length][1];
}

function colorName(hexValue) {
  for (const [name, value] of CURATED) {
    if (value.toLowerCase() === String(hexValue || "").toLowerCase()) return name;
  }
  return "";
}

function realResolve(target) {
  const abs = path.resolve(target);
  try {
    return fs.realpathSync.native(abs);
  } catch {}
  const tail = [];
  let head = abs;
  for (;;) {
    const parent = path.dirname(head);
    if (parent === head) return abs;
    tail.unshift(path.basename(head));
    head = parent;
    try {
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch {}
  }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  if (!rel || rel === ".") return false;
  return !(path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep));
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function rglobBoards(folder) {
  const found = [];
  const seen = new Set();
  const matches = (name) => (process.platform === "win32" ? name.toLowerCase() : name).endsWith(".cwboard");
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches(entry.name)) {
        const full = path.join(dir, entry.name);
        if (!seen.has(full)) {
          seen.add(full);
          found.push(full);
        }
      }
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(folder);
  return found;
}

function readJson(file, fallback) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
    const value = pyJsonLoads(text.replace(/\r\n?/g, "\n"));
    if (Array.isArray(fallback)) return Array.isArray(value) ? value : fallback;
    return isDict(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const pending = file + ".tmp";
  const replacer = function (key, val) {
    const raw = this[key];
    if (raw instanceof Date) return pyDateStr(raw);
    return val;
  };
  fs.writeFileSync(pending, JSON.stringify(value, replacer, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(pending, file);
}

function contentShown(m) {
  const content = get(m, "content");
  return typeof content === "string" ? pyStrip(content) !== "" : truthy(content);
}

function visibleMessages(messages) {
  return messages
    .filter((m) => ["user", "assistant"].includes(get(m, "role")) && contentShown(m) && get(m, "content") !== "No changes were made.")
    .map((m) => ({ role: m.role, content: m.content }));
}

export function register(deps) {
  const dataDir = () => path.resolve(String(deps().dataDir));

  const protect = (secret) => protectSecret(secret);
  const unprotect = (blob) => {
    if (typeof blob !== "string") throw new Error("locked");
    return unprotectSecret(blob);
  };

  const configPath = () => path.join(dataDir(), "deepseek-agent.json");
  const config = () => readJson(configPath(), {});

  const modelName = () => {
    const cfg = config();
    const value = truthy(get(cfg, "model")) ? cfg.model : DEFAULT_MODEL;
    return SUPPORTED_MODELS.includes(value) ? value : DEFAULT_MODEL;
  };

  const chatsPath = () => path.join(dataDir(), "agent-chats.json");

  const loadHistory = () => {
    const history = readJson(chatsPath(), {});
    const chats = [];
    const rawChats = get(history, "chats");
    for (const chat of truthy(rawChats) ? pyIter(rawChats) : []) {
      if (!isDict(chat) || !truthy(get(chat, "id"))) continue;
      const rawMessages = get(chat, "messages");
      const messages = (truthy(rawMessages) ? pyIter(rawMessages) : [])
        .filter((m) => isDict(m) && ["user", "assistant"].includes(get(m, "role")) && contentShown(m))
        .map((m) => ({ role: m.role, content: m.content }));
      chats.push({ ...chat, messages });
    }
    const active = get(history, "active_id");
    return { version: 1, active_id: truthy(active) ? active : "", chats };
  };

  const saveHistory = (history) => writeJson(chatsPath(), history);

  const stamp = () => awareIso(new Date(), false);

  const newChat = (history) => {
    const chat = { id: uuidHex(), title: "New chat", created_at: stamp(), updated_at: stamp(), messages: [] };
    history.chats.unshift(chat);
    history.active_id = chat.id;
    return chat;
  };

  const findChat = (history, chatId) => {
    for (const chat of history.chats) {
      if (chat.id === chatId) return chat;
    }
    throw new ApiError(404, "Chat not found.");
  };

  const autoTitle = (chat) => {
    if (truthy(get(chat, "renamed"))) return;
    const firstUser = chat.messages.find((m) => m.role === "user");
    const first = firstUser ? firstUser.content : "";
    const text = pyStrip(String(first).replace(WS_RUN_RX, " "));
    chat.title = cpLen(text) > 44 ? cpSlice(text, 0, 41) + "..." : text || "New chat";
  };

  const session = (chatId, history = null) => {
    let existing = AgentState.sessions.get(chatId);
    if (existing === undefined) {
      const source = history || loadHistory();
      const chat = source.chats.find((c) => c.id === chatId) || null;
      existing = {
        messages: (chat ? chat.messages : []).map((m) => ({ ...m })),
        pending: null,
        busy: false,
        undo: null,
        proposedAt: 0.0,
      };
      AgentState.sessions.set(chatId, existing);
    }
    return existing;
  };

  const persist = (chatId, sess) => {
    const history = loadHistory();
    const chat = history.chats.find((c) => c.id === chatId) || null;
    if (chat === null) return;
    chat.messages = visibleMessages(sess.messages);
    autoTitle(chat);
    chat.updated_at = stamp();
    history.active_id = chatId;
    saveHistory(history);
  };

  const updatedKey = (c) => {
    const value = get(c, "updated_at");
    return truthy(value) ? value : "";
  };

  const summaryList = (history) => {
    const chats = sorted(history.chats, updatedKey, true);
    return chats.map((c) => ({ id: c.id, title: truthy(get(c, "title")) ? c.title : "New chat", updatedAt: get(c, "updated_at") }));
  };

  route("GET", "/api/agent/state", () => {
    const history = loadHistory();
    if (!history.chats.length) {
      newChat(history);
      saveHistory(history);
    }
    let active = history.active_id;
    if (!history.chats.some((c) => c.id === active)) active = sorted(history.chats, updatedKey, true)[0].id;
    return { configured: truthy(get(config(), "api_key")), model: modelName(), chats: summaryList(history), activeId: active, secure: true };
  });

  route("POST", "/api/agent/key", (ctx) => {
    const raw = ctx.b("key");
    const key = pyStrip(pyStr(truthy(raw) ? raw : ""));
    if (!key) throw new ApiError(400, "Enter an API key.");
    const model = SUPPORTED_MODELS.includes(ctx.b("model")) ? ctx.b("model") : modelName();
    writeJson(configPath(), { version: 1, provider: "deepseek", model, api_key: protect(key) });
    return null;
  });

  route("DELETE", "/api/agent/key", () => {
    try {
      fs.unlinkSync(configPath());
    } catch {}
    return null;
  });

  route("POST", "/api/agent/chats", () => {
    const history = loadHistory();
    const chat = newChat(history);
    saveHistory(history);
    return { id: chat.id, chats: summaryList(history) };
  });

  route("GET", "/api/agent/chats/([\\w-]+)", (ctx) => {
    const chatId = ctx.arg(1);
    const history = loadHistory();
    const chat = findChat(history, chatId);
    history.active_id = chatId;
    saveHistory(history);
    const sess = session(chatId, history);
    return {
      id: chatId,
      title: get(chat, "title"),
      messages: visibleMessages(sess.messages),
      pending: truthy(sess.pending),
      undoAvailable: sess.undo !== null && sess.undo !== undefined,
    };
  });

  route("PUT", "/api/agent/chats/([\\w-]+)", (ctx) => {
    const history = loadHistory();
    const chat = findChat(history, ctx.arg(1));
    const raw = ctx.b("title");
    const title = cpSlice(pyStrip(pyStr(truthy(raw) ? raw : "")), 0, 60);
    if (title) {
      chat.title = title;
      chat.renamed = true;
      saveHistory(history);
    }
    return { chats: summaryList(history) };
  });

  route("DELETE", "/api/agent/chats/([\\w-]+)", (ctx) => {
    const chatId = ctx.arg(1);
    const history = loadHistory();
    history.chats = history.chats.filter((c) => c.id !== chatId);
    AgentState.sessions.delete(chatId);
    if (!history.chats.length) newChat(history);
    if (history.active_id === chatId) history.active_id = history.chats[0].id;
    saveHistory(history);
    return { activeId: history.active_id, chats: summaryList(history) };
  });

  const sanitize = (value, key = "") => {
    const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (REDACT_KEYS.has(normalized)) return "[REDACTED]";
    if (isDict(value)) {
      const out = {};
      for (const k of Object.keys(value)) out[k] = sanitize(value[k], k);
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => sanitize(v));
    if (typeof value === "string") {
      if (value.length > 20000) {
        const length = cpLen(value);
        if (length > 20000 && BASE64_RX.test(cpSlice(value, 0, 2000))) return `[BINARY DATA OMITTED: ${length} characters]`;
      }
      for (const [rx, replacement] of SECRET_PATTERNS) value = value.replace(rx, replacement);
    }
    return value;
  };

  const buildSnapshot = () => {
    const { db, mailState } = deps();
    const templates = db.getRoutineTemplates();
    const cmap = routineColorMap(templates);
    templates.forEach((t, index) => {
      t.displayColor = displayColor(t, cmap, index);
      t.displayColorName = colorName(t.displayColor);
    });
    let events = db.getEventsWithChecklists();
    for (const e of events) {
      let color = get(e, "color");
      if (!truthy(color)) color = truthy(get(e, "recurrenceRule")) ? (cmap.has(pyStrip(get(e, "title") || "")) ? cmap.get(pyStrip(get(e, "title") || "")) : null) : null;
      e.displayColor = color;
      e.displayColorName = colorName(truthy(color) ? color : "");
    }
    const today = db.occurrencesForDay(new Date());
    for (const occ of today) {
      let color = get(occ, "color");
      if (!truthy(color)) color = truthy(get(occ, "isRecurring")) ? (cmap.has(pyStrip(get(occ, "title") || "")) ? cmap.get(pyStrip(get(occ, "title") || "")) : null) : null;
      occ.displayColor = color;
      occ.displayColorName = colorName(truthy(color) ? color : "");
    }
    const projects = [];
    const items = db.getContentItems();
    for (const project of db.getProjects()) {
      const stages = [];
      for (const stage of db.getStages(project.id)) {
        const steps = items
          .filter((i) => get(i, "stageId") === stage.id && !truthy(get(i, "parentStepId")))
          .map((i) => ({ id: i.id, title: i.title, status: i.status }));
        const done = steps.filter((s) => s.status === "done").length;
        stages.push({ id: stage.id, name: stage.name, steps, progress: `${done}/${steps.length}` });
      }
      projects.push({ id: project.id, name: project.name, status: project.status, stages });
    }
    const todoDates = sorted([...db.dayTodoDates()]).slice(-7);
    const user = { ...(db.getUser() || {}) };
    delete user.supabaseServiceKey;
    delete user.passwordHash;
    const database = db.exportData();
    const now = new Date();
    const windowFrom = shift(now, { days: -SNAPSHOT_PAST_DAYS });
    const windowTo = shift(now, { days: SNAPSHOT_FUTURE_DAYS });
    const low = Math.trunc(windowFrom.getTime());
    const high = Math.trunc(windowTo.getTime());
    const routineEvents = new Set();
    for (const r of database.RecurrenceRule || []) {
      if (truthy(get(r, "eventId"))) routineEvents.add(r.eventId);
    }
    const hidden = new Set();
    for (const e of database.Event || []) {
      if (!routineEvents.has(e.id) && !(e.endAt >= low && e.startAt <= high)) hidden.add(e.id);
    }
    if (hidden.size) {
      database.Event = database.Event.filter((e) => !hidden.has(e.id));
      database.EventCompletion = (database.EventCompletion || []).filter((r) => !hidden.has(get(r, "eventId")));
      database.ChecklistItem = (database.ChecklistItem || []).filter((r) => !hidden.has(get(r, "eventId")));
      const keptItems = new Set(database.ChecklistItem.map((r) => r.id));
      database.ChecklistCompletion = (database.ChecklistCompletion || []).filter((r) => keptItems.has(get(r, "checklistItemId")));
      events = events.filter((e) => !hidden.has(e.id));
    }
    const dayTodos = {};
    for (const d of todoDates) {
      dayTodos[d] = db.getDayTodos(d).map((t) => ({ text: t.text, completed: truthy(t.completed) }));
    }
    const snapshot = {
      generated_at: isoLocal(now),
      database,
      semantic: {
        user,
        one_off_event_window: { from: dateKey(windowFrom), to: dateKey(windowTo), omitted_events: hidden.size },
        events_and_routines: events,
        routines: templates,
        today_schedule: today,
        tasks: db.getTasksWithCompletions(),
        content: items,
        projects,
        day_todos: dayTodos,
      },
      work_mail: { messages: mailState.messages },
    };
    return sanitize(toPlain(snapshot));
  };

  const apiUrl = () => process.env.CALENDIZO_AGENT_API_URL || API_URL;

  async function* streamModel(apiKey, model, messages) {
    const body = pyDumps({
      model, messages, tools: AGENT_TOOLS, tool_choice: "auto",
      thinking: { type: "enabled" }, temperature: 0.2, stream: true,
      stream_options: { include_usage: true },
    });
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), 120000);
    let response;
    try {
      response = await fetch(apiUrl(), {
        method: "POST",
        body: Buffer.from(body, "utf-8"),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      throw new ServiceError("Could not connect to the AI service. Check your internet connection or DNS, then try again.");
    }
    clearTimeout(timer);
    if (response.status < 200 || response.status >= 300) {
      let message = "";
      try {
        const raw = Buffer.from(await response.arrayBuffer());
        const parsed = pyJsonLoads(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
        const error = get(parsed, "error", {});
        const value = get(error, "message", "");
        message = truthy(value) ? pyStr(value) : "";
      } catch {}
      throw new ServiceError(message || `The AI service returned HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let pending = Buffer.alloc(0);
    const handle = (raw) => {
      const line = pyStrip(decoder.decode(raw));
      if (!line.startsWith("data:")) return { skip: true };
      const data = pyStrip(line.slice(5));
      if (data === "[DONE]") return { done: true };
      let chunk;
      try {
        chunk = pyJsonLoads(data);
      } catch (exc) {
        if (exc instanceof ValueError) return { skip: true };
        throw exc;
      }
      const choices = get(chunk, "choices");
      const deltas = [];
      for (const choice of truthy(choices) ? pyIter(choices) : []) {
        const delta = get(choice, "delta");
        deltas.push(truthy(delta) ? delta : {});
      }
      return { deltas };
    };
    try {
      for (;;) {
        timer = setTimeout(() => controller.abort(), 120000);
        let chunk;
        try {
          chunk = await reader.read();
        } catch (exc) {
          const cause = exc && exc.cause;
          if (controller.signal.aborted || !cause || cause.code !== "UND_ERR_SOCKET" || cause.message !== "other side closed") throw exc;
          chunk = { done: true };
        } finally {
          clearTimeout(timer);
        }
        if (chunk.done) break;
        pending = Buffer.concat([pending, Buffer.from(chunk.value)]);
        let index;
        while ((index = pending.indexOf(0x0a)) >= 0) {
          const raw = pending.subarray(0, index + 1);
          pending = pending.subarray(index + 1);
          const result = handle(raw);
          if (result.done) return;
          if (result.deltas) for (const delta of result.deltas) yield delta;
        }
      }
      if (pending.length) {
        const result = handle(pending);
        if (result.done) return;
        if (result.deltas) for (const delta of result.deltas) yield delta;
      }
    } finally {
      clearTimeout(timer);
      try {
        await reader.cancel();
      } catch {}
    }
  }

  const cleanText = (text) => {
    for (const rx of CLEAN_PHRASES) text = text.replace(rx, "");
    return pyStrip(text);
  };

  const describeCall = (name, args) => {
    const label = pyCapitalize(name.replaceAll("_", " "));
    let title = "";
    for (const key of ["title", "text", "event_id", "task_id", "content_id"]) {
      const value = get(args, key);
      if (truthy(value)) {
        title = value;
        break;
      }
    }
    if (name === "save_routine") {
      return `${truthy(get(args, "routine_id")) ? "Update" : "Create"} routine “${pyStr(get(args, "title"))}” ${pyStr(get(args, "start_time"))}–${pyStr(get(args, "end_time"))}`;
    }
    return truthy(title) ? `${label}: ${pyStr(title)}` : label;
  };

  const joinText = (parts) => {
    parts.forEach((part, index) => {
      if (typeof part !== "string") throw new PyTypeError(`sequence item ${index}: expected str instance, ${typeName(part)} found`);
    });
    return parts.join("");
  };

  const concat = (left, right) => {
    const value = truthy(right) ? right : "";
    if (typeof value !== "string") throw new PyTypeError(`can only concatenate str (not "${typeName(value)}") to str`);
    return left + value;
  };

  route("POST", "/api/agent/send", (ctx) => {
    const chatId = ctx.b("chatId");
    const rawText = ctx.b("text");
    const text = pyStrip(pyStr(truthy(rawText) ? rawText : ""));
    if (!truthy(chatId) || !text) throw new ApiError(400, "Write a message first.");
    const cfg = config();
    if (!truthy(get(cfg, "api_key"))) throw new ApiError(400, "Connect an API key to begin.");
    const history = loadHistory();
    findChat(history, chatId);
    const sess = session(chatId, history);
    if (sess.busy || truthy(sess.pending)) throw new ApiError(409, "Botizo is still working on the last request.");
    sess.busy = true;
    sess.messages.push({ role: "user", content: text });
    persist(chatId, sess);

    async function* generate() {
      try {
        let apiKey;
        try {
          apiKey = unprotect(cfg.api_key);
        } catch {
          yield { type: "error", message: "The saved API key can't be unlocked on this PC. Save it again in API settings.", openConfig: true };
          return;
        }
        let snapshotText;
        try {
          snapshotText = JSON.stringify(buildSnapshot());
        } catch (exc) {
          yield { type: "error", message: (exc && exc.message) || "Planizo context could not be prepared." };
          return;
        }
        const system = SYSTEM_PROMPT + `Current local datetime: ${awareIso(new Date(), true)}.\n` + `CURRENT CALENDIZO SNAPSHOT:\n${snapshotText}`;
        const messages = [{ role: "system", content: system }, ...sess.messages];
        const content = [];
        const reasoning = [];
        const calls = new Map();
        try {
          for await (const delta of streamModel(apiKey, modelName(), messages)) {
            const reasoningPart = get(delta, "reasoning_content");
            if (truthy(reasoningPart)) reasoning.push(reasoningPart);
            const contentPart = get(delta, "content");
            if (truthy(contentPart)) {
              content.push(contentPart);
              yield { type: "delta", text: contentPart };
            }
            const toolCalls = get(delta, "tool_calls");
            for (const call of truthy(toolCalls) ? pyIter(toolCalls) : []) {
              const index = get(call, "index", 0);
              if (Array.isArray(index) || isDict(index)) throw new PyTypeError(`unhashable type: '${typeName(index)}'`);
              let slot = calls.get(index);
              if (slot === undefined) {
                slot = { id: "", type: "function", function: { name: "", arguments: "" } };
                calls.set(index, slot);
              }
              if (truthy(get(call, "id"))) slot.id = call.id;
              if (truthy(get(call, "type"))) slot.type = call.type;
              const rawFn = get(call, "function");
              const fn = truthy(rawFn) ? rawFn : {};
              slot.function.name = concat(slot.function.name, get(fn, "name"));
              slot.function.arguments = concat(slot.function.arguments, get(fn, "arguments"));
            }
          }
        } catch (exc) {
          if (exc instanceof ServiceError) {
            yield { type: "error", message: exc.message };
            return;
          }
          throw exc;
        }
        const message = { role: "assistant", content: cleanText(joinText(content)) };
        if (reasoning.length) message.reasoning_content = joinText(reasoning);
        const toolCalls = [...calls.keys()].sort(compare).map((k) => calls.get(k));
        if (toolCalls.length) message.tool_calls = toolCalls;
        sess.messages.push(message);
        persist(chatId, sess);
        let approval = null;
        if (toolCalls.length) {
          const actions = [];
          for (const call of toolCalls) {
            let args;
            try {
              args = pyJsonLoads(call.function.arguments || "{}");
            } catch (exc) {
              if (!(exc instanceof ValueError)) throw exc;
              args = {};
            }
            actions.push(describeCall(call.function.name, args));
          }
          sess.pending = toolCalls;
          sess.proposedAt = Date.now() / 1000;
          approval = { count: toolCalls.length, actions, seconds: APPROVAL_SECONDS };
        } else if (!message.content) {
          message.content = "The assistant returned an empty response.";
        }
        yield { type: "done", content: message.content, approval };
      } finally {
        sess.busy = false;
      }
    }

    return new Stream(generate());
  });

  const parseIso = (value) => {
    const text = pyStrip(pyStr(truthy(value) ? value : ""));
    if (text.endsWith("Z")) return fromIsoFormat(text.slice(0, -1) + "+00:00");
    return fromIsoFormat(text);
  };

  const hhmm = (value) => {
    const text = pyStrip(pyStr(truthy(value) ? value : ""));
    const match = /^(\p{Nd}{1,2}):(\p{Nd}{2})$/u.exec(text);
    const hours = match ? Number(asciiDigits(match[1])) : 0;
    const minutes = match ? Number(asciiDigits(match[2])) : 0;
    if (!match || hours > 23 || minutes > 59) throw new ToolError(`Invalid time: ${pyStr(value)}. Use 24-hour HH:MM.`);
    return [hours, minutes];
  };

  const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();

  const daysFor = (rule) => {
    if (!truthy(rule)) return new Set();
    const start = get(rule, "startDate");
    const end = get(rule, "endDate");
    if (get(rule, "frequency") === "daily") {
      if (truthy(start) && truthy(end) && sameDay(start, end)) return new Set([jsWeekday(start)]);
      return new Set([0, 1, 2, 3, 4, 5, 6]);
    }
    const weekdays = get(rule, "weekdays");
    return pySet(truthy(weekdays) ? weekdays : []);
  };

  const fillEmpty = (templates, base, targetDays, anchor) => {
    let gaps = null;
    for (const day of targetDays) {
      const taken = [];
      for (const t of templates) {
        const rawRule = get(t, "recurrenceRule");
        const rule = truthy(rawRule) ? rawRule : {};
        const isOverride = truthy(get(rule, "startDate")) && truthy(get(rule, "endDate")) && sameDay(rule.startDate, rule.endDate);
        if (isOverride && startOfDay(rule.startDate).getTime() !== base.getTime()) continue;
        if (!daysFor(rule).has(day)) continue;
        const s = t.startAt.getHours() * 60 + t.startAt.getMinutes();
        const e = t.endAt.getHours() * 60 + t.endAt.getMinutes();
        if (e <= s) taken.push([s, 1440], [0, e]);
        else taken.push([s, e]);
      }
      const merged = [];
      for (const [s, e] of sorted(taken)) {
        if (merged.length && s <= merged[merged.length - 1][1]) {
          const last = merged[merged.length - 1];
          merged[merged.length - 1] = [last[0], Math.max(last[1], e)];
        } else merged.push([s, e]);
      }
      if (merged.some(([s, e]) => s <= anchor && anchor < e)) throw new ToolError("That start time is already taken by another routine.");
      const ends = merged.filter(([, e]) => e <= anchor).map(([, e]) => e);
      const starts = merged.filter(([s]) => s > anchor).map(([s]) => s);
      const gapStart = Math.max(...(ends.length ? ends : [0]));
      const gapEnd = Math.min(...(starts.length ? starts : [1440]));
      gaps = gaps === null ? [gapStart, gapEnd] : [Math.max(gaps[0], gapStart), Math.min(gaps[1], gapEnd)];
    }
    if (gaps === null || gaps[0] >= gaps[1]) throw new ToolError("There is no shared empty time on those days.");
    return gaps;
  };

  const toolSaveRoutine = (db, userId, args) => {
    const templates = db.getRoutineTemplates();
    const rid = get(args, "routine_id");
    let existing = null;
    if (truthy(rid)) {
      existing = templates.find((t) => t.id === rid || (truthy(get(t, "recurrenceRule")) ? get(t.recurrenceRule, "id") : null) === rid) || null;
      if (existing === null) throw new ToolError("Routine not found.");
    }
    const oldRule = existing && truthy(get(existing, "recurrenceRule")) ? existing.recurrenceRule : {};
    let base;
    if (truthy(get(args, "start_date"))) base = parseDateKey(args.start_date);
    else if (truthy(get(oldRule, "startDate"))) base = startOfDay(oldRule.startDate);
    else if (existing) base = startOfDay(existing.startAt);
    else base = startOfDay(new Date());
    const [sh, sm] = hhmm(item(args, "start_time"));
    const [eh, em] = hhmm(item(args, "end_time"));
    let start = replace(base, { hour: sh, minute: sm });
    let end = replace(base, { hour: eh, minute: em });
    if (end <= start) end = shift(end, { days: 1 });
    let frequency = truthy(get(args, "frequency")) ? args.frequency : "daily";
    let weekdays = hasOwn(args, "weekdays") ? args.weekdays : [...pyIter(truthy(get(oldRule, "weekdays")) ? oldRule.weekdays : [])];
    let endDate;
    if (hasOwn(args, "end_date")) endDate = truthy(args.end_date) ? parseDateKey(args.end_date) : null;
    else endDate = get(oldRule, "endDate");
    if (!existing && frequency === "daily" && truthy(endDate) && startOfDay(endDate).getTime() === base.getTime()) {
      frequency = "weekly";
      weekdays = [jsWeekday(base)];
    }
    if (truthy(get(args, "fill_empty_time")) && !existing) {
      const target = frequency === "weekly" && truthy(weekdays) ? pySet(weekdays) : frequency === "daily" ? new Set([0, 1, 2, 3, 4, 5, 6]) : new Set([jsWeekday(base)]);
      const [gapStart, gapEnd] = fillEmpty(templates, base, target, sh * 60 + sm);
      start = shift(base, { minutes: gapStart });
      end = shift(base, { minutes: gapEnd });
    }
    const ruleDays = [];
    for (const d of pyIter(weekdays)) {
      if (0 <= pyInt(d) && pyInt(d) <= 6) ruleDays.push(pyInt(d));
    }
    const rule = { frequency, interval: 1, weekdays: ruleDays, startDate: base, endDate };
    let checklist;
    if (hasOwn(args, "checklist")) {
      checklist = [];
      const rawList = args.checklist;
      pyIter(truthy(rawList) ? rawList : []).forEach((t, i) => {
        const title = pyStrip(pyStr(t));
        if (title) checklist.push({ title, order: i });
      });
    } else {
      checklist = (existing ? get(existing, "checklistItems", []) : []).map((i) => ({ ...i }));
    }
    const notes = hasOwn(args, "notes") ? args.notes : existing ? get(existing, "notes") : null;
    const rawTitle = get(args, "title");
    const title = cpSlice(pyStrip(pyStr(truthy(rawTitle) ? rawTitle : "")), 0, 40) || "Untitled Task";
    const eventId = db.saveRoutine(userId, existing ? existing.id : null, title, notes, start, end, rule, checklist, existing ? get(existing, "color") : null);
    return {
      ok: true, operation: existing ? "updated" : "created", routine_id: eventId, title,
      start_time: strftime(start, "%H:%M"), end_time: strftime(end, "%H:%M"), frequency,
      weekdays: rule.weekdays, visible_in: "Calendar > Routines",
    };
  };

  const boardRel = (target) => path.relative(realResolve(dataDir()), realResolve(target)).split(path.sep).join("/");

  const scriptBoard = (rel) => {
    const root = realResolve(dataDir());
    if (rel) {
      const target = realResolve(path.resolve(root, rel));
      if (isInside(root, target) && path.extname(target) === ".cwboard" && isFile(target)) return target;
    }
    const folder = path.join(root, "whiteboard");
    const boards = fs.existsSync(folder)
      ? rglobBoards(folder).filter((p) => !p.split(/[\\/]/).includes("session"))
      : [];
    if (boards.length) {
      let best = null;
      let bestTime = -Infinity;
      for (const board of boards) {
        const mtime = fs.statSync(board).mtimeMs;
        if (best === null || mtime > bestTime) {
          best = board;
          bestTime = mtime;
        }
      }
      return best;
    }
    const boardId = uuidHex().slice(0, 12);
    const target = path.join(folder, "workspaces", `board-${boardId}-Whiteboard.cwboard`);
    deps().db.upsertWhiteboardLink("board", boardId, "Whiteboard", path.relative(root, target).split(path.sep).join("/"));
    return target;
  };

  const scriptDoc = (raw) => {
    if (isDict(raw) && Array.isArray(raw.scripts) && raw.scripts.length) {
      const doc = { ...raw };
      doc.version = 2;
      doc.scripts = [...raw.scripts];
      const ids = doc.scripts.filter((s) => isDict(s)).map((s) => get(s, "id"));
      const openRaw = get(raw, "open_script_ids");
      const open = pyIter(truthy(openRaw) ? openRaw : []).filter((i) => ids.includes(i));
      doc.open_script_ids = open.length ? open : ids;
      if (!hasOwn(doc, "inactive_brolls")) doc.inactive_brolls = [];
      return doc;
    }
    if (isDict(raw) && typeof raw.script_html === "string" && pyStrip(raw.script_html)) {
      const first = uuidHex().slice(0, 10);
      const sections = get(raw, "broll_sections");
      return {
        version: 2, active_script_id: first, open_script_ids: [first], inactive_brolls: [],
        scripts: [{ id: first, title: "Script 1", script_html: raw.script_html, broll_sections: truthy(sections) ? sections : [] }],
      };
    }
    return { version: 2, active_script_id: "", open_script_ids: [], scripts: [], inactive_brolls: [] };
  };

  const toolCreateScript = (args, board, backups) => {
    const rawTitle = get(args, "title");
    const title = cpSlice(pyStrip(pyStr(truthy(rawTitle) ? rawTitle : "")) || "Untitled", 0, 40);
    const target = scriptBoard(board);
    let payload;
    if (isFile(target)) {
      payload = readJson(target, {});
      if (!truthy(payload)) throw new ToolError("The current whiteboard could not be read.");
    } else {
      payload = { version: 1, project_name: "Whiteboard", view: { zoom: 1.0, center_x: 0, center_y: 0 }, cards: [], annotations: [] };
    }
    if (!backups.has(target)) backups.set(target, JSON.parse(JSON.stringify(payload)));
    const rawText = get(args, "text");
    const lines = pyStr(truthy(rawText) ? rawText : "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    const body = lines.some((line) => line) ? lines.map((line) => `<p>${htmlEscape(line) || "<br>"}</p>`).join("") : "";
    const doc = scriptDoc(get(payload, "script"));
    const scriptId = uuidHex().slice(0, 10);
    doc.scripts.push({ id: scriptId, title, script_html: body, broll_sections: [] });
    doc.open_script_ids.push(scriptId);
    doc.active_script_id = scriptId;
    payload.script = doc;
    payload.mode = "script";
    writeJson(target, payload);
    const stem = path.parse(target).name;
    let label = truthy(get(payload, "project_name")) ? payload.project_name : stem;
    if (path.basename(path.dirname(target)) === "projects") {
      const project = deps().db.getProjects().find((p) => p.id === stem);
      if (project) label = project.name;
    }
    return {
      ok: true, script_id: scriptId, title, board: { path: boardRel(target), label },
      visible_in: `Whiteboard › ${pyStr(label)}`,
    };
  };

  const executeTool = async (name, args, board = null, backups = null) => {
    const { db, userId, mailState, mailRead } = deps();
    if (name === "create_script") return toolCreateScript(args, board, backups !== null ? backups : new Map());
    if (name === "create_event") {
      const start = parseIso(item(args, "start"));
      const end = parseIso(item(args, "end"));
      if (end <= start) throw new ToolError("Event end must be after its start.");
      const eventId = db.createEvent(userId, item(args, "title"), get(args, "notes"), start, end);
      return { ok: true, event_id: eventId, title: args.title };
    }
    if (name === "update_event") {
      const start = parseIso(item(args, "start"));
      const end = parseIso(item(args, "end"));
      if (end <= start) throw new ToolError("Event end must be after its start.");
      db.updateEvent(item(args, "event_id"), item(args, "title"), get(args, "notes"), start, end);
      return { ok: true, event_id: args.event_id, title: args.title };
    }
    if (name === "delete_event") {
      db.deleteEvent(item(args, "event_id"));
      return { ok: true, event_id: args.event_id };
    }
    if (name === "set_event_color") {
      const raw = get(args, "color");
      const key = pyStr(truthy(raw) ? raw : "").toLowerCase();
      const color = hasOwn(COLORS, key) ? COLORS[key] : null;
      if (!color) throw new ToolError("Choose a supported event color.");
      const event = db.getEventsWithChecklists().find((e) => e.id === item(args, "event_id")) || null;
      if (event === null) throw new ToolError("Event or routine not found.");
      db.setEventColor(args.event_id, color);
      return { ok: true, event_id: args.event_id, title: event.title, color: item(args, "color") };
    }
    if (name === "set_event_completion") {
      db.setEventCompletion(item(args, "event_id"), userId, item(args, "date"), truthy(item(args, "completed")));
      return { ok: true };
    }
    if (name === "create_due_task") {
      let due = parseDateKey(item(args, "due_date"));
      const rawTime = get(args, "time");
      let timeStr = truthy(rawTime) ? rawTime : null;
      if (truthy(timeStr)) {
        const [hh, mm] = hhmm(timeStr);
        timeStr = `${pad(hh)}:${pad(mm)}`;
        due = replace(due, { hour: hh, minute: mm });
      }
      const taskId = db.createTask(userId, item(args, "title"), due, timeStr);
      return {
        ok: true, task_id: taskId, title: args.title, due_date: args.due_date, time: timeStr,
        visible_in: "Today or Day View, under Due > Tasks",
      };
    }
    if (name === "delete_task") {
      db.deleteTask(item(args, "task_id"));
      return { ok: true };
    }
    if (name === "set_task_completion") {
      db.setTaskCompletion(item(args, "task_id"), userId, item(args, "date"), truthy(item(args, "completed")));
      return { ok: true };
    }
    if (name === "save_routine") return toolSaveRoutine(db, userId, args);
    if (name === "create_content") {
      const title = item(args, "title");
      const kind = item(args, "kind");
      const status = item(args, "status");
      const scheduled = get(args, "scheduled_date");
      const contentId = db.createContentItem(userId, title, kind, status, truthy(scheduled) ? scheduled : null, get(args, "notes"));
      return { ok: true, content_id: contentId, title: args.title };
    }
    if (name === "update_content") {
      const patch = {};
      for (const k of ["title", "kind", "status", "notes"]) {
        if (hasOwn(args, k)) patch[k] = args[k];
      }
      if (hasOwn(args, "scheduled_date")) patch.scheduledDate = truthy(args.scheduled_date) ? args.scheduled_date : null;
      db.updateContentItem(item(args, "content_id"), patch);
      return { ok: true, title: get(args, "title") };
    }
    if (name === "delete_content") {
      db.deleteContentItem(item(args, "content_id"));
      return { ok: true };
    }
    if (name === "add_note") {
      const rawTitle = get(args, "title");
      const note = db.addNote(userId, item(args, "date"), item(args, "text"), truthy(rawTitle) ? rawTitle : "");
      return { ok: true, note_id: note.id, title: truthy(rawTitle) ? rawTitle : null };
    }
    if (name === "set_email_read") {
      const uid = pyInt(item(args, "uid"));
      let message = null;
      for (const m of mailState.messages) {
        if (pyInt(item(m, "uid")) === uid) {
          message = m;
          break;
        }
      }
      if (message === null) throw new ToolError("That email is not in the loaded inbox.");
      if (truthy(get(message, "unread")) !== truthy(item(args, "read"))) return { ok: true, unchanged: true };
      const body = { uid, read: truthy(args.read) };
      const mailCtx = { body, b: (key, fallback = null) => (hasOwn(body, key) ? body[key] : fallback) };
      try {
        await mailRead(mailCtx);
      } catch (exc) {
        if (exc instanceof ApiError) throw new ToolError(exc.message);
        throw exc;
      }
      return { ok: true, status: "Hostinger update done", title: get(message, "subject") };
    }
    throw new ToolError(`Unsupported agent action: ${pyStr(name)}`);
  };

  const summarize = (results) => {
    const lines = [];
    for (const [name, result] of results) {
      let verb;
      if (truthy(get(result, "operation"))) verb = pyCapitalize(pyStr(result.operation));
      else if (name.startsWith("create_") || name.startsWith("add_")) verb = "Created";
      else if (name.startsWith("delete_")) verb = "Deleted";
      else verb = "Updated";
      if (name === "save_routine") {
        lines.push(`${verb} **${pyStr(get(result, "title"))}** from **${pyStr(get(result, "start_time"))} to ${pyStr(get(result, "end_time"))}** in **${pyStr(get(result, "visible_in"))}**.`);
      } else if (name === "create_script") {
        lines.push(`${verb} script **${pyStr(get(result, "title"))}** in **${pyStr(get(result, "visible_in"))}**.`);
      } else if (truthy(get(result, "title"))) {
        lines.push(`${verb} **${pyStr(result.title)}**.`);
      } else {
        const cut = name.indexOf("_");
        lines.push(`${verb} ${(cut >= 0 ? name.slice(cut + 1) : name).replaceAll("_", " ")}.`);
      }
    }
    if (lines.length === 1) return lines[0];
    return lines.map((line) => `- ${line}`).join("\n");
  };

  route("POST", "/api/agent/decide", async (ctx) => {
    const chatId = ctx.b("chatId");
    const sess = session(chatId);
    const calls = sess.pending;
    if (!truthy(calls)) throw new ApiError(409, "There is no change waiting for approval.");
    sess.pending = null;
    const expired = truthy(ctx.b("expired")) || Date.now() / 1000 - sess.proposedAt > APPROVAL_SECONDS + 5;
    if (!truthy(ctx.b("approved")) || expired) {
      const reason = expired ? "Approval expired." : "User rejected this action batch.";
      for (const call of calls) {
        sess.messages.push({ role: "tool", tool_call_id: call.id, content: pyDumps({ ok: false, cancelled: true, error: reason }) });
      }
      sess.messages.push({ role: "assistant", content: "No changes were made." });
      return { approved: false, expired };
    }
    const db = deps().db;
    sess.undo = db.exportData();
    const backups = new Map();
    sess.undo_boards = backups;
    const rawBoard = ctx.b("board");
    const board = pyStr(truthy(rawBoard) ? rawBoard : "") || null;
    let opened = null;
    const results = [];
    const failures = [];
    for (const call of calls) {
      const name = call.function.name;
      let result;
      try {
        const args = pyJsonLoads(call.function.arguments || "{}");
        result = await executeTool(name, args, board, backups);
        results.push([name, result]);
        if (name === "create_script") opened = result.board;
      } catch (exc) {
        let message;
        if (exc instanceof ToolError || exc instanceof KeyErr || exc instanceof ValueError || exc instanceof PyTypeError) {
          message = exc instanceof KeyErr ? `Missing field ${exc.message}.` : exc.message;
        } else {
          message = (exc && exc.message) || "Action failed.";
        }
        result = { ok: false, error: message };
        failures.push(`${pyTitle(name.replaceAll("_", " "))}: ${message}`);
      }
      sess.messages.push({ role: "tool", tool_call_id: call.id, content: pyDumps(result) });
    }
    if (failures.length) return { approved: true, errors: failures, undoAvailable: results.length > 0, board: opened };
    const summary = summarize(results);
    sess.messages.push({ role: "assistant", content: summary });
    persist(chatId, sess);
    return { approved: true, summary, undoAvailable: true, board: opened };
  });

  route("POST", "/api/agent/undo", (ctx) => {
    const sess = session(ctx.b("chatId"));
    const snapshot = sess.undo;
    if (snapshot === null || snapshot === undefined) throw new ApiError(409, "There is no agent change left to undo.");
    deps().db.importData(snapshot);
    const boards = sess.undo_boards;
    if (boards) {
      for (const [file, payload] of boards) writeJson(file, payload);
    }
    sess.undo = null;
    sess.undo_boards = null;
    sess.messages.push({ role: "assistant", content: "The last approved change was undone." });
    persist(ctx.b("chatId"), sess);
    return null;
  });
}
