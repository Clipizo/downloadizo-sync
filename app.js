// Downloadizo sync hub — shared queue backend (Hostinger Node.js).
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

app.get("/api/health", (req, res) => res.json({ status: "ok", items: load().length }));

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
  const allowed = ["status", "device", "progress", "filename", "error", "label"];
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
