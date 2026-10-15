import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { route, ApiError, Raw } from "./http.js";
import { Sqlite } from "./core/sqlite.js";
import * as core from "./core/backups.js";
import { isoLocal, shift, strftime, truthy, wallDiffMs } from "./py.js";

export const FOLDERS = ["whiteboard", "daily-logs", "content-thumbnails"];
export const FILES = ["routine_presets.json", "day_presets.json", "work-mail.json", "agent-chats.json", "deepseek-agent.json", "google.json"];
export const KEEP = 60;
export const LOCK_STALE_SECONDS = 600;
export const LAUNCH_DELAY_MS = 2 * 60 * 1000;
const SIGNATURE_FILE = ".last-backup-signature";
export const NAME_RX = /^Backup_(\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2})_(\p{Nd}{2})-(\p{Nd}{2})-(\p{Nd}{2})_(.+)\.zip$/u;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function unlinkMissingOk(p) {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function sources(base) {
  const out = [];
  for (const name of FOLDERS) {
    const p = path.join(base, name);
    if (isDir(p)) {
      out.push({ type: "folder", kind: `data_${name}`, archivePrefix: `data/${name}`, targetMode: "data_dir", relativeTarget: name, path: p });
    }
  }
  for (const name of FILES) {
    const p = path.join(base, name);
    if (isFile(p)) {
      out.push({ type: "file", kind: "data_file", archivePath: `data/${name}`, targetMode: "data_dir", relativeTarget: name, path: p });
    }
  }
  return out;
}

function inputSignature(base, db) {
  const parts = [];
  const add = (file) => {
    try {
      const st = fs.statSync(file);
      if (st.isFile()) parts.push([path.relative(base, file).split(path.sep).join("/"), st.size, Math.trunc(st.mtimeMs)]);
    } catch {}
  };
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) add(full);
    }
  };
  add(db);
  add(db + "-wal");
  for (const name of FOLDERS) walk(path.join(base, name));
  for (const name of FILES) add(path.join(base, name));
  parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function readSignature(root) {
  try {
    return fs.readFileSync(path.join(root, SIGNATURE_FILE), "utf-8").trim();
  } catch {
    return "";
  }
}

function writeSignature(root, signature) {
  try {
    const file = path.join(root, SIGNATURE_FILE);
    fs.writeFileSync(file + ".tmp", signature + "\n", { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  } catch {}
}

function lock(root) {
  const lockPath = path.join(root, ".backup.lock");
  for (let i = 0; i < 2; i += 1) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx", 0o600));
      return lockPath;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() / 1000 - fs.statSync(lockPath).mtimeMs / 1000 < LOCK_STALE_SECONDS) return null;
        fs.unlinkSync(lockPath);
      } catch (inner) {
        if (inner.code !== "ENOENT") throw inner;
      }
    }
  }
  return null;
}

export function create(dataDir, dbPath, { reason = "manual", minIntervalMinutes = 0, keep = KEEP, sql = null } = {}) {
  const base = core.resolvePath(dataDir);
  const root = core.backupsDir(base);
  const lockPath = lock(root);
  if (lockPath === null) return null;
  try {
    return createLocked(base, core.resolvePath(dbPath), root, reason, minIntervalMinutes, keep, sql);
  } finally {
    unlinkMissingOk(lockPath);
  }
}

