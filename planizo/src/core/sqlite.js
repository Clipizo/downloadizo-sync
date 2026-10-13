import { createRequire } from "node:module";
import { isoLocal } from "../py.js";

const require = createRequire(import.meta.url);

function loadDriver() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return {
      name: "node:sqlite",
      open: (path) => new DatabaseSync(String(path), { enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: true }),
    };
  } catch {
    const BetterSqlite = require("better-sqlite3");
    return { name: "better-sqlite3", open: (path) => new BetterSqlite(String(path)) };
  }
}

const driver = loadDriver();

function bindValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (value instanceof Date) return isoLocal(value).replace("T", " ");
  if (typeof value === "object" && !(value instanceof Uint8Array) && !Buffer.isBuffer(value)) return JSON.stringify(value);
  return value;
}

function bindParams(params) {
  if (params === undefined || params === null) return [];
  const list = Array.isArray(params) ? params : [params];
  return list.map((value, index) => {
    if (value !== null && typeof value === "object" && !(value instanceof Date) && !(value instanceof Uint8Array) && !Buffer.isBuffer(value)) {
      throw new TypeError(`Error binding parameter ${index + 1} - probably unsupported type.`);
    }
    return bindValue(value);
  });
}

function plain(row) {
  if (!row) return row ?? null;
  const out = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    out[key] = value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value;
  }
  return out;
}

export class Sqlite {
  constructor(path) {
    this.path = String(path);
    this.db = driver.open(this.path);
    this.depth = 0;
    this.db.exec("PRAGMA busy_timeout=30000");
    this.db.exec("PRAGMA recursive_triggers=OFF");
  }

  static get driverName() {
    return driver.name;
  }

  all(sql, params) {
    return this.db.prepare(sql).all(...bindParams(params)).map(plain);
  }

  get(sql, params) {
    return plain(this.db.prepare(sql).get(...bindParams(params)));
  }

  run(sql, params) {
    const info = this.db.prepare(sql).run(...bindParams(params));
    return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
  }

  exec(sql) {
    this.db.exec(sql);
  }

  tx(fn) {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    }
    this.db.exec("BEGIN");
    this.depth = 1;
    try {
      const result = fn();
      if (result && typeof result.then === "function") throw new Error("tx() callbacks must be synchronous");
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}

export function openSqlite(path) {
  return new Sqlite(path);
}
