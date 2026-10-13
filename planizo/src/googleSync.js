import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ApiError, Raw, route } from "./http.js";
import { msToLocal } from "./core/dates.js";
import { isoDate, truthy, wallDiffMs } from "./py.js";
import { protect, unprotect } from "./core/secretBox.js";

const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly"];
const PAST_DAYS = 30;
const FUTURE_DAYS = 365;
const AUTO_SYNC_SECONDS = 300;
const DAY_MS = 86_400_000;
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\p{Nd}{2,5})?\n?$/u;
const ONE_OFF = "NOT EXISTS (SELECT 1 FROM RecurrenceRule r WHERE r.eventId = e.id AND r.deleted = 0)";
const PY_SPACE = "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const STRIP_RE = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "g");

class GoogleError extends Error {}

function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function g(obj, key) {
  return isDict(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;
}

function need(obj, key) {
  if (!isDict(obj) || !Object.prototype.hasOwnProperty.call(obj, key)) throw new Error(`'${key}'`);
  return obj[key];
}

function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

function pyStrip(text) {
  return text.replace(STRIP_RE, "");
}

function pyInt(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot convert float to integer");
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = pyStrip(value);
    if (/^[+-]?\d+(_\d+)*$/.test(text)) return Number(text.replace(/_/g, ""));
    throw new Error(`invalid literal for int() with base 10: '${value}'`);
  }
  throw new Error("int() argument must be a string, a bytes-like object or a number");
}

