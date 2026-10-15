import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const COOKIE = "cz_s";
const COOKIE_MAX_AGE = 400 * 24 * 3600;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 20;

const sha256 = (text) => crypto.createHash("sha256").update(String(text), "utf-8").digest("hex");

export function deviceLabel(userAgent) {
  const ua = String(userAgent || "");
  const browser = /Edg(e|iOS|A)?\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\/|FxiOS\//.test(ua) ? "Firefox" : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Unknown device";
}

export class AccessGate {
  constructor(dataDir) {
    this.file = path.join(String(dataDir), ".access.json");
    this.fails = new Map();
    this.state = this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      return { links: Array.isArray(data.links) ? data.links : [], sessions: data.sessions && typeof data.sessions === "object" ? data.sessions : {} };
    } catch {
      return { links: [], sessions: {} };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {}
  }

  get enabled() {
    return this.state.links.length > 0;
  }

  newLink(label = "owner") {
    const token = crypto.randomBytes(32).toString("base64url");
    this.state = this.load();
    this.state.links.push({ hash: sha256(token), label, created: new Date().toISOString() });
    this.save();
    return token;
  }

  replaceLinks(label = "owner") {
    const token = crypto.randomBytes(32).toString("base64url");
    this.state = this.load();
    this.state.links = [{ hash: sha256(token), label, created: new Date().toISOString() }];
    this.save();
    return token;
  }

  currentKey(req) {
    const session = this.sessionFrom(req);
    return session ? sha256(session) : "";
  }

  devices(req) {
    const current = this.currentKey(req);
    return Object.entries(this.state.sessions)
      .map(([key, entry]) => ({ id: key.slice(0, 16), device: entry.device || "Unknown device", created: entry.created, seen: entry.seen || entry.created, current: key === current }))
      .sort((a, b) => Number(b.current) - Number(a.current) || String(b.seen).localeCompare(String(a.seen)));
  }

  signOut(req, id) {
    const current = this.currentKey(req);
    let changed = false;
    for (const key of Object.keys(this.state.sessions)) {
      if (key === current || !(id === "others" || key.slice(0, 16) === id)) continue;
      delete this.state.sessions[key];
      changed = true;
    }
    if (changed) this.save();
  }

  revokeAll() {
    this.state = { links: [], sessions: {} };
    this.save();
  }

  clientIp(req) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").pop().trim();
    return forwarded || req.socket.remoteAddress || "?";
  }

  tooManyFails(ip) {
    const now = Date.now();
    const list = (this.fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (list.length) this.fails.set(ip, list);
    else this.fails.delete(ip);
    return list.length >= FAIL_LIMIT;
  }

  noteFail(ip) {
    const list = this.fails.get(ip) || [];
    list.push(Date.now());
    if (!this.fails.has(ip) && this.fails.size >= 2048) this.fails.delete(this.fails.keys().next().value);
    this.fails.set(ip, list.slice(-FAIL_LIMIT));
  }

  redeem(token, device = "") {
    const hash = sha256(token);
    const ok = this.state.links.some((link) => {
      const a = Buffer.from(link.hash, "hex");
      const b = Buffer.from(hash, "hex");
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    if (!ok) return null;
    const session = crypto.randomBytes(32).toString("base64url");
    this.state = this.load();
    this.state.sessions[sha256(session)] = { created: new Date().toISOString(), seen: new Date().toISOString(), device };
    this.save();
    return session;
  }

  sessionFrom(req) {
    const header = String(req.headers.cookie || "");
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === COOKIE) return rest.join("=");
    }
    return "";
  }

  allowed(req) {
    const session = this.sessionFrom(req);
    if (!session) return false;
    const entry = this.state.sessions[sha256(session)];
    if (!entry) return false;
    const today = new Date().toISOString().slice(0, 10);
    if (String(entry.seen || "").slice(0, 10) !== today || !entry.device) {
      entry.seen = new Date().toISOString();
      if (!entry.device) entry.device = deviceLabel(req.headers["user-agent"]);
      try {
        this.save();
      } catch {}
    }
    return true;
  }

  cookie(session, secure, cookiePath = "/") {
    return `${COOKIE}=${session}; Path=${cookiePath}; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  }
}
