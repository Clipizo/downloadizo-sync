// Downloadizo sync hub â€” shared queue backend (Hostinger Node.js).
// Stores a JSON list of links + status; both desktop and phone sync to it.
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const TOKEN_FILE = path.join(__dirname, ".sync_token");
const TOKEN = process.env.SYNC_TOKEN || (fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, "utf8").trim() : "");
const STORE = path.join(__dirname, "queue.json");

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch (_) { return []; }
}
function save(q) { fs.writeFileSync(STORE, JSON.stringify(q, null, 2)); }

function auth(req, res, next) {
  if (!TOKEN) return res.status(500).json({ error: "SYNC_TOKEN not set" });
  const t = req.headers["x-token"] || req.query.token;
  if (!t || t !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/api/health", (req, res) => res.json({ status: "ok", items: load().length, transfer: transferAddr }));

// ---- transfer address (phone registers its local server) ----
let transferAddr = "";
app.post("/api/transfer", auth, (req, res) => {
  transferAddr = (req.body || {}).address || "";
  res.json({ ok: true, address: transferAddr });
});
app.get("/api/transfer", auth, (req, res) => {
  res.json({ address: transferAddr });
});
app.delete("/api/transfer", auth, (req, res) => {
  transferAddr = "";
  res.json({ ok: true });
});

// ---- shared browser cookies (PC exports -> phone uses, fixes YouTube 403s) ----
// Body is a Netscape cookies.txt (text/plain so the global JSON parser skips it).
const COOKIES_FILE = path.join(__dirname, "cookies.txt");
app.get("/api/cookies", auth, (req, res) => {
  try {
    res.type("text/plain").send(fs.readFileSync(COOKIES_FILE, "utf-8"));
  } catch (_) {
    res.status(404).json({ error: "no cookies shared yet" });
  }
});
app.post("/api/cookies", auth, express.text({ limit: "2mb", type: "text/plain" }), (req, res) => {
  const body = typeof req.body === "string" ? req.body : "";
  if (!body.includes(".youtube.com")) {
    return res.status(400).json({ error: "not a YouTube cookies file" });
  }
  fs.writeFileSync(COOKIES_FILE, body);
  res.json({ ok: true, bytes: body.length });
});

app.get("/api/queue", auth, (req, res) => res.json(load()));

app.post("/api/queue", auth, (req, res) => {
  const { url, label, device, time_start, time_end } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ error: "url required" });
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
  q.push(item);
  save(q);
  res.json(item);
});

app.patch("/api/queue/:id", auth, (req, res) => {
  const q = load();
  const it = q.find((x) => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: "not found" });
  const allowed = ["status", "device", "progress", "filename", "error", "label", "url", "time_start", "time_end"];
  for (const k of allowed) if (k in (req.body || {})) it[k] = req.body[k];
  save(q);
  res.json(it);
});

app.delete("/api/queue/:id", auth, (req, res) => {
  const before = load();
  const q = before.filter((x) => x.id !== req.params.id);
  save(q);
  res.json({ deleted: q.length < before.length });
});

app.get("/", (req, res) => res.send("Downloadizo sync hub online. See /api/health"));

if (require.main === module) {
  app.listen(PORT, () => console.log(`sync hub on ${PORT}, token set: ${Boolean(TOKEN)}`));
}

module.exports = app;