function asciiOnly(text) {
  return text.replace(/[^\x20-\x7e\n]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function jsonString(text) {
  return JSON.stringify(String(text)).replace(/[^\x20-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function dumps(value) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return String(value);
  }
  if (typeof value === "string") return jsonString(value);
  if (Array.isArray(value)) return "[" + value.map(dumps).join(", ") + "]";
  return "{" + Object.entries(value).map(([k, v]) => jsonString(k) + ": " + dumps(v)).join(", ") + "}";
}

function quote(text) {
  return encodeURIComponent(String(text)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function quotePlus(text) {
  return quote(text).replace(/%20/g, "+");
}

function urlencode(query) {
  return Object.entries(query).map(([k, v]) => quotePlus(pyStr(k)) + "=" + quotePlus(pyStr(v))).join("&");
}

function htmlEscape(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function digits(text, at, count) {
  let value = 0;
  for (let i = 0; i < count; i += 1) {
    const c = text.charCodeAt(at + i);
    if (!(c >= 48 && c <= 57)) return null;
    value = value * 10 + (c - 48);
  }
  return value;
}

function parseHms(text, start, end) {
  const vals = [0, 0, 0, 0];
  let p = start;
  for (let i = 0; i < 3; i += 1) {
    const value = digits(text, p, 2);
    if (value === null) return { rv: -3, vals };
    vals[i] = value;
    p += 2;
    const c = text[p];
    p += 1;
    if (p >= end) return { rv: c !== "\u0000" ? 1 : 0, vals };
    if (c === ":") continue;
    if (c === ".") break;
    return { rv: -4, vals };
  }
  const remains = end - p;
  if (remains !== 6 && remains !== 3) return { rv: -3, vals };
  const frac = digits(text, p, remains);
  if (frac === null) return { rv: -3, vals };
  vals[3] = remains === 3 ? frac * 1000 : frac;
  p += remains;
  return { rv: text[p] !== "\u0000" ? 1 : 0, vals };
}

function daysIn(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function utcMs(year, month, day, hour, minute, second) {
  if (year >= 100) return Date.UTC(year, month - 1, day, hour, minute, second);
  const d = new Date(Date.UTC(2000, month - 1, day, hour, minute, second));
  d.setUTCFullYear(year);
  return d.getTime();
}

function localSeconds(year, month, day, hour, minute, second) {
  if (year >= 100) return new Date(year, month - 1, day, hour, minute, second).getTime() / 1000;
  const d = new Date(2000, month - 1, day, hour, minute, second);
  d.setFullYear(year);
  return d.getTime() / 1000;
}

function isoToMs(text) {
  const bad = () => new Error(`Invalid isoformat string: '${text}'`);
  const chars = Array.from(text);
  if (chars.length < 10) throw bad();
  const head = chars.slice(0, 10).join("");
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(head)) throw bad();
  const year = Number(head.slice(0, 4));
  const month = Number(head.slice(5, 7));
  const day = Number(head.slice(8, 10));
  let hour = 0;
  let minute = 0;
  let second = 0;
  let micro = 0;
  let offset = null;
  let tzMicro = 0;
  if (chars.length > 10) {
    const rest = chars.slice(11).join("");
    if (/[^\x00-\x7f]/.test(rest)) throw bad();
    const t = rest + "\u0000";
    const len = rest.length;
    let tzPos = 0;
    do {
      if (t[tzPos] === "+" || t[tzPos] === "-") break;
    } while (++tzPos < len);
    const time = parseHms(t, 0, tzPos);
    if (time.rv < 0) throw bad();
    [hour, minute, second, micro] = time.vals;
    if (tzPos === len) {
      if (time.rv === 1) throw bad();
    } else {
      const tzLen = len - tzPos;
      if (!(tzLen === 6 || tzLen === 9 || tzLen === 16)) throw bad();
      const sign = t[tzPos] === "-" ? -1 : 1;
      const zone = parseHms(t, tzPos + 1, len);
      if (zone.rv !== 0) throw bad();
      offset = sign * (zone.vals[0] * 3600 + zone.vals[1] * 60 + zone.vals[2]);
      tzMicro = sign * zone.vals[3];
    }
  }
  if (year < 1 || year > 9999) throw new Error(`year ${year} is out of range`);
  if (month < 1 || month > 12) throw new Error("month must be in 1..12");
  if (day < 1 || day > daysIn(year, month)) throw new Error("day is out of range for month");
  if (hour > 23) throw new Error("hour must be in 0..23");
  if (minute > 59) throw new Error("minute must be in 0..59");
  if (second > 59) throw new Error("second must be in 0..59");
  if (offset !== null) {
    const offsetMicro = offset * 1_000_000 + tzMicro;
    if (Math.abs(offsetMicro) >= 86_400_000_000) throw new Error("offset must be a timedelta strictly between -timedelta(hours=24) and timedelta(hours=24)");
    const total = utcMs(year, month, day, hour, minute, second) * 1000 + micro - offsetMicro;
    return Math.trunc((total / 1e6) * 1000);
  }
  return Math.trunc((localSeconds(year, month, day, hour, minute, second) + micro / 1e6) * 1000);
}

function msOf(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string" && value) {
    try {
      return isoToMs(value.replace(/Z/g, "+00:00"));
    } catch {
      return 0;
    }
  }
  return 0;
}

function iso(ms) {
  const d = msToLocal(ms);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function fromGoogle(field) {
  const dateTime = g(field, "dateTime");
  if (truthy(dateTime)) return msOf(dateTime);
  const text = need(field, "date");
  if (typeof text !== "string") throw new Error("strptime() argument 1 must be str, not " + (text === null ? "None" : typeof text));
  const m = /^([0-9]{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12][0-9]|0[1-9]|[1-9]| [1-9])/i.exec(text);
  if (!m) throw new Error(`time data '${text}' does not match format '%Y-%m-%d'`);
  if (m[0].length !== text.length) throw new Error(`unconverted data remains: ${text.slice(m[0].length)}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3].trim());
  if (day > daysIn(year, month)) throw new Error("day is out of range for month");
  return Math.trunc(localSeconds(year, month, day, 0, 0, 0) * 1000);
}

function toGoogle(startMs, endMs, patch = false) {
  const start = msToLocal(startMs);
  const end = msToLocal(endMs);
  const midnight = (d) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  const wholeDays = wallDiffMs(end, start) > 0 && midnight(start) && midnight(end);
  let s;
  let e;
  if (wholeDays) {
    s = { date: isoDate(start) };
    e = { date: isoDate(end) };
    if (patch) {
      s.dateTime = null;
      e.dateTime = null;
    }
  } else {
    s = { dateTime: iso(startMs) };
    e = { dateTime: iso(endMs) };
    if (patch) {
      s.date = null;
      e.date = null;
    }
  }
  return [s, e];
}

function hashOf(title, notes, startMs, endMs) {
  const text = dumps([truthy(title) ? title : "", truthy(notes) ? notes : "", pyInt(startMs), pyInt(endMs)]);
  return crypto.createHash("sha1").update(text, "utf-8").digest("hex");
}

function errorText(payload) {
  const err = g(payload, "error");
  if (isDict(err)) {
    const message = g(err, "message");
    return truthy(message) ? message : "Google returned an error.";
  }
  const description = g(payload, "error_description");
  if (truthy(description)) return description;
  const fallback = typeof err === "string" ? err : "";
  return truthy(fallback) ? fallback : "Google returned an error.";
}

export function register(deps) {
  const AUTH_URL = process.env.CALENDIZO_GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
  const TOKEN_URL = process.env.CALENDIZO_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
  const REVOKE_URL = process.env.CALENDIZO_GOOGLE_REVOKE_URL ?? "https://oauth2.googleapis.com/revoke";
  const USERINFO_URL = process.env.CALENDIZO_GOOGLE_USERINFO_URL ?? "https://openidconnect.googleapis.com/v1/userinfo";
  const API_URL = process.env.CALENDIZO_GOOGLE_API ?? "https://www.googleapis.com/calendar/v3";

  let stateQueue = Promise.resolve();
  let syncBusy = false;
  const pending = new Map();
  const status = { syncing: false };

  function withStateLock(fn) {
    const result = stateQueue.then(() => fn());
    stateQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function statePath() {
    return path.join(String(deps().dataDir), "google.json");
  }

  function load() {
    try {
      const raw = fs.readFileSync(statePath());
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
      return isDict(value) ? value : {};
    } catch {
      return {};
    }
  }

  function save(state) {
    const target = statePath();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = target + ".tmp";
    fs.writeFileSync(temp, asciiOnly(JSON.stringify(state, null, 2)), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temp, target);
  }

  function secretOf(state, key) {
    const blob = g(state, key);
    if (!truthy(blob) || typeof blob !== "string") return "";
    try {
      return unprotect(blob);
    } catch {
      return "";
    }
  }

  function tokenOf(state) {
    const raw = secretOf(state, "token");
    try {
      const value = raw ? JSON.parse(raw) : {};
      return isDict(value) ? value : {};
    } catch {
      return {};
    }
  }

  function calendarKey(state) {
    const email = g(state, "email");
    const calendarId = g(state, "calendar_id");
    return `${truthy(email) ? pyStr(email) : ""}/${truthy(calendarId) ? pyStr(calendarId) : "primary"}`;
  }

  function fromEnvironment() {
    return Boolean(pyStrip(process.env.CALENDIZO_GOOGLE_CLIENT_ID ?? "") && pyStrip(process.env.CALENDIZO_GOOGLE_CLIENT_SECRET ?? ""));
  }

  function ownerSetup() {
    return process.env.CALENDIZO_DEV === "1" && !fromEnvironment();
  }

  function appCredentials(state) {
    if (fromEnvironment()) return [pyStrip(process.env.CALENDIZO_GOOGLE_CLIENT_ID), pyStrip(process.env.CALENDIZO_GOOGLE_CLIENT_SECRET)];
    const clientId = g(state, "client_id");
    return [truthy(clientId) ? clientId : "", secretOf(state, "client_secret")];
  }

  async function http(method, url, token = null, body = null, form = null) {
    const headers = { Accept: "application/json" };
    let data;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (form !== null) {
      data = Buffer.from(urlencode(form), "utf-8");
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (body !== null) {
      data = Buffer.from(dumps(body), "utf-8");
      headers["Content-Type"] = "application/json";
    }
    let statusCode;
    let raw;
    const controller = new AbortController();
    let timer = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), 30000);
    };
    arm();
    try {
      const response = await fetch(url, { method, headers, body: data, redirect: "follow", signal: controller.signal });
      statusCode = response.status;
      arm();
      const chunks = [];
      if (response.body) {
        for await (const chunk of response.body) {
          chunks.push(Buffer.from(chunk));
          arm();
        }
      }
      raw = Buffer.concat(chunks);
    } catch {
      throw new GoogleError("Could not reach Google. Check the internet connection and try again.");
    } finally {
      clearTimeout(timer);
    }
    if (statusCode >= 200 && statusCode < 300) {
      return [statusCode, raw.length ? JSON.parse(raw.toString("utf-8")) : {}];
    }
    let payload;
    try {
      payload = raw.length ? JSON.parse(raw.toString("utf-8")) : {};
    } catch {
      payload = {};
    }
    return [statusCode, isDict(payload) ? payload : {}];
  }

  function accessToken(force = false) {
    return withStateLock(async () => {
      const state = load();
      const token = tokenOf(state);
      if (!truthy(g(token, "refresh_token"))) throw new GoogleError("Google Calendar is not connected.");
      const expiresAt = Object.prototype.hasOwnProperty.call(token, "expires_at") ? token.expires_at : 0;
      if (!force && truthy(g(token, "access_token")) && expiresAt > Date.now() / 1000 + 60) return token.access_token;
      const [clientId, clientSecret] = appCredentials(state);
      const [code, payload] = await http("POST", TOKEN_URL, null, null, {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      });
      if (code !== 200) {
        if (["invalid_grant", "unauthorized_client", "invalid_client"].includes(g(payload, "error"))) {
          state.token = null;
          state.last_error = "Google access was removed or has expired. Connect again.";
          save(state);
        }
        throw new GoogleError(errorText(payload));
      }
      const accessValue = g(payload, "access_token");
      token.access_token = truthy(accessValue) ? accessValue : "";
      const expiresIn = g(payload, "expires_in");
      token.expires_at = Date.now() / 1000 + pyInt(truthy(expiresIn) ? expiresIn : 3600);
      if (truthy(g(payload, "refresh_token"))) token.refresh_token = payload.refresh_token;
      state.token = protect(dumps(token));
      save(state);
      return token.access_token;
    });
  }

  async function call(method, apiPath, body = null, query = null) {
    const url = API_URL + apiPath + (truthy(query) ? "?" + urlencode(query) : "");
    let [code, payload] = await http(method, url, await accessToken(), body);
    if (code === 401) [code, payload] = await http(method, url, await accessToken(true), body);
    return [code, payload];
  }

  function eventsPath(calendarId, googleId = null) {
    const base = "/calendars/" + quote(calendarId) + "/events";
    return base + (truthy(googleId) ? "/" + quote(googleId) : "");
  }

  function sql() {
    return deps().db.sql;
  }

  function ensureTable() {
    const c = sql();
    c.run(`CREATE TABLE IF NOT EXISTS GoogleEventLink (
                eventId TEXT PRIMARY KEY NOT NULL, calendarKey TEXT NOT NULL, googleId TEXT NOT NULL,
                googleUpdated TEXT, localHash TEXT, syncedAt INTEGER)`);
    c.run("CREATE INDEX IF NOT EXISTS GoogleEventLink_google ON GoogleEventLink (calendarKey, googleId)");
  }

  function saveLink(eventId, key, item, localHash) {
    const googleId = need(item, "id");
    sql().run(
      "INSERT OR REPLACE INTO GoogleEventLink (eventId, calendarKey, googleId, googleUpdated, localHash, syncedAt) VALUES (?, ?, ?, ?, ?, ?)",
      [eventId, key, googleId, g(item, "updated"), localHash, Date.now()],
    );
  }

  function unlink(eventId) {
    sql().run("DELETE FROM GoogleEventLink WHERE eventId = ?", [eventId]);
  }

  function googleBody(row, patch = false) {
    const [start, end] = toGoogle(pyInt(row.startAt), pyInt(row.endAt), patch);
    const body = {
      summary: truthy(row.title) ? row.title : "Untitled event",
      description: truthy(row.notes) ? row.notes : "",
      start,
      end,
    };
    if (!patch) body.extendedProperties = { private: { calendizoId: row.id } };
    return body;
  }

  function localValues(item) {
    const summary = g(item, "summary");
    const description = g(item, "description");
    return [truthy(summary) ? summary : "Untitled event", truthy(description) ? description : null, fromGoogle(need(item, "start")), fromGoogle(need(item, "end"))];
  }

  async function runSync(pushExisting) {
    const { db, userId } = deps();
    const state = load();
    const stateCalendar = g(state, "calendar_id");
    const calendarId = truthy(stateCalendar) ? stateCalendar : "primary";
    const key = calendarKey(state);
    ensureTable();
    const now = Date.now();
    const tMin = now - PAST_DAYS * DAY_MS;
    const tMax = now + FUTURE_DAYS * DAY_MS;
    const counts = { imported: 0, sent: 0, updatedHere: 0, updatedInGoogle: 0, deletedHere: 0, deletedInGoogle: 0 };

    const remote = new Map();
    let page = null;
    while (true) {
      const query = { singleEvents: "true", showDeleted: "true", maxResults: "2500", timeMin: iso(tMin), timeMax: iso(tMax) };
      if (truthy(page)) query.pageToken = page;
      const [code, payload] = await call("GET", eventsPath(calendarId), null, query);
      if (code !== 200) throw new GoogleError(errorText(payload));
      const items = g(payload, "items");
      for (const item of truthy(items) ? items : []) remote.set(need(item, "id"), item);
      page = g(payload, "nextPageToken");
      if (!truthy(page)) break;
    }

    const links = new Map();
    for (const r of sql().all("SELECT * FROM GoogleEventLink WHERE calendarKey = ?", [key])) links.set(r.eventId, r);
    const linkedGoogle = new Set();

    for (const [eventId, link] of links) {
      const found = sql().get(`SELECT e.*, (${ONE_OFF}) AS oneOff FROM Event e WHERE e.id = ?`, [eventId]);
      const row = found || null;
      const googleId = link.googleId;
      if (row === null || !truthy(row.oneOff)) {
        unlink(eventId);
        continue;
      }
      let item = remote.has(googleId) ? remote.get(googleId) : null;
      if (truthy(row.deleted)) {
        if (item === null || g(item, "status") !== "cancelled") {
          const [code, payload] = await call("DELETE", eventsPath(calendarId, googleId));
          if (![200, 204, 404, 410].includes(code)) throw new GoogleError(errorText(payload));
          counts.deletedInGoogle += 1;
        }
        unlink(eventId);
        continue;
      }
      if (item === null) {
        const [code, payload] = await call("GET", eventsPath(calendarId, googleId));
        if (code === 404 || code === 410) item = { id: googleId, status: "cancelled" };
        else if (code === 200) item = payload;
        else throw new GoogleError(errorText(payload));
      }
      linkedGoogle.add(googleId);
      if (g(item, "status") === "cancelled") {
        db.deleteEvent(eventId);
        unlink(eventId);
        counts.deletedHere += 1;
        continue;
      }
      const localHash = hashOf(row.title, row.notes, row.startAt, row.endAt);
      let localChanged = localHash !== link.localHash;
      let remoteChanged = g(item, "updated") !== link.googleUpdated;
      if (localChanged && remoteChanged) {
        if (msOf(row.updatedAt) >= msOf(g(item, "updated"))) remoteChanged = false;
        else localChanged = false;
      }
      if (localChanged) {
        const [code, payload] = await call("PATCH", eventsPath(calendarId, googleId), googleBody(row, true));
        if (code !== 200) throw new GoogleError(errorText(payload));
        saveLink(eventId, key, payload, localHash);
        counts.updatedInGoogle += 1;
      } else if (remoteChanged) {
        const [title, notes, start, end] = localValues(item);
        db.updateEvent(eventId, title, notes, msToLocal(start), msToLocal(end));
        saveLink(eventId, key, item, hashOf(title, notes, start, end));
        counts.updatedHere += 1;
      }
    }

    for (const [googleId, item] of remote) {
      const eventType = g(item, "eventType");
      if (linkedGoogle.has(googleId) || g(item, "status") === "cancelled" || !(eventType === null || eventType === "default")) continue;
      if (!truthy(g(item, "start")) || !truthy(g(item, "end"))) continue;
      const extended = g(item, "extendedProperties");
      const privateProps = g(truthy(extended) ? extended : {}, "private");
      const ownId = g(truthy(privateProps) ? privateProps : {}, "calendizoId");
      if (truthy(ownId) && !links.has(ownId)) {
        const mine = sql().get(`SELECT e.* FROM Event e WHERE e.id = ? AND e.deleted = 0 AND ${ONE_OFF}`, [ownId]);
        if (mine) {
          saveLink(ownId, key, item, hashOf(mine.title, mine.notes, mine.startAt, mine.endAt));
          linkedGoogle.add(googleId);
          continue;
        }
      }
      const [title, notes, start, end] = localValues(item);
      const eventId = db.createEvent(userId, title, notes, msToLocal(start), msToLocal(end));
      saveLink(eventId, key, item, hashOf(title, notes, start, end));
      counts.imported += 1;
    }

    const linkedSince = g(state, "linked_since");
    const since = pyInt(truthy(linkedSince) ? linkedSince : now);
    const fresh = sql().all(
      `SELECT e.* FROM Event e WHERE e.deleted = 0 AND ${ONE_OFF} AND e.endAt > ? AND e.startAt < ?
                    AND NOT EXISTS (SELECT 1 FROM GoogleEventLink g WHERE g.eventId = e.id AND g.calendarKey = ?)`,
      [tMin, tMax, key],
    );
    for (const row of fresh) {
      if (!pushExisting && msOf(row.createdAt) < since) continue;
      const [code, payload] = await call("POST", eventsPath(calendarId), googleBody(row));
      if (code !== 200 && code !== 201) throw new GoogleError(errorText(payload));
      saveLink(row.id, key, payload, hashOf(row.title, row.notes, row.startAt, row.endAt));
      counts.sent += 1;
    }
    return counts;
  }

  async function sync(pushExisting = false) {
    if (syncBusy) throw new GoogleError("A sync is already running.");
    syncBusy = true;
    status.syncing = true;
    try {
      const counts = await runSync(pushExisting);
      await withStateLock(() => {
        const state = load();
        Object.assign(state, { last_sync: Date.now(), last_result: counts, last_error: null });
        save(state);
      });
      return counts;
    } catch (exc) {
      if (exc instanceof GoogleError) {
        await withStateLock(() => {
          const state = load();
          if (truthy(g(state, "token"))) state.last_error = exc.message;
          save(state);
        });
      }
      throw exc;
    } finally {
      status.syncing = false;
      syncBusy = false;
    }
  }

  async function syncQuietly(pushExisting = false) {
    try {
      await sync(pushExisting);
    } catch {}
  }

  function later(fn, ms) {
    const timer = setTimeout(() => Promise.resolve().then(fn).catch((err) => console.error(err && err.stack ? err.stack : err)), ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function autoSync() {
    const tick = async () => {
      try {
        if (truthy(g(tokenOf(load()), "refresh_token"))) await syncQuietly();
      } catch (err) {
        console.error(err && err.stack ? err.stack : err);
      } finally {
        later(tick, AUTO_SYNC_SECONDS * 1000);
      }
    };
    later(tick, 20000);
  }

  function publicState() {
    const state = load();
    const env = fromEnvironment();
    const clientId = g(state, "client_id");
    const email = g(state, "email");
    const calendarId = g(state, "calendar_id");
    const calendarName = g(state, "calendar_name");
    return {
      configured: env || Boolean(truthy(clientId) && truthy(g(state, "client_secret"))),
      ownerSetup: ownerSetup(),
      clientId: env ? "" : truthy(clientId) ? clientId : "",
      connected: truthy(g(tokenOf(state), "refresh_token")),
      email: truthy(email) ? email : "",
      calendarId: truthy(calendarId) ? calendarId : "primary",
      calendarName: truthy(calendarName) ? calendarName : "",
      lastSync: g(state, "last_sync"),
      lastResult: g(state, "last_result"),
      lastError: g(state, "last_error"),
      syncing: status.syncing,
    };
  }

  route("GET", "/api/google/state", () => publicState());

  route("POST", "/api/google/config", async (ctx) => {
    if (!ownerSetup()) throw new ApiError(403, "Google sign-in is set up by the app's owner.");
    const rawId = ctx.b("clientId");
    const rawSecret = ctx.b("clientSecret");
    const clientId = pyStrip(pyStr(truthy(rawId) ? rawId : ""));
    const clientSecret = pyStrip(pyStr(truthy(rawSecret) ? rawSecret : ""));
    if (!clientId.endsWith(".apps.googleusercontent.com")) throw new ApiError(400, "That isn't a Google OAuth client ID. It ends with .apps.googleusercontent.com.");
    if (!clientSecret) throw new ApiError(400, "Paste the client secret too.");
    await withStateLock(() => {
      const state = load();
      if (g(state, "client_id") !== clientId) Object.assign(state, { token: null, email: "", last_error: null });
      state.client_id = clientId;
      state.client_secret = protect(clientSecret);
      save(state);
    });
    return publicState();
  });

  route("POST", "/api/google/connect", (ctx) => {
    const rawOrigin = ctx.b("origin");
    const origin = pyStr(truthy(rawOrigin) ? rawOrigin : "");
    if (!LOCAL_ORIGIN.test(origin)) throw new ApiError(400, "Connect from the Planizo page on this PC.");
    const [clientId, clientSecret] = appCredentials(load());
    if (!truthy(clientId) || !truthy(clientSecret)) throw new ApiError(400, "Google sign-in isn't set up yet.");
    const verifier = crypto.randomBytes(64).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
    const nonce = crypto.randomBytes(24).toString("base64url");
    const redirect = origin + "/api/google/callback";
    const nowSeconds = Date.now() / 1000;
    for (const [old, value] of [...pending]) {
      if (nowSeconds - value.at > 900) pending.delete(old);
    }
    pending.set(nonce, { verifier, redirect, at: Date.now() / 1000 });
    const query = {
      client_id: clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    return { url: AUTH_URL + "?" + urlencode(query), redirectUri: redirect };
  });

  async function backPage(ok, message) {
    if (!ok) {
      await withStateLock(() => {
        const state = load();
        state.last_error = message;
        save(state);
      });
    }
    const target = "/#/calendar?google=" + (ok ? "connected" : "error");
    const body =
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Planizo</title>' +
      `<meta http-equiv="refresh" content="${ok ? "0.4" : "5"};url=${htmlEscape(target)}">` +
      '<body style="margin:0;padding:48px 24px;background:#0a0a0a;color:#f2f2f2;font:16px/1.5 system-ui,sans-serif">' +
      `<p>${htmlEscape(message)}</p>` +
      `<p><a style="color:#bfff00;font-weight:700" href="${target}">Back to Planizo</a></p></body>`;
    return new Raw(Buffer.from(body, "utf-8"), "text/html; charset=utf-8");
  }

  route("GET", "/api/google/callback", async (ctx) => {
    const stateKey = ctx.q("state") || "";
    const entry = pending.has(stateKey) ? pending.get(stateKey) : null;
    pending.delete(stateKey);
    if (ctx.q("error")) {
      return backPage(false, ctx.q("error") === "access_denied" ? "Google sign-in was cancelled." : `Google sign-in failed (${ctx.q("error")}).`);
    }
    if (!entry) return backPage(false, "This sign-in link has expired. Please connect again.");
    const [clientId, clientSecret] = appCredentials(load());
    let code;
    let payload;
    try {
      [code, payload] = await http("POST", TOKEN_URL, null, null, {
        grant_type: "authorization_code",
        code: ctx.q("code") || "",
        redirect_uri: entry.redirect,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: entry.verifier,
      });
    } catch (exc) {
      if (exc instanceof GoogleError) return backPage(false, exc.message);
      throw exc;
    }
    if (code !== 200 || !truthy(g(payload, "refresh_token"))) return backPage(false, "Google sign-in failed: " + errorText(payload));
    const accessValue = g(payload, "access_token");
    const expiresIn = g(payload, "expires_in");
    const token = {
      refresh_token: payload.refresh_token,
      access_token: truthy(accessValue) ? accessValue : "",
      expires_at: Date.now() / 1000 + pyInt(truthy(expiresIn) ? expiresIn : 3600),
    };
    let email = "";
    try {
      const [infoCode, info] = await http("GET", USERINFO_URL, token.access_token);
      if (infoCode === 200) {
        const value = g(info, "email");
        email = truthy(value) ? value : "";
      }
    } catch (exc) {
      if (!(exc instanceof GoogleError)) throw exc;
    }
    await withStateLock(() => {
      const state = load();
      const freshLink = g(state, "email") !== email || !truthy(g(state, "calendar_id"));
      Object.assign(state, { token: protect(dumps(token)), email, last_error: null });
      if (freshLink) Object.assign(state, { calendar_id: "primary", calendar_name: truthy(email) ? email : "Primary calendar", linked_since: Date.now() });
      save(state);
    });
    void syncQuietly();
    return backPage(true, "Google Calendar is connected. Taking you back to Planizo…");
  });

  route("GET", "/api/google/calendars", async () => {
    let code;
    let payload;
    try {
      [code, payload] = await call("GET", "/users/me/calendarList", null, { minAccessRole: "writer" });
    } catch (exc) {
      if (exc instanceof GoogleError) throw new ApiError(502, exc.message);
      throw exc;
    }
    if (code !== 200) throw new ApiError(502, errorText(payload));
    const items = g(payload, "items");
    return (truthy(items) ? items : []).map((c) => {
      const id = need(c, "id");
      const override = g(c, "summaryOverride");
      const summary = g(c, "summary");
      return { id, name: truthy(override) ? override : truthy(summary) ? summary : id, primary: truthy(g(c, "primary")) };
    });
  });

  route("POST", "/api/google/calendar", async (ctx) => {
    const rawId = ctx.b("calendarId");
    const calendarId = pyStrip(pyStr(truthy(rawId) ? rawId : ""));
    if (!calendarId) throw new ApiError(400, "Choose a calendar.");
    await withStateLock(() => {
      const state = load();
      if (g(state, "calendar_id") !== calendarId) {
        const name = ctx.b("name");
        Object.assign(state, { calendar_id: calendarId, calendar_name: pyStr(truthy(name) ? name : calendarId), linked_since: Date.now(), last_result: null });
        save(state);
      }
    });
    void syncQuietly();
    return publicState();
  });

  route("POST", "/api/google/sync", async (ctx) => {
    try {
      await sync(truthy(ctx.b("pushExisting")));
    } catch (exc) {
      if (exc instanceof GoogleError) throw new ApiError(exc.message.includes("already running") ? 409 : 502, exc.message);
      throw exc;
    }
    return publicState();
  });

  route("POST", "/api/google/disconnect", async () => {
    await withStateLock(async () => {
      const state = load();
      const token = tokenOf(state);
      if (truthy(g(token, "refresh_token"))) {
        try {
          await http("POST", REVOKE_URL, null, null, { token: token.refresh_token });
        } catch (exc) {
          if (!(exc instanceof GoogleError)) throw exc;
        }
      }
      Object.assign(state, { token: null, last_error: null });
      save(state);
    });
    return publicState();
  });

  return autoSync;
}