function createLocked(base, db, root, reason, minIntervalMinutes, keep, sql) {
  const now = new Date();
  if (minIntervalMinutes > 0) {
    const cutoff = shift(now, { minutes: -minIntervalMinutes });
    if (core.listBackups(base).some((p) => wallDiffMs(new Date(fs.statSync(p).mtimeMs), cutoff) >= 0)) return null;
  }
  const signature = inputSignature(base, db);
  if (minIntervalMinutes > 0 && signature === readSignature(root)) return null;
  const archive = path.join(root, `Backup_${strftime(now, "%Y-%m-%d_%H-%M-%S")}_${core.safeSlug(reason)}.zip`);
  if (fs.existsSync(archive)) return archive;
  const tempArchive = path.join(root, `.${path.basename(archive)}.${process.pid}.tmp`);
  const manifest = {
    version: 2,
    app: "Calendizo Web",
    reason,
    createdAt: isoLocal(now),
    dataDir: base,
    dbPath: db,
    files: [],
    restoreRoots: [],
    restoreFiles: [],
    checks: {},
    warnings: [],
  };
  try {
    const temp = fs.mkdtempSync(path.join(root, "calendizo-backup-"));
    try {
      const tempDb = path.join(temp, "calendizo.db");
      const zf = new core.ZipWriter(tempArchive);
      try {
        if (fs.existsSync(db)) {
          core.backupSqlite(db, tempDb, sql);
          core.scrubSecrets(tempDb);
          manifest.checks.sourceDbIntegrity = core.sqliteIntegrity(db, sql);
          manifest.checks.backupDbIntegrity = core.sqliteIntegrity(tempDb);
          core.addFile(zf, manifest, tempDb, "calendizo.db", db, "sqlite_db");
        }
        const seen = new Set();
        for (const source of sources(base)) {
          const entry = Object.fromEntries(Object.entries(source).filter(([k]) => k !== "path"));
          if (source.type === "folder") {
            core.addFolder(zf, manifest, source.path, source.archivePrefix, source.kind, seen);
            manifest.restoreRoots.push(entry);
          } else {
            core.addFile(zf, manifest, source.path, source.archivePath, source.path, source.kind);
            manifest.restoreFiles.push(entry);
          }
        }
        manifest.checks.fileCount = manifest.files.length;
        manifest.checks.cwboardCount = manifest.files.filter((f) => f.archivePath.toLowerCase().endsWith(".cwboard")).length;
        zf.writestr(core.MANIFEST_NAME, JSON.stringify(manifest, null, 2));
        zf.close();
      } finally {
        zf.abort();
      }
      core.verifyArchive(tempArchive);
    } finally {
      try {
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {}
    }
    fs.renameSync(tempArchive, archive);
  } catch (err) {
    unlinkMissingOk(tempArchive);
    throw err;
  }
  writeSignature(root, signature);
  core.pruneBackups(root, keep);
  return archive;
}

export function listing(dataDir) {
  return core.listBackups(dataDir).map((p) => {
    const name = path.basename(p);
    const match = NAME_RX.exec(name);
    const st = fs.statSync(p);
    const created = match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}` : isoLocal(new Date(st.mtimeMs));
    return { name, createdAt: created, reason: match ? match[5] : "", size: st.size };
  });
}

export function find(dataDir, name) {
  for (const p of core.listBackups(dataDir)) {
    if (path.basename(p) === name) return p;
  }
  throw new core.FileNotFoundError(name);
}

export function restore(dataDir, dbPath, name, hooks = {}) {
  const archive = find(dataDir, name);
  core.verifyArchive(archive);
  const safety = create(dataDir, dbPath, { reason: "pre-restore", keep: 0, sql: hooks.sql || null });
  if (safety === null) throw new core.RuntimeError("another backup is running, try again in a moment");
  core.restoreBackup(dataDir, dbPath, archive, hooks);
  return safety;
}

function dbPathOf(d) {
  return path.join(String(d.dataDir), "calendizo.db");
}

function liveSql(d, dbPath) {
  const sql = d.db && d.db.sql;
  if (!sql || !sql.path) return null;
  return core.pathKey(sql.path) === core.pathKey(dbPath) ? sql : null;
}

export function dbHooks(d, dbPath = dbPathOf(d)) {
  const sql = liveSql(d, dbPath);
  const closeDb =
    typeof d.closeDb === "function"
      ? () => d.closeDb()
      : sql
        ? () => (typeof d.db.close === "function" ? d.db.close() : sql.close())
        : null;
  const reopenDb =
    typeof d.reopenDb === "function"
      ? () => d.reopenDb()
      : sql
        ? () => {
            sql.db = new Sqlite(sql.path).db;
            sql.depth = 0;
          }
        : null;
  return { sql, closeDb, reopenDb };
}

export function autoBackups(deps) {
  let reason = "launch";
  let interval = 60;
  let timer = null;
  let stopped = false;
  const tick = () => {
    try {
      const d = deps();
      const dbPath = dbPathOf(d);
      create(d.dataDir, dbPath, { reason, minIntervalMinutes: interval, sql: liveSql(d, dbPath) });
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
    }
    reason = "auto";
    interval = 1440;
    if (stopped) return;
    timer = setTimeout(tick, 3600 * 1000);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(tick, LAUNCH_DELAY_MS);
  if (timer.unref) timer.unref();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

function isNotFound(err) {
  return err instanceof core.FileNotFoundError || (err && err.code === "ENOENT");
}

export function register(deps) {
  route("GET", String.raw`/api/backups`, () => listing(deps().dataDir));

  route("POST", String.raw`/api/backups`, () => {
    const d = deps();
    const dbPath = dbPathOf(d);
    const p = create(d.dataDir, dbPath, { reason: "manual", sql: liveSql(d, dbPath) });
    if (p === null) throw new ApiError(409, "Another backup is running. Try again in a moment.");
    return { name: path.basename(p), size: fs.statSync(p).size };
  });

  route("POST", String.raw`/api/backups/restore`, (ctx) => {
    const d = deps();
    const raw = ctx.b("name");
    const name = truthy(raw) ? String(raw) : "";
    let safety;
    try {
      safety = restore(d.dataDir, dbPathOf(d), name, dbHooks(d));
    } catch (err) {
      if (isNotFound(err)) throw new ApiError(404, "That backup no longer exists.");
      if (err instanceof core.RuntimeError || err instanceof core.BadZipFile) throw new ApiError(400, `This backup can't be restored: ${err.message}`);
      throw err;
    }
    if (typeof d.afterRestore === "function") d.afterRestore();
    return { restored: name, safety: safety ? path.basename(safety) : null };
  });

  route("GET", String.raw`/api/backups/file/(Backup_[\w.-]+\.zip)`, (ctx) => {
    let p;
    try {
      p = find(deps().dataDir, ctx.arg(1));
    } catch (err) {
      if (isNotFound(err)) throw new ApiError(404, "That backup no longer exists.");
      throw err;
    }
    return new Raw(fs.readFileSync(p), "application/zip", { "Content-Disposition": `attachment; filename="${path.basename(p)}"` });
  });

  return { autoBackups: () => autoBackups(deps), create, listing, find, restore };
}
