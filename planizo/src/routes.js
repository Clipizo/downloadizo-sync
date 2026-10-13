import fs from "node:fs";
import path from "node:path";
import { ApiError, Raw, route } from "./http.js";
import { dateKey, endOfDay, parseDateKey, startOfDay } from "./core/dates.js";
import { fromIsoFormat, replace, shift, sorted, strftime, truthy, uuidHex, ValueError } from "./py.js";
import * as workMail from "./core/workMail.js";
import * as webBackups from "./webBackups.js";

export const CURATED = [
  ["Red", "#ff3b3b"], ["Orange", "#ff8c1a"], ["Yellow", "#ffd60a"], ["Green", "#30d158"], ["Blue", "#0a84ff"],
  ["Purple", "#7b3ff2"], ["Pink", "#ff2d92"], ["Sky", "#64d2ff"], ["Taupe", "#ac8c68"], ["Rose", "#ff375f"],
];
export const THUMB_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);
const IMAGE_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/bmp": ".bmp" };
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MIME_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jpe": "image/jpeg", ".jfif": "image/jpeg",
  ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic", ".avif": "image/avif", ".txt": "text/plain",
  ".json": "application/json", ".pdf": "application/pdf", ".mp4": "video/mp4", ".zip": "application/zip",
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "application/javascript",
};

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const WIN = process.platform === "win32";
const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

export function pyType(value) {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  return "dict";
}

function pyRepr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const body = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(value).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
}

export function pyStr(value) {
  return typeof value === "string" ? value : pyRepr(value);
}

export function strip(value) {
  if (typeof value !== "string") throw new TypeError(`'${pyType(value)}' object has no attribute 'strip'`);
  return value.replace(STRIP_RE, "");
}

function or(value, fallback) {
  return truthy(value) ? value : fallback;
}

function textOr(value) {
  return strip(or(value, ""));
}

function cpLength(text) {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

function cpSlice(text, limit) {
  return Array.from(text).slice(0, limit).join("");
}

function cpCompare(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function asciiDigit(ch) {
  if (!/\p{Nd}/u.test(ch)) return ch;
  let start = ch.codePointAt(0);
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
  return String((ch.codePointAt(0) - start) % 10);
}

export function pyInt(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new ValueError("cannot convert float NaN to integer");
    if (!Number.isFinite(value)) throw new Error("cannot convert float infinity to integer");
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = strip(value);
    if (/^[+-]?\p{Nd}+(_\p{Nd}+)*$/u.test(text)) return Number(Array.from(text.replace(/_/g, ""), asciiDigit).join(""));
    throw new ValueError(`invalid literal for int() with base 10: ${pyRepr(value)}`);
  }
  throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${pyType(value)}'`);
}

function pyIter(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  if (value && typeof value === "object") return Object.keys(value);
  throw new TypeError(`'${pyType(value)}' object is not iterable`);
}

function pyIn(key, container) {
  if (Array.isArray(container)) return container.some((item) => item === key);
  if (typeof container === "string") {
    if (typeof key !== "string") throw new TypeError(`'in <string>' requires string as left operand, not ${pyType(key)}`);
    return container.includes(key);
  }
  if (container && typeof container === "object") return Object.prototype.hasOwnProperty.call(container, key);
  throw new TypeError(`argument of type '${pyType(container)}' is not iterable`);
}

function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pyGet(obj, key, fallback = null) {
  if (!isDict(obj)) throw new TypeError(`'${pyType(obj)}' object has no attribute 'get'`);
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

function bodyOf(ctx) {
  return truthy(ctx.body) ? ctx.body : {};
}

function bodyItems(ctx) {
  const body = bodyOf(ctx);
  if (!isDict(body)) throw new TypeError(`'${pyType(body)}' object has no attribute 'items'`);
  return body;
}

function pyLe(a, b) {
  if (typeof a !== typeof b || (typeof a !== "string" && typeof a !== "number")) {
    throw new TypeError(`'<=' not supported between instances of '${pyType(a)}' and '${pyType(b)}'`);
  }
  return a <= b;
}

function between(low, value, high) {
  return pyLe(low, value) && pyLe(value, high);
}

function pyEq(a, b) {
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

export function hhmm(text) {
  if (typeof text !== "string") throw new TypeError(`'${pyType(text)}' object has no attribute 'split'`);
  const values = [];
  for (const part of text.split(":")) {
    values.push(pyInt(part));
    if (values.length > 2) throw new ValueError("too many values to unpack (expected 2)");
  }
  if (values.length < 2) throw new ValueError(`not enough values to unpack (expected 2, got ${values.length})`);
  return values;
}

function withHourMinute(d, hh, mm) {
  if (hh < 0 || hh > 23) throw new ValueError("hour must be in 0..23");
  if (mm < 0 || mm > 59) throw new ValueError("minute must be in 0..59");
  return replace(d, { hour: hh, minute: mm });
}

const B64_TABLE = (() => {
  const table = new Int16Array(256).fill(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charCodeAt(i)] = i;
  return table;
})();

export function b64decode(value) {
  if (typeof value !== "string") {
    throw new TypeError(`argument should be a bytes-like object or ASCII string, not '${pyType(value)}'`);
  }
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 127) throw new ValueError("string argument should contain only ASCII characters");
  }
  const out = Buffer.alloc(Math.floor((value.length * 3) / 4) + 3);
  let size = 0;
  let quadPos = 0;
  let leftChar = 0;
  let pads = 0;
  let finished = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 61) {
      pads += 1;
      if (quadPos >= 2 && quadPos + pads >= 4) {
        finished = true;
        break;
      }
      continue;
    }
    const ch = B64_TABLE[code];
    if (ch < 0) continue;
    pads = 0;
    if (quadPos === 0) {
      quadPos = 1;
      leftChar = ch;
    } else if (quadPos === 1) {
      quadPos = 2;
      out[size++] = (leftChar << 2) | (ch >> 4);
      leftChar = ch & 0x0f;
    } else if (quadPos === 2) {
      quadPos = 3;
      out[size++] = ((leftChar << 4) | (ch >> 2)) & 0xff;
      leftChar = ch & 0x03;
    } else {
      quadPos = 0;
      out[size++] = ((leftChar << 6) | ch) & 0xff;
      leftChar = 0;
    }
  }
  if (!finished && quadPos !== 0) {
    if (quadPos === 1) {
      throw new ValueError(`Invalid base64-encoded string: number of data characters (${Math.floor(size / 3) * 4 + 1}) cannot be 1 more than a multiple of 4`);
    }
    throw new ValueError("Incorrect padding");
  }
  return out.subarray(0, size);
}

