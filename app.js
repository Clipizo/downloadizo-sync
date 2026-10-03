// Downloadizo sync hub — shared queue backend (Hostinger Node.js).
// Stores a JSON list of links + status; both desktop and phone sync to it.
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const security = require("./security");

function createApp(options = {}) {
const app = express();
app.disable("x-powered-by");
app.disable("etag");
app.set("query parser", "simple");
app.set("trust proxy", false);
app.use(security.hardening);
// Keep queue and credentials outside both the web root and disposable hosting builds.
const dataDir = options.dataDir || process.env.SYNC_DATA_DIR || path.join(os.homedir(), ".local", "share", "downloadizo-sync");
const TOKEN_FILE = options.tokenFile || process.env.SYNC_TOKEN_FILE || path.join(os.homedir(), ".config", "downloadizo-sync", "token");
const LEGACY_TOKEN_FILE = path.join(dataDir, ".sync_token");
// A rotated private token file takes precedence over stale hosting environment settings.
const tokenFile = fs.existsSync(TOKEN_FILE) ? TOKEN_FILE : LEGACY_TOKEN_FILE;
const TOKEN = options.token ?? (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : process.env.SYNC_TOKEN || "");
const STORE = path.join(dataDir, "queue.json");
const COOKIES_FILE = path.join(dataDir, "cookies.txt");
const POT_FILE = path.join(dataDir, "pot.json");
for (const file of [tokenFile, STORE, COOKIES_FILE, POT_FILE]) {
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
}

function load() {
  try {
    if (fs.statSync(STORE).size > 16 * 1024 * 1024) throw new Error("store limit");
    const queue = JSON.parse(fs.readFileSync(STORE, "utf8"));
    if (!Array.isArray(queue)) throw new Error("invalid store");
    return queue;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error; // Never overwrite corrupt or unreadable state with an empty queue.
  }
}
function write(file, data) {
  const scratch = path.join(dataDir, "Safe_to_delete");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const temporary = path.join(scratch, crypto.randomBytes(16).toString("hex") + ".tmp");
  fs.writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}
function save(q) {
  const data = JSON.stringify(q, null, 2);
  if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw security.badRequest("queue full", 409);
  write(STORE, data);
}
const json = express.json({ limit: "32kb", strict: true, inflate: false });

app.get("/api/health", (req, res) => res.json({ status: "ok" }));
// Authenticate before parsing bodies, including on unsupported API routes.
app.use("/api", security.authentication(TOKEN, options.auth));
app.use("/api", (req, res, next) => {
  if (["POST", "PATCH"].includes(req.method) && req.path !== "/cookies" && !req.is("application/json")) {
    return res.status(415).json({ error: "application/json required" });
  }
  next();
});

// ---- transfer address (phone registers its local server) ----
let transferAddr = "";
app.post("/api/transfer", json, (req, res) => {
  transferAddr = security.transferAddress(req.body);
  res.json({ ok: true, address: transferAddr });
});
app.get("/api/transfer", (req, res) => {
  res.json({ address: transferAddr });
});
app.delete("/api/transfer", (req, res) => {
  transferAddr = "";
  res.json({ ok: true });
});

// ---- shared browser cookies (PC exports -> phone uses, fixes YouTube 403s) ----
// Body is a Netscape cookies.txt (text/plain so the global JSON parser skips it).
app.get("/api/cookies", (req, res, next) => {
  try {
    if (fs.statSync(COOKIES_FILE).size > 2 * 1024 * 1024) throw security.badRequest("cookies too large", 413);
    res.type("text/plain").send(security.youtubeCookies(fs.readFileSync(COOKIES_FILE, "utf-8")));
  } catch (error) {
    if (error.code === "ENOENT") return res.status(404).json({ error: "no cookies shared yet" });
    next(error);
  }
});
app.post("/api/cookies", express.text({ limit: "2mb", type: "text/plain", inflate: false }), (req, res) => {
  if (!req.is("text/plain")) throw security.badRequest("text/plain required", 415);
  const body = security.youtubeCookies(req.body);
  write(COOKIES_FILE, body);
  res.json({ ok: true, bytes: Buffer.byteLength(body) });
});

// ---- shared PO token (PC's bgutil server mints -> phone uses for GVS) ----
app.get("/api/pot", (req, res, next) => {
  try {
    if (fs.statSync(POT_FILE).size > 32768) throw new Error("store limit");
    res.json(JSON.parse(fs.readFileSync(POT_FILE, "utf-8")));
  } catch (error) {
    if (error.code === "ENOENT") return res.status(404).json({ error: "no po token shared yet" });
    next(error);
  }
});
app.post("/api/pot", json, (req, res) => {
  write(POT_FILE, JSON.stringify(security.poToken(req.body)));
  res.json({ ok: true });
});

app.get("/api/queue", (req, res) => res.json(load()));

app.post("/api/queue", json, (req, res) => {
  const { url, label, device, time_start, time_end } = security.queueFields(req.body);
  const item = {
    id: crypto.randomBytes(8).toString("hex"),
    url,
    label: label || "",
    time_start: time_start || "",
    time_end: time_end || "",
    addedBy: device || "unknown",
    addedAt: Date.now(),
    status: "queued",   // queued | downloading | done | error
    device: null,       // which device is handling it: "pc" | "mobile" | null
    progress: 0,
    filename: "",
    error: "",
  };
  const q = load();
  if (q.length >= 5000) throw security.badRequest("queue full", 409);
  q.push(item);
  save(q);
  res.json(item);
});

app.patch("/api/queue/:id", json, (req, res) => {
  const fields = security.queueFields(req.body, true);
  const q = load();
  const it = q.find((x) => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: "not found" });
  Object.assign(it, fields);
  save(q);
  res.json(it);
});

app.delete("/api/queue/:id", (req, res) => {
  const before = load();
  const q = before.filter((x) => x.id !== req.params.id);
  save(q);
  res.json({ deleted: q.length < before.length });
});

app.get("/", (req, res) => res.type("text/plain").send("Downloadizo sync hub online. See /api/health"));
app.use((req, res) => res.status(404).json({ error: "not found" }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.publicMessage ? error.status : error.type === "entity.too.large" ? 413 :
    error.type === "encoding.unsupported" || error.type === "charset.unsupported" ? 415 :
    error.type === "entity.parse.failed" || error.type === "request.aborted" ? 400 : 500;
  res.status(status).json({ error: error.publicMessage || (status === 500 ? "internal server error" : "invalid request") });
});
return app;
}

const app = createApp();
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => console.log(`sync hub on ${PORT}`));
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
}

module.exports = app;
module.exports.createApp = createApp;
