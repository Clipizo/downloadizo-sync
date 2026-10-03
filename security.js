"use strict";
const crypto = require("crypto");

function badRequest(message = "invalid request", status = 400) {
  return Object.assign(new Error(message), { publicMessage: message, status });
}

function hardening(req, res, next) {
  res.set({
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Strict-Transport-Security": "max-age=31536000",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  next();
}

function authentication(token, options = {}) {
  const digest = value => crypto.createHash("sha256").update(value).digest();
  const expected = digest(token);
  const failures = new Map();
  const now = options.now || Date.now;
  const windowMs = options.windowMs || 60000;
  let usage = { until: 0, count: 0 };
  return (req, res, next) => {
    if (typeof token !== "string" || token.length < 32) {
      return res.status(503).json({ error: "service unavailable" });
    }
    // Credentials in URLs leak into access logs, history and referrer headers.
    if (Object.hasOwn(req.query, "token")) {
      return res.status(400).json({ error: "use the X-Token header" });
    }
    const candidate = req.headers["x-token"];
    const valid = typeof candidate === "string" && candidate.length <= 512 &&
      crypto.timingSafeEqual(digest(candidate), expected);
    const time = now();
    if (!valid) {
      // Do not trust client-supplied forwarding headers. Failed attempts cannot
      // lock out a correctly authenticated device behind the same hosting proxy.
      const key = req.socket.remoteAddress || "unknown";
      let state = failures.get(key);
      if (!state || state.until <= time) state = { until: time + windowMs, count: 0 };
      state.count++;
      if (!failures.has(key) && failures.size >= 2048) failures.delete(failures.keys().next().value);
      failures.set(key, state);
      if (state.count > (options.failedLimit || 30)) {
        res.set("Retry-After", String(Math.max(1, Math.ceil((state.until - time) / 1000))));
        return res.status(429).json({ error: "too many requests" });
      }
      return res.status(401).json({ error: "unauthorized" });
    }
    if (usage.until <= time) usage = { until: time + windowMs, count: 0 };
    if (++usage.count > (options.requestLimit || 1200)) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((usage.until - time) / 1000))));
      return res.status(429).json({ error: "too many requests" });
    }
    next();
  };
}

function object(body, fields) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !fields.includes(key))) throw badRequest();
  return body;
}

function text(value, max, fallback = "") {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw badRequest();
  return value;
}

function webUrl(value) {
  const input = text(value, 8192);
  let url;
  try { url = new URL(input); } catch (_) { throw badRequest("invalid URL"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || /[\x00-\x20\x7f]/.test(input)) {
    throw badRequest("invalid URL");
  }
  return input;
}

function queueFields(body, patch = false) {
  const fields = patch
    ? ["status", "device", "progress", "filename", "error", "label", "url", "time_start", "time_end"]
    : ["url", "label", "device", "time_start", "time_end"];
  object(body, fields);
  if (!patch && !Object.hasOwn(body, "url")) throw badRequest("URL required");
  if (patch && !Object.keys(body).length) throw badRequest();
  const result = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "url") result[key] = webUrl(value);
    else if (key === "progress") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw badRequest();
      result[key] = value;
    } else if (key === "device") {
      if (!["pc", "mobile", "unknown", null].includes(value)) throw badRequest();
      result[key] = value;
    } else if (key === "status") {
      if (!["queued", "downloading", "done", "error", "paused"].includes(value)) throw badRequest();
      result[key] = value;
    } else if (key === "time_start" || key === "time_end") {
      result[key] = text(value, 32);
      if (result[key] && !/^(?:\d{1,6}:){0,2}\d{1,8}(?:\.\d{1,3})?$/.test(result[key])) throw badRequest();
    } else result[key] = text(value, key === "error" ? 2048 : 512);
  }
  return result;
}

function transferAddress(body) {
  object(body, ["address"]);
  const value = text(body.address, 300);
  if (!value) return "";
  const parsed = new URL(webUrl(value.includes("://") ? value : "http://" + value));
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw badRequest("invalid address");
  return value;
}

function youtubeCookies(body) {
  if (typeof body !== "string" || Buffer.byteLength(body) > 2 * 1024 * 1024) throw badRequest();
  const lines = [];
  for (const line of body.split(/\r?\n/)) {
    const row = line.startsWith("#HttpOnly_") ? line.slice(10) : line;
    if (!row || row.startsWith("#")) continue;
    const parts = row.split("\t");
    if (parts.length !== 7) continue;
    const domain = parts[0].replace(/^\./, "").toLowerCase();
    if (!(domain === "youtube.com" || domain.endsWith(".youtube.com"))) continue;
    if (!/^[a-z0-9.-]+$/.test(domain) || !["TRUE", "FALSE"].includes(parts[1]) ||
        !parts[2].startsWith("/") || !["TRUE", "FALSE"].includes(parts[3]) ||
        !/^\d+$/.test(parts[4]) || !parts[5] || /[\x00-\x08\x0b-\x1f\x7f]/.test(row)) continue;
    lines.push(line);
  }
  if (!lines.length) throw badRequest("no valid YouTube cookies");
  const result = "# Netscape HTTP Cookie File\n" + lines.join("\n") + "\n";
  if (lines.length > 10000 || Buffer.byteLength(result) > 2 * 1024 * 1024) throw badRequest("cookies too large", 413);
  return result;
}

function poToken(body) {
  object(body, ["token", "visitorData", "expireAt"]);
  const token = text(body.token, 8192);
  if (!token) throw badRequest("token required");
  const visitorData = text(body.visitorData, 8192);
  const expireAt = body.expireAt === undefined ? 0 : body.expireAt;
  if (typeof expireAt !== "number" || !Number.isFinite(expireAt) || expireAt < 0) throw badRequest();
  return { token, visitorData, expireAt, at: Date.now() };
}

module.exports = { badRequest, hardening, authentication, queueFields, transferAddress, youtubeCookies, poToken };