export function pyDumps(value) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value);
    const [mantissa, e] = value.toExponential().split("e");
    const exp = Number(e);
    const sign = mantissa.startsWith("-") ? "-" : "";
    const digits = mantissa.replace("-", "").replace(".", "");
    if (exp >= -4 && exp < 16) {
      if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
      return `${sign}${digits.slice(0, exp + 1).padEnd(exp + 1, "0")}.${digits.slice(exp + 1) || "0"}`;
    }
    const head = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${head}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  if (typeof value === "string") {
    let out = '"';
    for (let i = 0; i < value.length; i += 1) {
      const c = value.charCodeAt(i);
      const ch = value[i];
      if (ch === '"') out += '\\"';
      else if (ch === "\\") out += "\\\\";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch === "\b") out += "\\b";
      else if (ch === "\f") out += "\\f";
      else if (c < 0x20 || c > 0x7e) out += "\\u" + c.toString(16).padStart(4, "0");
      else out += ch;
    }
    return out + '"';
  }
  if (Array.isArray(value)) return `[${value.map(pyDumps).join(", ")}]`;
  return `{${Object.entries(value).map(([k, v]) => `${pyDumps(k)}: ${pyDumps(v)}`).join(", ")}}`;
}

export function pyName(name) {
  let rest = String(name);
  if (WIN) {
    const unc = /^[\\/]{2}[^\\/]+[\\/](?![\\/])[^\\/]*/.exec(rest);
    rest = unc ? rest.slice(unc[0].length) : rest.replace(/^[A-Za-z]:/, "");
  }
  const parts = rest.split(WIN ? /[\\/]/ : /\//).filter((part) => part && part !== ".");
  return parts.length ? parts[parts.length - 1] : "";
}

export function pySuffix(name) {
  const base = pyName(name);
  const i = base.lastIndexOf(".");
  return i > 0 && i < base.length - 1 ? base.slice(i) : "";
}

export function pyStem(name) {
  const base = pyName(name);
  const i = base.lastIndexOf(".");
  return i > 0 && i < base.length - 1 ? base.slice(0, i) : base;
}

function guessMime(name) {
  return MIME_TYPES[pySuffix(name).toLowerCase()] || "application/octet-stream";
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function pyMtime(target) {
  const stat = fs.statSync(target, { bigint: true });
  const ns = stat.mtimeNs;
  const sec = ns / 1000000000n;
  const nsec = ns % 1000000000n;
  return Number(sec) + Number(nsec) * 1e-9;
}

export function readJson(file, fallback) {
  let text;
  try {
    text = UTF8.decode(fs.readFileSync(file));
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const pending = file + ".tmp";
  fs.writeFileSync(pending, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(pending, file);
}

export function parseDt(value) {
  if (!truthy(value)) throw new ApiError(400, "Missing date/time.");
  const text = strip(pyStr(value));
  try {
    return fromIsoFormat(text.endsWith("Z") ? text.slice(0, -1) + "+00:00" : text);
  } catch (exc) {
    if (exc instanceof ValueError) throw new ApiError(400, `Invalid date/time: ${text}`);
    throw exc;
  }
}

export function parseKey(value) {
  try {
    return parseDateKey(pyStr(value));
  } catch {
    throw new ApiError(400, `Invalid date: ${pyStr(value)}`);
  }
}

export function nowMs() {
  return Date.now();
}

function placeholders(items) {
  return items.map(() => "?").join(",");
}

function checkParams(params) {
  params.forEach((value, i) => {
    if (value !== null && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array) && !(value instanceof Date)) {
      throw new Error(`Error binding parameter ${i} - probably unsupported type.`);
    }
  });
  return params;
}

function pyDict(source) {
  if (isDict(source)) return { ...source };
  const out = {};
  pyIter(source).forEach((item, i) => {
    if (item === null || item === undefined || typeof item === "number" || typeof item === "boolean") {
      throw new TypeError(`cannot convert dictionary update sequence element #${i} to a sequence`);
    }
    const pair = pyIter(item);
    if (pair.length !== 2) throw new ValueError(`dictionary update sequence element #${i} has length ${pair.length}; 2 is required`);
    out[pyStr(pair[0])] = pair[1];
  });
  return out;
}

export function routineColorMap(templates) {
  const titles = [...new Set(templates.map((t) => strip(or(t.title, ""))))].sort(cpCompare);
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

export function displayColor(item, colorMap, index = 0) {
  if (truthy(item.color)) return item.color;
  const title = strip(or(item.title, ""));
  if (colorMap.has(title)) return colorMap.get(title);
  return CURATED[index % CURATED.length][1];
}

export function colorName(hexValue) {
  for (const [name, value] of CURATED) {
    if (value.toLowerCase() === String(or(hexValue, "")).toLowerCase()) return name;
  }
  return "";
}

export function safeName(value, limit) {
  return String(or(value, "")).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, limit);
}

function emptyBoard(label) {
  return { version: 1, project_name: label, view: { zoom: 1.0, center_x: 0, center_y: 0 }, cards: [], annotations: [] };
}

function insideDir(parent, child) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

function walkMatches(dir, suffix, out) {
  const fold = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (fold(entry.name).endsWith(fold(suffix))) out.push(path.join(dir, entry.name));
  }
  for (const entry of entries) {
    if (entry.isDirectory()) walkMatches(path.join(dir, entry.name), suffix, out);
  }
}

async function readLimited(response, limit, idleMs, controller) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleMs);
  };
  try {
    arm();
    while (total < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      chunks.push(Buffer.from(value));
      total += value.length;
    }
  } finally {
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {}
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

export function urlPathName(url) {
  let rest = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, "");
  if (rest.startsWith("//")) {
    const end = rest.slice(2).search(/[/?#]/);
    rest = end < 0 ? "" : rest.slice(2 + end);
  }
  rest = rest.split("#")[0].split("?")[0];
  const slash = rest.lastIndexOf("/");
  const semi = rest.indexOf(";", slash < 0 ? 0 : slash);
  if (semi >= 0) rest = rest.slice(0, semi);
  return pyName(rest);
}

export function register(state) {
  const dataDir = () => state.dataDir;
  const dbOf = () => state.db;
  const rawExec = (sql, params = []) => {
    dbOf().sql.run(sql, checkParams(params));
  };
  const rawQuery = (sql, params = []) => dbOf().sql.all(sql, checkParams(params));

  route("GET", "/api/bootstrap", () => {
    const user = dbOf().getUser() || {};
    return {
      user: { id: "id" in user ? user.id : null, timeFormat: or(user.timeFormat, "h12") },
      today: dateKey(new Date()),
      mailAvailable: true,
      palette: CURATED.map(([name, hex]) => ({ name, hex })),
    };
  });

  route("PUT", "/api/user/time-format", (ctx) => {
    const value = ctx.b("value");
    if (value !== "h12" && value !== "h24") throw new ApiError(400, "Time format must be h12 or h24.");
    dbOf().setTimeFormat(state.userId, value);
  });

  route("GET", "/api/search", (ctx) => {
    const query = strip(or(ctx.q("q"), ""));
    if (cpLength(query) < 2) return [];
    const results = dbOf().globalSearch(query, pyInt(ctx.q("limit", 8)));
    return results.filter((r) => r.kind !== "settings");
  });

  route("GET", "/api/range", (ctx) => {
    const db = dbOf();
    const start = startOfDay(parseKey(ctx.q("from")));
    const end = endOfDay(parseKey(ctx.q("to")));
    const events = db.occurrencesForRange(start, end);
    const cmap = routineColorMap(db.getRoutineTemplates());
    for (const occ of events) {
      if (truthy(occ.color)) {
        occ.displayColor = occ.color;
      } else if (truthy(occ.isRecurring)) {
        const title = strip(or(occ.title, ""));
        occ.displayColor = cmap.has(title) ? cmap.get(title) : null;
      } else {
        occ.displayColor = null;
      }
    }
    const payload = { events, tasks: db.taskOccurrencesForRange(start, end) };
    if (ctx.q("extras")) {
      const fromKey = dateKey(start);
      const toKey = dateKey(end);
      payload.content = db.getContentItems().filter((c) => truthy(c.scheduledDate) && between(fromKey, c.scheduledDate, toKey));
      payload.notes = db.getAllNotes().filter((n) => between(fromKey, or(n.date, ""), toKey));
      payload.todoDates = [...db.dayTodoDates()].filter((d) => between(fromKey, d, toKey)).sort(cpCompare);
    }
    return payload;
  });

  route("POST", "/api/completion/checklist", (ctx) => {
    dbOf().setChecklistCompletion(ctx.b("itemId"), state.userId, ctx.b("dateKey"), truthy(ctx.b("completed")));
  });

  route("POST", "/api/completion/event", (ctx) => {
    dbOf().setEventCompletion(ctx.b("eventId"), state.userId, ctx.b("dateKey"), truthy(ctx.b("completed")));
  });

  route("POST", "/api/completion/task", (ctx) => {
    dbOf().setTaskCompletion(ctx.b("taskId"), state.userId, ctx.b("dateKey"), truthy(ctx.b("completed")));
  });

  route("POST", "/api/events", (ctx) => {
    const db = dbOf();
    const start = parseDt(ctx.b("start"));
    const end = parseDt(ctx.b("end"));
    if (end <= start) throw new ApiError(400, "End must be after start.");
    const title = or(textOr(ctx.b("title")), "Untitled event");
    const notes = or(textOr(ctx.b("notes")), null);
    const eventId = db.createEvent(state.userId, title, notes, start, end);
    if (truthy(ctx.b("color"))) db.setEventColor(eventId, ctx.b("color"));
    return { id: eventId };
  });

  route("PUT", "/api/events/([\\w-]+)", (ctx) => {
    const start = parseDt(ctx.b("start"));
    const end = parseDt(ctx.b("end"));
    if (end <= start) throw new ApiError(400, "End must be after start.");
    const title = or(textOr(ctx.b("title")), "Untitled event");
    const notes = or(textOr(ctx.b("notes")), null);
    dbOf().updateEvent(ctx.arg(1), title, notes, start, end);
  });

  route("POST", "/api/events/([\\w-]+)/move", (ctx) => {
    dbOf().moveEvent(ctx.arg(1), parseDt(ctx.b("start")), parseDt(ctx.b("end")));
  });

  route("POST", "/api/events/([\\w-]+)/color", (ctx) => {
    dbOf().setEventColor(ctx.arg(1), or(ctx.b("color"), null));
  });

  route("DELETE", "/api/events/([\\w-]+)", (ctx) => {
    dbOf().deleteEvent(ctx.arg(1));
  });

  route("POST", "/api/events/([\\w-]+)/restore", (ctx) => {
    dbOf().restoreEvent(ctx.arg(1));
  });

  route("POST", "/api/tasks", (ctx) => {
    let due = parseKey(ctx.b("date"));
    const timeStr = or(ctx.b("time"), null);
    if (truthy(timeStr)) {
      const [hh, mm] = hhmm(timeStr);
      due = withHourMinute(due, hh, mm);
    }
    const title = or(textOr(ctx.b("title")), "Untitled task");
    return { id: dbOf().createTask(state.userId, title, due, timeStr) };
  });

  route("POST", "/api/tasks/([\\w-]+)/move", (ctx) => {
    dbOf().moveTask(ctx.arg(1), parseKey(ctx.b("date")), or(ctx.b("time"), null));
  });

  route("DELETE", "/api/tasks/([\\w-]+)", (ctx) => {
    dbOf().deleteTask(ctx.arg(1));
  });

  route("POST", "/api/tasks/([\\w-]+)/restore", (ctx) => {
    dbOf().restoreTask(ctx.arg(1));
  });

  route("GET", "/api/notes", (ctx) => dbOf().getNotes(ctx.q("date")));

  route("POST", "/api/notes", (ctx) => {
    const title = textOr(ctx.b("title"));
    const text = or(textOr(ctx.b("text")), title);
    if (!truthy(text)) throw new ApiError(400, "Write a note first.");
    return dbOf().addNote(state.userId, ctx.b("date"), text, title);
  });

  route("PUT", "/api/notes/([\\w-]+)", (ctx) => {
    const noteId = ctx.arg(1);
    const body = bodyOf(ctx);
    if (pyIn("date", body)) rawExec("UPDATE Note SET date=?, updatedAt=? WHERE id=?", [ctx.b("date"), nowMs(), noteId]);
    if (pyIn("text", body) || pyIn("title", body)) {
      const title = textOr(ctx.b("title"));
      const text = or(textOr(ctx.b("text")), title);
      if (!truthy(text)) throw new ApiError(400, "Write a note first.");
      rawExec("UPDATE Note SET title=?, text=?, updatedAt=? WHERE id=?", [title, text, nowMs(), noteId]);
    }
  });

  route("DELETE", "/api/notes/([\\w-]+)", (ctx) => {
    dbOf().removeNote(ctx.arg(1));
  });

  route("POST", "/api/notes/([\\w-]+)/restore", (ctx) => {
    dbOf().restoreNote(ctx.arg(1));
  });

  route("GET", "/api/todos", (ctx) => {
    const todos = dbOf().getDayTodos(ctx.q("date"));
    return sorted(todos, (t) => [pyInt(or(t.order, 0)), pyInt(or(t.createdAt, 0))]);
  });

  route("POST", "/api/todos", (ctx) => {
    const key = ctx.b("date");
    parseKey(key);
    const ids = [];
    for (const line of pyIter(or(ctx.b("texts"), []))) {
      if (truthy(strip(pyStr(line)))) ids.push(dbOf().addDayTodo(state.userId, key, line));
    }
    return { ids };
  });

  route("PUT", "/api/todos/([\\w-]+)", (ctx) => {
    dbOf().setDayTodoDone(ctx.arg(1), truthy(ctx.b("completed")));
  });

  route("DELETE", "/api/todos/([\\w-]+)", (ctx) => {
    dbOf().deleteDayTodo(ctx.arg(1));
  });

  route("POST", "/api/todos/delete-day", (ctx) => {
    const db = dbOf();
    const ids = db.getDayTodos(ctx.b("date")).map((t) => t.id);
    for (const todoId of ids) db.deleteDayTodo(todoId);
    return { ids };
  });

  route("POST", "/api/todos/restore", (ctx) => {
    const ids = pyIter(or(ctx.b("ids"), [])).filter((i) => truthy(i));
    if (ids.length) rawExec(`UPDATE DayTodo SET deleted=0, updatedAt=? WHERE id IN (${placeholders(ids)})`, [nowMs(), ...ids]);
  });

  route("POST", "/api/todos/move", (ctx) => {
    const db = dbOf();
    const src = ctx.b("from");
    const dst = ctx.b("to");
    const ids = !pyEq(src, dst) ? db.getDayTodos(src).map((t) => t.id) : [];
    db.moveDayTodos(src, dst);
    return { ids };
  });

  route("POST", "/api/todos/set-date", (ctx) => {
    const ids = pyIter(or(ctx.b("ids"), [])).filter((i) => truthy(i));
    if (ids.length) rawExec(`UPDATE DayTodo SET date=?, updatedAt=? WHERE id IN (${placeholders(ids)})`, [ctx.b("date"), nowMs(), ...ids]);
  });

  route("POST", "/api/content-items", (ctx) => {
    const title = textOr(ctx.b("title"));
    if (!truthy(title)) throw new ApiError(400, "Enter a title.");
    const itemId = dbOf().createContentItem(
      state.userId, title, or(ctx.b("kind"), "step"), or(ctx.b("status"), "todo"), ctx.b("scheduledDate"),
      ctx.b("notes"), ctx.b("projectId"), ctx.b("stageId"), ctx.b("parentStepId"),
    );
    return { id: itemId };
  });

  route("PUT", "/api/content-items/([\\w-]+)", (ctx) => {
    dbOf().updateContentItem(ctx.arg(1), { ...bodyItems(ctx) });
  });

  route("DELETE", "/api/content-items/([\\w-]+)", (ctx) => {
    const db = dbOf();
    const itemId = ctx.arg(1);
    const ids = [itemId, ...db.getSubsteps(itemId).map((s) => s.id)];
    db.deleteContentItem(itemId);
    return { ids };
  });

  route("POST", "/api/content-items/restore", (ctx) => {
    dbOf().restoreContentItems(or(ctx.b("ids"), []));
  });

  route("POST", "/api/content-items/([\\w-]+)/toggle", (ctx) => {
    const db = dbOf();
    const itemId = ctx.arg(1);
    const status = truthy(ctx.b("done")) ? "done" : "todo";
    db.updateContentItem(itemId, { status });
    for (const sub of db.getSubsteps(itemId)) db.updateContentItem(sub.id, { status });
    const row = rawQuery("SELECT parentStepId FROM ContentItem WHERE id=?", [itemId]);
    if (row.length && truthy(row[0].parentStepId)) db.syncParentStatus(row[0].parentStepId);
  });

  const projectCounts = () => {
    const count = new Map();
    const done = new Map();
    let unfiled = 0;
    for (const item of dbOf().getContentItems()) {
      if (truthy(item.parentStepId)) continue;
      const pid = item.projectId;
      if (truthy(pid)) {
        count.set(pid, (count.get(pid) || 0) + 1);
        if (item.status === "done") done.set(pid, (done.get(pid) || 0) + 1);
      } else {
        unfiled += 1;
      }
    }
    return [count, done, unfiled];
  };

  route("GET", "/api/projects", () => {
    const db = dbOf();
    const [count, done, unfiled] = projectCounts();
    const projects = [];
    for (const raw of db.getProjects()) {
      const p = {};
      for (const [k, v] of Object.entries(raw)) if (k !== "syncDirty" && k !== "deleted") p[k] = v;
      p.count = count.get(p.id) || 0;
      p.done = done.get(p.id) || 0;
      p.stageCount = db.getStages(p.id).length;
      projects.push(p);
    }
    return { projects, trashCount: unfiled, presets: db.getStepPresets() };
  });

  route("POST", "/api/projects", (ctx) => {
    const db = dbOf();
    const name = textOr(ctx.b("name"));
    if (!truthy(name)) throw new ApiError(400, "Enter a project name.");
    const pid = db.createProject(state.userId, name, "", or(ctx.b("thumbnail"), null), or(ctx.b("status"), "idea"));
    for (const title of pyIter(or(ctx.b("presetSteps"), []))) {
      db.createContentItem(state.userId, title, "step", "todo", null, null, pid, null, null);
    }
    const stages = db.getStages(pid);
    if (stages.length) db.assignUnfiledSteps(pid, stages[0].id);
    return { id: pid };
  });

  route("GET", "/api/projects/([\\w-]+)", (ctx) => {
    const db = dbOf();
    const pid = ctx.arg(1);
    if (pid === "trash") return { project: null, stages: [], items: db.getContentItems(null) };
    const project = db.getProject(pid);
    if (!truthy(project)) throw new ApiError(404, "Project not found.");
    return { project, stages: db.getStages(pid), items: db.getContentItems(pid) };
  });

  route("PUT", "/api/projects/([\\w-]+)", (ctx) => {
    const patch = {};
    for (const [k, v] of Object.entries(bodyItems(ctx))) {
      if (k === "name" || k === "description" || k === "thumbnail" || k === "status") patch[k] = v;
    }
    dbOf().updateProject(ctx.arg(1), patch);
  });

  route("POST", "/api/projects/([\\w-]+)/mark", (ctx) => {
    const db = dbOf();
    const pid = ctx.arg(1);
    const done = truthy(ctx.b("done"));
    db.updateProject(pid, { status: done ? "done" : "idea" });
    for (const item of db.getContentItems(pid)) db.updateContentItem(item.id, { status: done ? "done" : "todo" });
  });

  route("DELETE", "/api/projects/([\\w-]+)", (ctx) => {
    dbOf().deleteProject(ctx.arg(1), true);
  });

  route("GET", "/api/projects/([\\w-]+)/export", (ctx) => {
    const db = dbOf();
    const pid = ctx.arg(1);
    const project = db.getProject(pid);
    if (!truthy(project)) throw new ApiError(404, "Project not found.");
    const steps = [];
    for (const item of db.getContentItems(pid)) {
      if (truthy(item.parentStepId)) continue;
      steps.push({
        title: item.title, status: item.status, notes: "notes" in item ? item.notes : null,
        substeps: db.getSubsteps(item.id).map((s) => ({ title: s.title, status: s.status })),
      });
    }
    return {
      name: project.name, description: "description" in project ? project.description : null, status: project.status,
      thumbnail: "thumbnail" in project ? project.thumbnail : null, steps,
    };
  });

  route("POST", "/api/projects/import", (ctx) => {
    const db = dbOf();
    const data = isDict(ctx.body) ? ctx.body : {};
    let description = or(pyGet(data, "description"), "");
    if (typeof description !== "string") description = pyDumps(description);
    const pid = db.createProject(state.userId, or(pyGet(data, "name"), "Imported project"), description,
      or(pyGet(data, "thumbnail"), ""), or(pyGet(data, "status"), "idea"));
    for (const step of pyIter(or(pyGet(data, "steps"), []))) {
      const stepId = db.createContentItem(state.userId, or(pyGet(step, "title"), "Step"), "step", or(pyGet(step, "status"), "todo"),
        null, or(pyGet(step, "notes"), ""), pid, null);
      for (const sub of pyIter(or(pyGet(step, "substeps"), []))) {
        db.createContentItem(state.userId, or(pyGet(sub, "title"), "Substep"), "substep", or(pyGet(sub, "status"), "todo"),
          null, null, pid, null, stepId);
      }
    }
    const stages = db.getStages(pid);
    if (stages.length) db.assignUnfiledSteps(pid, stages[0].id);
    return { id: pid };
  });

  route("POST", "/api/stages", (ctx) => ({ id: dbOf().createStage(ctx.b("projectId"), or(ctx.b("name"), "Stage")) }));

  route("PUT", "/api/stages/([\\w-]+)", (ctx) => {
    const name = textOr(ctx.b("name"));
    if (truthy(name)) dbOf().updateStage(ctx.arg(1), { name });
  });

  route("DELETE", "/api/stages/([\\w-]+)", (ctx) => {
    const db = dbOf();
    const sid = ctx.arg(1);
    const rows = rawQuery("SELECT projectId FROM Stage WHERE id=?", [sid]);
    if (!rows.length) throw new ApiError(404, "Stage not found.");
    const pid = rows[0].projectId;
    db.deleteStage(sid);
    const stages = db.getStages(pid);
    const target = stages.length ? stages[0].id : db.createStage(pid, "General");
    db.assignUnfiledSteps(pid, target);
  });

  route("POST", "/api/steps/reorder", (ctx) => {
    dbOf().reorderSteps(ctx.b("projectId"), or(ctx.b("ids"), []));
  });

  route("POST", "/api/step-presets", (ctx) => {
    const name = textOr(ctx.b("name"));
    const steps = pyIter(or(ctx.b("steps"), [])).filter((s) => truthy(strip(pyStr(s))));
    if (!truthy(name) || !steps.length) throw new ApiError(400, "A preset needs a name and at least one step.");
    return { id: dbOf().saveStepPreset(name, steps) };
  });

  route("POST", "/api/thumbnails", (ctx) => {
    const name = pyStr(or(ctx.b("name"), "image.png"));
    const ext = or(pySuffix(name).toLowerCase(), ".png");
    if (!THUMB_EXTS.has(ext)) throw new ApiError(400, "Choose a png, jpg, webp, bmp or gif image.");
    let data;
    try {
      data = b64decode(or(ctx.b("data"), ""));
    } catch {
      throw new ApiError(400, "The image could not be read.");
    }
    if (!data.length || data.length > 25 * 1024 * 1024) throw new ApiError(400, "The image is empty or larger than 25 MB.");
    const folder = path.join(dataDir(), "content-thumbnails");
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const filename = uuidHex() + ext;
    fs.writeFileSync(path.join(folder, filename), data, { mode: 0o600 });
    return { file: filename };
  });

  route("GET", "/api/thumbnails/([\\w.-]+)", (ctx) => {
    const file = path.join(dataDir(), "content-thumbnails", ctx.arg(1));
    if (!isFile(file)) throw new ApiError(404, "Not found.");
    return new Raw(fs.readFileSync(file), guessMime(file), { "Cache-Control": "max-age=3600" });
  });

  const routineJsonPaths = () => [path.join(dataDir(), "routine_presets.json"), path.join(dataDir(), "day_presets.json")];

  route("GET", "/api/routines", () => {
    const db = dbOf();
    const templates = db.getRoutineTemplates();
    const cmap = routineColorMap(templates);
    templates.forEach((t, index) => {
      t.displayColor = displayColor(t, cmap, index);
    });
    const [presetsPath, daysPath] = routineJsonPaths();
    return {
      templates,
      presets: db.getRoutinePresets(),
      dayPresets: readJson(presetsPath, []),
      dayPresetMap: readJson(daysPath, {}),
    };
  });

  const ruleFromBody = (raw) => {
    const rule = pyDict(or(raw, {}));
    for (const key of ["startDate", "endDate"]) {
      rule[key] = truthy(rule[key]) ? parseDt(rule[key]) : null;
    }
    const weekdays = [];
    for (const d of pyIter(or(rule.weekdays, []))) {
      const n = pyInt(d);
      if (n >= 0 && n <= 6) weekdays.push(pyInt(d));
    }
    rule.weekdays = weekdays;
    rule.frequency = or(rule.frequency, "daily");
    rule.interval = pyInt(or(rule.interval, 1));
    return rule;
  };

  route("POST", "/api/routines", (ctx) => {
    const start = parseDt(ctx.b("start"));
    const end = parseDt(ctx.b("end"));
    const title = or(cpSlice(textOr(ctx.b("title")), 40), "Untitled Task");
    const notes = or(textOr(ctx.b("notes")), null);
    const checklist = [];
    pyIter(or(ctx.b("checklist"), [])).forEach((item, i) => {
      if (!truthy(strip(pyStr(or(pyGet(item, "title"), ""))))) return;
      checklist.push({
        id: pyGet(item, "id"),
        title: strip(pyStr(or(pyGet(item, "title"), ""))),
        order: pyInt(pyGet(item, "order", i)),
      });
    });
    const eventId = dbOf().saveRoutine(state.userId, or(ctx.b("id"), null), title, notes, start, end, ruleFromBody(ctx.b("rule")),
      checklist, or(ctx.b("color"), null));
    return { id: eventId };
  });

  route("POST", "/api/routines/restore", (ctx) => {
    const template = or(ctx.b("template"), {});
    const eventId = pyGet(template, "id");
    if (!truthy(eventId)) throw new ApiError(400, "Missing routine.");
    rawExec("UPDATE Event SET deleted=0, updatedAt=? WHERE id=?", [nowMs(), eventId]);
    const itemIds = pyIter(or(pyGet(template, "checklistItems"), [])).map((i) => pyGet(i, "id")).filter((id) => truthy(id));
    if (itemIds.length) {
      rawExec(`UPDATE ChecklistItem SET deleted=0, updatedAt=? WHERE id IN (${placeholders(itemIds)})`, [nowMs(), ...itemIds]);
    }
    dbOf().saveRoutine(state.userId, eventId, or(pyGet(template, "title"), "Untitled Task"), pyGet(template, "notes"),
      parseDt(pyGet(template, "startAt")), parseDt(pyGet(template, "endAt")),
      ruleFromBody(pyGet(template, "recurrenceRule")), or(pyGet(template, "checklistItems"), []), null);
    rawExec("UPDATE Event SET color=?, updatedAt=? WHERE id=?", [pyGet(template, "color"), nowMs(), eventId]);
  });

  route("DELETE", "/api/routines/([\\w-]+)", (ctx) => {
    dbOf().deleteEvent(ctx.arg(1));
  });

  route("POST", "/api/routine-presets", (ctx) => {
    const name = textOr(ctx.b("name"));
    if (!truthy(name)) throw new ApiError(400, "A name is required to save a preset.");
    return {
      id: dbOf().saveRoutinePreset(name, or(ctx.b("title"), name), or(ctx.b("startTime"), "09:00"),
        or(ctx.b("endTime"), "10:00"), or(ctx.b("notes"), ""), or(ctx.b("checklist"), [])),
    };
  });

  route("DELETE", "/api/routine-presets/([\\w-]+)", (ctx) => {
    dbOf().deleteRoutinePreset(ctx.arg(1));
  });

  route("PUT", "/api/day-presets", (ctx) => {
    const [presetsPath, daysPath] = routineJsonPaths();
    const body = bodyOf(ctx);
    if (pyIn("presets", body)) writeJson(presetsPath, or(ctx.b("presets"), []));
    if (pyIn("map", body)) writeJson(daysPath, or(ctx.b("map"), {}));
  });

  const boardPath = (targetType, targetId, label) => {
    if (targetType === "project") {
      return path.resolve(dataDir(), "whiteboard", "projects", `${or(safeName(targetId, 48), "project")}.cwboard`);
    }
    const link = dbOf().getWhiteboardLink(targetType, targetId);
    if (truthy(link) && truthy(link.path)) {
      const linked = path.resolve(dataDir(), String(link.path));
      if (insideDir(dataDir(), linked) && pySuffix(linked) === ".cwboard") return linked;
    }
    const name = `${or(safeName(targetType, 24), "board")}-${safeName(targetId, 40)}-${safeName(label, 34)}`.replace(/-+$/, "") + ".cwboard";
    const target = path.resolve(dataDir(), "whiteboard", "workspaces", name);
    if (!insideDir(dataDir(), target)) throw new ApiError(400, "Invalid whiteboard target.");
    return target;
  };

  const rel = (target) => {
    const resolved = path.resolve(target);
    const relative = path.relative(dataDir(), resolved);
    if (relative === "") return ".";
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return String(target);
    return relative.split(path.sep).join("/");
  };

  const resolveBoard = (relPath) => {
    const target = path.resolve(dataDir(), relPath);
    if (!insideDir(dataDir(), target) || pySuffix(target) !== ".cwboard") throw new ApiError(400, "Invalid whiteboard path.");
    return target;
  };

  route("GET", "/api/whiteboard/open", (ctx) => {
    const targetType = or(ctx.q("type"), "project");
    const targetId = or(ctx.q("id"), "");
    const label = or(ctx.q("label"), "Whiteboard");
    if (!truthy(targetId)) throw new ApiError(400, "Missing whiteboard target.");
    const file = boardPath(targetType, targetId, label);
    let payload;
    if (isFile(file)) {
      payload = or(readJson(file, null), emptyBoard(label));
      if (targetType === "project" && pyGet(payload, "project_name") !== label) {
        payload.project_name = label;
        writeJson(file, payload);
      }
    } else {
      payload = emptyBoard(label);
      writeJson(file, payload);
    }
    if (targetType !== "project") dbOf().upsertWhiteboardLink(targetType, targetId, label, rel(file));
    return { path: rel(file), label: or(pyGet(payload, "project_name"), label), payload };
  });

  route("GET", "/api/whiteboard/file", (ctx) => {
    const file = resolveBoard(or(ctx.q("path"), ""));
    if (!isFile(file)) throw new ApiError(404, "Whiteboard not found.");
    const payload = readJson(file, null);
    if (payload === null) throw new ApiError(500, "This whiteboard file could not be read.");
    return { path: rel(file), label: or(pyGet(payload, "project_name"), pyStem(file)), payload };
  });

  route("PUT", "/api/whiteboard/file", (ctx) => {
    const file = resolveBoard(or(ctx.q("path"), ""));
    const payload = ctx.b("payload");
    if (!isDict(payload)) throw new ApiError(400, "Missing whiteboard payload.");
    writeJson(file, payload);
    return { savedAt: nowMs() };
  });

  route("GET", "/api/whiteboards", () => {
    const boards = [];
    const root = path.join(dataDir(), "whiteboard");
    const names = new Map(dbOf().getProjects().map((p) => [p.id, p.name]));
    const found = [];
    if (fs.existsSync(root)) walkMatches(root, ".cwboard", found);
    const ordered = sorted(found.map((file) => [file, pyMtime(file)]), (entry) => entry[1], true);
    for (const [file] of ordered) {
      if (path.resolve(file).split(/[\\/]+/).includes("session")) continue;
      const payload = or(readJson(file, {}), {});
      let label = or(pyGet(payload, "project_name"), pyStem(file));
      if (path.basename(path.dirname(file)) === "projects" && names.has(pyStem(file))) label = names.get(pyStem(file));
      boards.push({ path: rel(file), label, updatedAt: Math.trunc(pyMtime(file) * 1000) });
    }
    return boards;
  });

  const imagesDir = () => {
    const folder = path.join(dataDir(), "whiteboard", "images");
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return folder;
  };

  const imageNames = () => readJson(path.join(imagesDir(), "index.json"), {});

  const imageEntry = (file, names) => {
    const stat = fs.statSync(file);
    const name = path.basename(file);
    return {
      file: name, name: or(pyGet(names, name), name), path: file,
      url: `/api/whiteboard/images/${name}`, size: stat.size, updatedAt: Math.trunc(pyMtime(file) * 1000),
    };
  };

  const storeImage = (data, name, ext) => {
    if (!data.length) throw new ApiError(400, "The image is empty.");
    if (data.length > MAX_IMAGE_BYTES) throw new ApiError(400, "Images can be up to 40 MB.");
    if (!THUMB_EXTS.has(ext)) ext = ".png";
    const folder = imagesDir();
    const filename = uuidHex() + ext;
    fs.writeFileSync(path.join(folder, filename), data, { mode: 0o600 });
    const names = imageNames();
    if (!isDict(names)) throw new TypeError(`'${pyType(names)}' object does not support item assignment`);
    names[filename] = or(name, filename);
    writeJson(path.join(folder, "index.json"), names);
    return imageEntry(path.join(folder, filename), names);
  };

  route("GET", "/api/whiteboard/images", () => {
    const folder = imagesDir();
    const names = imageNames();
    const files = fs.readdirSync(folder)
      .map((name) => path.join(folder, name))
      .filter((file) => isFile(file) && THUMB_EXTS.has(pySuffix(file).toLowerCase()));
    return sorted(files.map((file) => [file, pyMtime(file)]), (entry) => entry[1], true).map(([file]) => imageEntry(file, names));
  });

  route("POST", "/api/whiteboard/images", (ctx) => {
    const name = pyStr(or(ctx.b("name"), "image.png"));
    let data;
    try {
      data = b64decode(or(ctx.b("data"), ""));
    } catch {
      throw new ApiError(400, "The image could not be read.");
    }
    return storeImage(data, name, or(pySuffix(name).toLowerCase(), ".png"));
  });

  route("POST", "/api/whiteboard/images/from-url", async (ctx) => {
    const url = strip(pyStr(or(ctx.b("url"), "")));
    if (url.startsWith("data:image/")) {
      const comma = url.indexOf(",");
      const header = comma < 0 ? url : url.slice(0, comma);
      const payload = comma < 0 ? "" : url.slice(comma + 1);
      const mime = header.slice(5).split(";")[0];
      return storeImage(b64decode(payload), "Pasted image", Object.prototype.hasOwnProperty.call(IMAGE_TYPES, mime) ? IMAGE_TYPES[mime] : ".png");
    }
    if (!/^https?:\/\//.test(url)) throw new ApiError(400, "Only web images can be added from a link.");
    let mime;
    let data;
    const controller = new AbortController();
    try {
      const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 Planizo" }, signal: controller.signal, redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
      mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      data = await readLimited(response, MAX_IMAGE_BYTES + 1, 20000, controller);
    } catch {
      throw new ApiError(502, "That image could not be downloaded.");
    }
    if (!Object.prototype.hasOwnProperty.call(IMAGE_TYPES, mime)) throw new ApiError(400, "That link is not an image.");
    const name = or(urlPathName(url), "Web image");
    return storeImage(data, name, IMAGE_TYPES[mime]);
  });

  route("GET", "/api/whiteboard/images/([\\w.-]+)", (ctx) => {
    const file = path.join(imagesDir(), ctx.arg(1));
    if (!isFile(file)) throw new ApiError(404, "Not found.");
    return new Raw(fs.readFileSync(file), guessMime(file), { "Cache-Control": "max-age=86400" });
  });

  route("GET", "/api/whiteboard/asset", (ctx) => {
    const raw = or(ctx.q("path"), "");
    const file = path.resolve(dataDir(), raw);
    if (!insideDir(dataDir(), file) || !THUMB_EXTS.has(pySuffix(file).toLowerCase()) || !isFile(file)) throw new ApiError(404, "Image not found.");
    return new Raw(fs.readFileSync(file), guessMime(file), { "Cache-Control": "max-age=3600" });
  });

  route("GET", "/api/export", () => {
    const payload = dbOf().exportData();
    const user = "user" in payload ? payload.user : {};
    for (const key of ["passwordHash", "supabaseUrl", "lastSyncError"]) {
      if (!isDict(user)) throw new TypeError(`'${pyType(user)}' object has no attribute 'pop'`);
      delete user[key];
    }
    return payload;
  });

  route("POST", "/api/import", (ctx) => {
    const payload = isDict(ctx.body) ? ctx.body : null;
    if (!truthy(payload) || !["Event", "Task", "Project", "ContentItem", "Note"].some((t) => Array.isArray(payload[t]))) {
      throw new ApiError(400, "This file is not a Planizo export.");
    }
    dbOf().importData(payload);
  });

  const backups = webBackups.register(() => ({
    dataDir: state.dataDir,
    db: state.db,
    afterRestore: () => {
      state.userId = (dbOf().getUser() || {}).id || state.userId;
      if (state.afterRestore) state.afterRestore();
    },
  }));

  route("GET", "/api/daily-log", (ctx) => {
    const key = or(ctx.q("date"), dateKey(new Date()));
    parseKey(key);
    const user = dbOf().getUser() || {};
    return dbOf().dailyLog(key, or(user.timeFormat, "h12"));
  });

  route("GET", "/api/whiteboard-link", (ctx) => ({ link: dbOf().getWhiteboardLink(ctx.q("type"), ctx.q("id")) }));

  const shownThisSession = new Set();

  route("GET", "/api/reminders", () => {
    const db = dbOf();
    const now = new Date();
    const candidates = [];
    for (const occ of db.taskOccurrencesForRange(startOfDay(now), now)) {
      if (truthy(occ.completed) || occ.status === "done") continue;
      let due = occ.dueDate;
      if (truthy(occ.time)) {
        const [hh, mm] = hhmm(occ.time);
        due = withHourMinute(due, hh, mm);
      }
      if (due <= now) {
        candidates.push({
          occurrenceId: occ.occurrenceId, sourceId: occ.sourceTaskId, kind: "task",
          title: or(occ.title, "Untitled task"), time: "time" in occ ? occ.time : null, dueAt: due,
        });
      }
    }
    for (const occ of db.occurrencesForRange(startOfDay(now), now)) {
      if (truthy(occ.eventCompleted)) continue;
      const start = occ.startAt;
      if (!truthy(occ.isRecurring) && start.getTime() === startOfDay(start).getTime()) {
        const fullStart = "fullStartAt" in occ ? occ.fullStartAt : start;
        if (fullStart < start || occ.endAt.getTime() === startOfDay(occ.endAt).getTime()) continue;
      }
      if (shift(now, { minutes: -5 }) <= start && start <= now) {
        candidates.push({
          occurrenceId: occ.occurrenceId, sourceId: occ.sourceEventId, kind: "schedule",
          title: or(occ.title, "Untitled task"), time: strftime(start, "%H:%M"), dueAt: start,
        });
      }
    }
    const ids = candidates.map((c) => c.occurrenceId).filter((id) => !shownThisSession.has(id));
    const idSet = new Set(ids);
    const shown = db.shownTaskReminderIds(ids);
    const result = candidates.filter((c) => idSet.has(c.occurrenceId) && !shown.has(c.occurrenceId));
    return sorted(result, (c) => c.dueAt);
  });

  route("POST", "/api/reminders/shown", (ctx) => {
    const occurrenceId = ctx.b("occurrenceId");
    if (occurrenceId !== null && typeof occurrenceId === "object") throw new TypeError(`unhashable type: '${pyType(occurrenceId)}'`);
    shownThisSession.add(occurrenceId);
    dbOf().markTaskReminderShown(occurrenceId, or(ctx.b("sourceId"), ""), state.userId);
  });

  const mailState = { messages: [], status: "Not connected", error: false, firstPoll: true };
  let mailLock = Promise.resolve();
  const withMailLock = (fn) => {
    const run = mailLock.then(fn, fn);
    mailLock = run.catch(() => {});
    return run;
  };

  const mailConfig = () => new workMail.WorkMailConfig(path.join(dataDir(), "work-mail.json"));

  const publicMailState = (extra = null) => {
    const configuredEmail = mailConfig().accountEmail();
    const out = {
      available: true, email: configuredEmail, configured: truthy(configuredEmail),
      messages: mailState.messages, status: mailState.status, error: mailState.error,
    };
    if (extra) Object.assign(out, extra);
    return out;
  };

  route("GET", "/api/mail", () => {
    if (!truthy(mailConfig().accountEmail())) {
      mailState.status = "Connect your Hostinger mailbox to begin.";
      mailState.error = false;
    }
    return publicMailState();
  });

  const mailRefresh = () => withMailLock(async () => {
    const config = mailConfig();
    let creds;
    try {
      creds = config.credentials();
    } catch {
      mailState.status = "The saved mailbox password could not be unlocked. Reconnect the account.";
      mailState.error = true;
      return publicMailState({ newMessages: [] });
    }
    if (!truthy(creds)) {
      mailState.status = "Connect your Hostinger mailbox to begin.";
      mailState.error = false;
      return publicMailState({ newMessages: [] });
    }
    const previousUid = pyInt(or(creds.last_seen_uid, 0));
    let messages;
    let maxUid;
    try {
      [messages, maxUid] = await workMail.fetchHostingerMail(creds);
    } catch (exc) {
      mailState.status = or(exc && exc.message, "Hostinger mail check failed.");
      mailState.error = true;
      return publicMailState({ newMessages: [] });
    }
    config.updateLastSeen(maxUid);
    mailState.messages = messages;
    mailState.status = "Connected";
    mailState.error = false;
    const fresh = messages.filter((m) => previousUid > 0 && pyInt(m.uid) > previousUid);
    if (mailState.firstPoll) {
      mailState.firstPoll = false;
      const freshIds = new Set(fresh.map((m) => m.uid));
      fresh.push(...messages.filter((m) => truthy(m.unread) && !freshIds.has(m.uid)));
    }
    return publicMailState({ newMessages: fresh });
  });

  route("POST", "/api/mail/refresh", () => mailRefresh());

  route("POST", "/api/mail/account", async (ctx) => {
    const emailAddress = textOr(ctx.b("email"));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) throw new ApiError(400, "Enter your full custom-domain email address.");
    try {
      mailConfig().saveAccount(emailAddress, or(ctx.b("password"), ""));
    } catch (exc) {
      if (exc instanceof ValueError || (exc && exc.name === "ValueError")) throw new ApiError(400, exc.message);
      throw exc;
    }
    mailState.messages = [];
    mailState.firstPoll = true;
    return mailRefresh();
  });

  route("DELETE", "/api/mail/account", () => {
    mailConfig().clear();
    mailState.messages = [];
    mailState.status = "Mailbox disconnected.";
    mailState.error = false;
    return publicMailState();
  });

  const mailRead = async (ctx) => {
    const uid = pyInt(ctx.b("uid"));
    const read = truthy(ctx.b("read"));
    const creds = mailConfig().credentials();
    if (!truthy(creds)) throw new ApiError(400, "Connect your Hostinger mailbox first.");
    try {
      await workMail.setHostingerMessageRead(creds, uid, read);
    } catch (exc) {
      throw new ApiError(502, or(exc && exc.message, `Hostinger could not mark this message as ${read ? "read" : "unread"}.`));
    }
    for (const message of mailState.messages) {
      if (pyInt(message.uid) === uid) message.unread = !read;
    }
    mailState.status = "Connected";
    mailState.error = false;
  };

  route("POST", "/api/mail/read", (ctx) => mailRead(ctx));

  return { mailState, mailRead, autoBackups: backups.autoBackups, rawExec, rawQuery };
}
