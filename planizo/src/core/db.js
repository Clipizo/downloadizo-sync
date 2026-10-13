import { Sqlite } from "./sqlite.js";
import { dateKey, endOfDay, formatTimeRange, localToMs, msToLocal, parseDateKey, startOfDay } from "./dates.js";
import { expandEvents, expandTasks, parseWeekdays } from "./recurrence.js";
import { ValueError, casefold, pyRound, replace, shift, sorted, strftime, truthy, uuidHex } from "../py.js";

export const SYNC_TABLE_PRIMARY_KEYS = {
  Event: "id",
  RecurrenceRule: "id",
  ChecklistItem: "id",
  ChecklistCompletion: "id",
  Task: "id",
  TaskCompletion: "id",
  TaskReminderShown: "occurrenceId",
  ContentItem: "id",
  Note: "id",
  EventCompletion: "id",
  Project: "id",
  Stage: "id",
  DayTodo: "id",
};

const USER_COLUMNS = [
  ["syncEnabled", "INTEGER NOT NULL DEFAULT 0"],
  ["supabaseUrl", "TEXT"],
  ["supabaseServiceKey", "TEXT"],
  ["lastSyncAt", "INTEGER"],
  ["lastSyncError", "TEXT"],
  ["cloudBackupDir", "TEXT"],
  ["dailyLogsDir", "TEXT"],
];

const MAX_DATE = new Date(8.64e15);

class OverflowError extends Error {}

export function q(identifier) {
  return "\"" + String(identifier).replace(/"/g, "\"\"") + "\"";
}

const PY_STRIP_RE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

export function pyStrip(text) {
  return String(text).replace(PY_STRIP_RE, "");
}

function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export function pyInt(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new ValueError("cannot convert float NaN to integer");
    if (!Number.isFinite(value)) throw new OverflowError("cannot convert float infinity to integer");
    return Math.trunc(value);
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    const text = String(value);
    if (/^\s*[+-]?\d+(?:_\d+)*\s*$/.test(text)) return Number(text.replace(/_/g, ""));
    throw new ValueError(`invalid literal for int() with base 10: '${text}'`);
  }
  throw new TypeError("int() argument must be a string, a bytes-like object or a real number");
}

function pyFloatRepr(value) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1e-4 && abs < 1e16) return String(value);
  const [mantissa, exponent] = value.toExponential().split("e");
  const sign = exponent[0] === "-" ? "-" : "+";
  const digits = exponent.replace(/^[+-]/, "").padStart(2, "0");
  return `${mantissa}e${sign}${digits}`;
}

function pyJsonString(text) {
  let out = "\"";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === "\"") out += "\\\"";
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (code < 0x10000) out += "\\u" + code.toString(16).padStart(4, "0");
    else {
      const v = code - 0x10000;
      out += "\\u" + (0xd800 | (v >> 10)).toString(16) + "\\u" + (0xdc00 | (v & 0x3ff)).toString(16);
    }
  }
  return out + "\"";
}

export function pyJsonDumps(value) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return pyFloatRepr(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return pyJsonString(value);
  if (Array.isArray(value)) return value.length ? "[" + value.map(pyJsonDumps).join(", ") + "]" : "[]";
  if (value instanceof Map) {
    const parts = [...value.entries()].map(([k, v]) => `${pyJsonString(k)}: ${pyJsonDumps(v)}`);
    return parts.length ? "{" + parts.join(", ") + "}" : "{}";
  }
  if (typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const parts = Object.entries(value).map(([k, v]) => `${pyJsonString(k)}: ${pyJsonDumps(v)}`);
    return parts.length ? "{" + parts.join(", ") + "}" : "{}";
  }
  throw new TypeError(`Object of type ${value?.constructor?.name ?? typeof value} is not JSON serializable`);
}

function pyJsonLoads(text) {
  if (typeof text !== "string" && !Buffer.isBuffer(text)) throw new TypeError("the JSON object must be str, bytes or bytearray");
  return JSON.parse(String(text));
}

function isSqliteError(err) {
  return Boolean(err) && typeof err.code === "string" && err.code.includes("SQLITE");
}

function bindValue(value) {
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return value;
}

function bind(params) {
  if (params === undefined || params === null) return [];
  return Array.from(params, bindValue);
}

function has(obj, key) {
  return obj !== null && obj !== undefined && typeof obj === "object" && Object.hasOwn(obj, key);
}

function get(obj, key, fallback = null) {
  return has(obj, key) ? obj[key] : fallback;
}

function placeholders(items) {
  return items.map(() => "?").join(",");
}

function withoutSyncColumns(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key !== "deleted" && key !== "syncDirty") out[key] = value;
  }
  return out;
}

export const NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

const CORE_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS "User" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "email" TEXT NOT NULL,
            "passwordHash" TEXT NOT NULL DEFAULT '',
            "wakeUpTime" TEXT NOT NULL DEFAULT '08:00',
            "sleepTime" TEXT NOT NULL DEFAULT '00:00',
            "timeFormat" TEXT NOT NULL DEFAULT 'h12',
            "defaultCalendarView" TEXT NOT NULL DEFAULT 'day',
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
  `CREATE TABLE IF NOT EXISTS "Event" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "title" TEXT NOT NULL,
            "notes" TEXT,
            "startAt" DATETIME NOT NULL,
            "endAt" DATETIME NOT NULL,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
  `CREATE TABLE IF NOT EXISTS "RecurrenceRule" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "eventId" TEXT,
            "taskId" TEXT,
            "frequency" TEXT NOT NULL,
            "interval" INTEGER NOT NULL DEFAULT 1,
            "weekdays" TEXT NOT NULL DEFAULT '[]',
            "startDate" DATETIME,
            "endDate" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
  `CREATE TABLE IF NOT EXISTS "ChecklistItem" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "eventId" TEXT NOT NULL,
            "title" TEXT NOT NULL,
            "order" INTEGER NOT NULL DEFAULT 0,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
  `CREATE TABLE IF NOT EXISTS "ChecklistCompletion" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "checklistItemId" TEXT NOT NULL,
            "userId" TEXT NOT NULL,
            "date" DATETIME NOT NULL,
            "completed" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
  `CREATE TABLE IF NOT EXISTS "Task" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "title" TEXT NOT NULL,
            "notes" TEXT,
            "dueDate" DATETIME,
            "time" TEXT,
            "status" TEXT NOT NULL DEFAULT 'todo',
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
  `CREATE TABLE IF NOT EXISTS "TaskCompletion" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "taskId" TEXT NOT NULL,
            "userId" TEXT NOT NULL,
            "date" DATETIME NOT NULL,
            "completed" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
];

const CORE_INDEX_DDL = [
  "CREATE UNIQUE INDEX IF NOT EXISTS \"ChecklistCompletion_checklistItemId_userId_date_key\" ON \"ChecklistCompletion\"(\"checklistItemId\",\"userId\",\"date\")",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"TaskCompletion_taskId_userId_date_key\" ON \"TaskCompletion\"(\"taskId\",\"userId\",\"date\")",
];

const DDL_TASK_REMINDER = `CREATE TABLE IF NOT EXISTS TaskReminderShown (
                    occurrenceId TEXT PRIMARY KEY,
                    taskId TEXT NOT NULL,
                    userId TEXT NOT NULL,
                    shownAt INTEGER NOT NULL
                )`;

const DDL_EVENT_COMPLETION = `CREATE TABLE IF NOT EXISTS EventCompletion (
                    id TEXT PRIMARY KEY,
                    eventId TEXT NOT NULL,
                    userId TEXT NOT NULL,
                    date INTEGER NOT NULL,
                    completed INTEGER NOT NULL DEFAULT 1,
                    createdAt INTEGER NOT NULL,
                    updatedAt INTEGER NOT NULL
                )`;

const DDL_EVENT_COMPLETION_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS idx_event_completion ON EventCompletion(eventId, userId, date)";

const DDL_CONTENT_ITEM = `CREATE TABLE IF NOT EXISTS ContentItem (
                    id TEXT PRIMARY KEY NOT NULL,
                    userId TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    status TEXT NOT NULL,
                    scheduledDate TEXT,
                    notes TEXT,
                        createdAt INTEGER NOT NULL,
                        updatedAt INTEGER NOT NULL
                    )`;

const DDL_PROJECT = `CREATE TABLE IF NOT EXISTS Project (
                    id TEXT PRIMARY KEY NOT NULL,
                    userId TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT,
                    thumbnail TEXT,
                    status TEXT NOT NULL DEFAULT 'idea',
                    "order" INTEGER NOT NULL DEFAULT 0,
                    createdAt INTEGER NOT NULL,
                    updatedAt INTEGER NOT NULL
                )`;

const DDL_STAGE = `CREATE TABLE IF NOT EXISTS Stage (
                    id TEXT PRIMARY KEY NOT NULL,
                    projectId TEXT NOT NULL,
                    name TEXT NOT NULL,
                    "order" INTEGER NOT NULL DEFAULT 0,
                    createdAt INTEGER NOT NULL,
                    updatedAt INTEGER NOT NULL
                )`;

const DDL_DAY_TODO = `CREATE TABLE IF NOT EXISTS DayTodo (
                    id TEXT PRIMARY KEY NOT NULL,
                    userId TEXT NOT NULL,
                    date TEXT NOT NULL,
                    text TEXT NOT NULL,
                    completed INTEGER NOT NULL DEFAULT 0,
                    "order" INTEGER NOT NULL DEFAULT 0,
                    createdAt INTEGER NOT NULL,
                    updatedAt INTEGER NOT NULL
                )`;

const DDL_NOTE = `CREATE TABLE IF NOT EXISTS Note (
                    id TEXT PRIMARY KEY NOT NULL,
                    userId TEXT NOT NULL,
                    text TEXT NOT NULL,
                    date TEXT NOT NULL,
                    createdAt INTEGER NOT NULL,
                    title TEXT
                )`;

const DDL_STEP_PRESET = `CREATE TABLE IF NOT EXISTS StepPreset (
                    id TEXT PRIMARY KEY NOT NULL,
                    userId TEXT NOT NULL,
                    name TEXT NOT NULL,
                    steps TEXT NOT NULL,
                    createdAt INTEGER NOT NULL
                )`;

const DDL_ROUTINE_PRESET = `CREATE TABLE IF NOT EXISTS RoutinePreset (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL,
                    title TEXT NOT NULL,
                    startTime TEXT NOT NULL,
                    endTime TEXT NOT NULL,
                    notes TEXT,
                    checklist TEXT NOT NULL,
                    createdAt INTEGER NOT NULL
                )`;

const DDL_SYNC_CONTROL = "CREATE TABLE IF NOT EXISTS _SyncControl (id INTEGER PRIMARY KEY CHECK(id=1), suppress INTEGER NOT NULL DEFAULT 0)";

const DDL_WHITEBOARD_LINK = `CREATE TABLE IF NOT EXISTS WhiteboardLink (
                    id TEXT PRIMARY KEY,
                    targetType TEXT NOT NULL,
                    targetId TEXT NOT NULL,
                    label TEXT NOT NULL,
                    path TEXT NOT NULL,
                    createdAt INTEGER NOT NULL,
                    updatedAt INTEGER NOT NULL
                )`;

const DDL_WHITEBOARD_LINK_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS idx_whiteboard_link_target ON WhiteboardLink(targetType, targetId)";

function insertTriggerSql(name, table, pk) {
  return `CREATE TRIGGER ${q(name)}
                    AFTER INSERT ON ${q(table)}
                    WHEN COALESCE((SELECT suppress FROM _SyncControl WHERE id=1), 0)=0
                    BEGIN
                        UPDATE ${q(table)}
                        SET updatedAt=CASE
                            WHEN CAST(COALESCE(NEW.updatedAt, 0) AS INTEGER) >= ${NOW_MS_SQL}
                            THEN CAST(NEW.updatedAt AS INTEGER)
                            ELSE ${NOW_MS_SQL}
                        END,
                        syncDirty=1
                        WHERE ${q(pk)}=NEW.${q(pk)};
                    END`;
}

function updateTriggerSql(name, table, pk) {
  return `CREATE TRIGGER ${q(name)}
                    AFTER UPDATE ON ${q(table)}
                    WHEN COALESCE((SELECT suppress FROM _SyncControl WHERE id=1), 0)=0
                         AND NEW.syncDirty=OLD.syncDirty
                    BEGIN
                        UPDATE ${q(table)}
                        SET updatedAt=CASE
                            WHEN CAST(COALESCE(NEW.updatedAt, 0) AS INTEGER) > CAST(COALESCE(OLD.updatedAt, 0) AS INTEGER)
                            THEN CAST(NEW.updatedAt AS INTEGER)
                            ELSE MAX(${NOW_MS_SQL}, CAST(COALESCE(OLD.updatedAt, 0) AS INTEGER) + 1)
                        END,
                        syncDirty=1
                        WHERE ${q(pk)}=NEW.${q(pk)};
                    END`;
}

export class CalendizoDB {
  constructor(dbPath) {
    this.dbPath = String(dbPath);
    this.sql = new Sqlite(this.dbPath);
    this._ensureCoreTables();
    this._ensureSyncSchema();
    this._migrateProjectStages();
    this._dedupeChecklistItems();
  }

  static q(identifier) {
    return q(identifier);
  }

  q(identifier) {
    return q(identifier);
  }

  close() {
    this.sql.close();
  }

  _all(sqlText, params) {
    return this.sql.all(sqlText, bind(params));
  }

  _get(sqlText, params) {
    return this.sql.get(sqlText, bind(params));
  }

  _run(sqlText, params) {
    return this.sql.run(sqlText, bind(params));
  }

  _columnNames(table) {
    return this._all(`PRAGMA table_info(${table})`).map((row) => row.name);
  }

  _ensureCoreTables() {
    this.sql.tx(() => {
      for (const ddl of CORE_TABLE_DDL) this._run(ddl);
      for (const ddl of CORE_INDEX_DDL) {
        try {
          this._run(ddl);
        } catch (err) {
          if (!isSqliteError(err)) throw err;
        }
      }
      if (this._get("SELECT 1 FROM User LIMIT 1") === null) {
        this._run(
          "INSERT INTO User (id,email,passwordHash,createdAt,updatedAt) VALUES (?,?,?,?,?)",
          [uuidHex(), "local@calendizo.app", "", this._nowMs(), this._nowMs()],
        );
      }
    });
  }

  _ensureSyncSchema() {
    this._ensureTaskReminderTable();
    this._ensureEventCompletionTable();
    this.sql.tx(() => {
      this._run(DDL_CONTENT_ITEM);
      this._run(DDL_PROJECT);
      const contentColumns = new Set(this._columnNames("ContentItem"));
      if (!contentColumns.has("projectId")) this._run("ALTER TABLE ContentItem ADD COLUMN projectId TEXT");
      if (!contentColumns.has("stageId")) this._run("ALTER TABLE ContentItem ADD COLUMN stageId TEXT");
      if (!contentColumns.has("parentStepId")) this._run("ALTER TABLE ContentItem ADD COLUMN parentStepId TEXT");
      this._run(DDL_STAGE);
      this._run(DDL_DAY_TODO);
      this._run(DDL_NOTE);
      this._run(DDL_STEP_PRESET);
      this._run(DDL_ROUTINE_PRESET);
      this._run(DDL_SYNC_CONTROL);
      this._run("INSERT OR IGNORE INTO _SyncControl(id, suppress) VALUES (1, 0)");

      const eventColumns = new Set(this._columnNames("Event"));
      if (!eventColumns.has("color")) this._run("ALTER TABLE Event ADD COLUMN color TEXT");

      const userColumns = new Set(this._columnNames("User"));
      for (const [column, declaration] of USER_COLUMNS) {
        if (!userColumns.has(column)) this._run(`ALTER TABLE User ADD COLUMN ${q(column)} ${declaration}`);
      }

      for (const [table, pkColumn] of Object.entries(SYNC_TABLE_PRIMARY_KEYS)) {
        const columns = new Set(this._columnNames(q(table)));
        if (!columns.size) continue;
        if (!columns.has("updatedAt")) this._run(`ALTER TABLE ${q(table)} ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0`);
        if (!columns.has("deleted")) this._run(`ALTER TABLE ${q(table)} ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
        const addedDirty = !columns.has("syncDirty");
        if (addedDirty) {
          this._run(`ALTER TABLE ${q(table)} ADD COLUMN syncDirty INTEGER NOT NULL DEFAULT 0`);
          this._run(
            `UPDATE ${q(table)} SET updatedAt=CASE WHEN CAST(updatedAt AS INTEGER) > 100000000000 THEN CAST(updatedAt AS INTEGER) ELSE ? END, deleted=0, syncDirty=1`,
            [this._nowMs()],
          );
        }

        const insertTrigger = `sync_${table}_insert`;
        const updateTrigger = `sync_${table}_update`;
        this._run(`DROP TRIGGER IF EXISTS ${q(insertTrigger)}`);
        this._run(`DROP TRIGGER IF EXISTS ${q(updateTrigger)}`);
        this._run(insertTriggerSql(insertTrigger, table, pkColumn));
        this._run(updateTriggerSql(updateTrigger, table, pkColumn));
      }
    });
  }

  _dedupeChecklistItems() {
    this.sql.tx(() => {
      const rows = this._all("SELECT id,eventId,title,\"order\",createdAt FROM ChecklistItem WHERE deleted=0");
      const groups = new Map();
      for (const row of rows) {
        const key = JSON.stringify([row.eventId, casefold(pyStrip(truthy(row.title) ? row.title : "")), row.order]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }

      const counts = new Map();
      for (const row of this._all("SELECT checklistItemId,COUNT(*) AS count FROM ChecklistCompletion WHERE deleted=0 GROUP BY checklistItemId")) {
        counts.set(row.checklistItemId, row.count);
      }
      const now = this._nowMs();
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const duplicates = sorted(group, (row) => [-(counts.has(row.id) ? counts.get(row.id) : 0), row.createdAt, row.id]);
        const keeperId = duplicates[0].id;
        for (const duplicate of duplicates.slice(1)) {
          const duplicateId = duplicate.id;
          const completions = this._all("SELECT * FROM ChecklistCompletion WHERE checklistItemId=? AND deleted=0", [duplicateId]);
          for (const completion of completions) {
            const existing = this._get(
              "SELECT * FROM ChecklistCompletion WHERE checklistItemId=? AND userId=? AND date=? AND deleted=0",
              [keeperId, completion.userId, completion.date],
            );
            if (existing) {
              const duplicateUpdated = pyInt(truthy(completion.updatedAt) ? completion.updatedAt : 0);
              const existingUpdated = pyInt(truthy(existing.updatedAt) ? existing.updatedAt : 0);
              let completed = duplicateUpdated > existingUpdated ? completion.completed : existing.completed;
              if (duplicateUpdated === existingUpdated) completed = truthy(truthy(completion.completed) ? completion.completed : existing.completed);
              this._run("UPDATE ChecklistCompletion SET completed=?,updatedAt=? WHERE id=?", [completed, now, existing.id]);
              this._run("UPDATE ChecklistCompletion SET deleted=1,updatedAt=? WHERE id=?", [now, completion.id]);
            } else {
              this._run("UPDATE ChecklistCompletion SET checklistItemId=?,updatedAt=? WHERE id=?", [keeperId, now, completion.id]);
            }
          }
          this._run("UPDATE ChecklistItem SET deleted=1,updatedAt=? WHERE id=?", [now, duplicateId]);
        }
      }
    });
  }

  getUser() {
    return this._get("SELECT * FROM User ORDER BY createdAt ASC LIMIT 1");
  }

  _msDt(value) {
    if (value === null || value === undefined) return null;
    let ms;
    try {
      ms = pyInt(value);
    } catch (err) {
      if (err instanceof ValueError || err instanceof TypeError) return null;
      throw err;
    }
    const result = msToLocal(ms);
    if (Number.isNaN(result.getTime())) return null;
    const year = result.getFullYear();
    if (year < 1 || year > 9999) return null;
    return result;
  }

  getEventsWithChecklists() {
    const events = this._all("SELECT * FROM Event WHERE deleted=0");
    if (!events.length) return [];
    const eventIds = events.map((e) => e.id);
    const rules = new Map();
    for (const r of this._all("SELECT * FROM RecurrenceRule WHERE deleted=0")) {
      if (truthy(r.eventId)) rules.set(r.eventId, r);
    }
    const itemsByEvent = new Map(eventIds.map((eid) => [eid, []]));
    for (const row of this._all("SELECT * FROM ChecklistItem WHERE deleted=0")) {
      if (!itemsByEvent.has(row.eventId)) itemsByEvent.set(row.eventId, []);
      itemsByEvent.get(row.eventId).push(row);
    }
    const itemIds = this._all("SELECT * FROM ChecklistItem WHERE deleted=0").map((row) => row.id);
    const completions = new Map();
    if (itemIds.length) {
      for (const row of this._all(`SELECT * FROM ChecklistCompletion WHERE deleted=0 AND checklistItemId IN (${placeholders(itemIds)})`, itemIds)) {
        if (!completions.has(row.checklistItemId)) completions.set(row.checklistItemId, []);
        completions.get(row.checklistItemId).push({ date: this._msDt(row.date), completed: truthy(row.completed) });
      }
    }

    const result = [];
    for (const event of events) {
      const rawRule = rules.has(event.id) ? rules.get(event.id) : null;
      let rule = null;
      if (rawRule) {
        rule = {
          id: rawRule.id,
          frequency: rawRule.frequency,
          interval: rawRule.interval,
          weekdays: rawRule.weekdays,
          startDate: this._msDt(rawRule.startDate),
          endDate: this._msDt(rawRule.endDate),
        };
      }
      const checklistItems = [];
      for (const item of itemsByEvent.has(event.id) ? itemsByEvent.get(event.id) : []) {
        checklistItems.push({
          id: item.id,
          title: item.title,
          order: get(item, "order", 0),
          completions: completions.has(item.id) ? completions.get(item.id) : [],
        });
      }
      result.push({
        id: event.id,
        title: event.title,
        notes: get(event, "notes"),
        color: get(event, "color"),
        startAt: this._msDt(event.startAt),
        endAt: this._msDt(event.endAt),
        recurrenceRule: rule,
        checklistItems,
      });
    }
    return result;
  }

  _eventsWithCompletions() {
    const events = this.getEventsWithChecklists();
    const ec = this.getEventCompletions();
    for (const event of events) {
      event.eventCompletions = Object.hasOwn(ec, event.id) ? ec[event.id] : [];
    }
    return events;
  }

  occurrencesForDay(day) {
    return expandEvents(this._eventsWithCompletions(), startOfDay(day), endOfDay(day));
  }

  getNotes(key) {
    this._ensureNoteTitleColumn();
    try {
      return this._all("SELECT * FROM Note WHERE date = ? AND deleted=0 ORDER BY createdAt ASC", [key]);
    } catch (err) {
      if (isSqliteError(err)) return [];
      throw err;
    }
  }

  getAllNotes() {
    this._ensureNoteTitleColumn();
    try {
      return this._all("SELECT * FROM Note WHERE deleted=0 ORDER BY createdAt ASC");
    } catch (err) {
      if (isSqliteError(err)) return [];
      throw err;
    }
  }

  getContentItems(projectId = "__ALL__") {
    try {
      if (projectId === "__ALL__") return this._all("SELECT * FROM ContentItem WHERE deleted=0 ORDER BY createdAt ASC");
      if (projectId === null || projectId === undefined) return this._all("SELECT * FROM ContentItem WHERE deleted=0 AND projectId IS NULL ORDER BY createdAt ASC");
      return this._all("SELECT * FROM ContentItem WHERE deleted=0 AND projectId=? ORDER BY createdAt ASC", [projectId]);
    } catch (err) {
      if (isSqliteError(err)) return [];
      throw err;
    }
  }

  setChecklistCompletion(itemId, userId, key, completed) {
    const dateMs = localToMs(parseDateKey(key));
    const nowMs = this._nowMs();
    const newId = uuidHex();
    this._run(
      `INSERT INTO ChecklistCompletion
                   (id, checklistItemId, userId, date, completed, createdAt, updatedAt)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(checklistItemId, userId, date) DO UPDATE SET
                   completed=excluded.completed, updatedAt=excluded.updatedAt`,
      [newId, itemId, userId, dateMs, truthy(completed) ? 1 : 0, nowMs, nowMs],
    );
  }

  setTaskCompletion(taskId, userId, key, completed) {
    const dateMs = localToMs(parseDateKey(key));
    const nowMs = this._nowMs();
    const newId = uuidHex();
    this._run(
      `INSERT INTO TaskCompletion
                   (id, taskId, userId, date, completed, createdAt, updatedAt)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(taskId, userId, date) DO UPDATE SET
                   completed=excluded.completed, updatedAt=excluded.updatedAt`,
      [newId, taskId, userId, dateMs, truthy(completed) ? 1 : 0, nowMs, nowMs],
    );
  }

  _ensureTaskReminderTable() {
    this._run(DDL_TASK_REMINDER);
  }

  shownTaskReminderIds(occurrenceIds) {
    if (!truthy(occurrenceIds)) return new Set();
    const ids = Array.from(occurrenceIds);
    this._ensureTaskReminderTable();
    const rows = this._all(`SELECT occurrenceId FROM TaskReminderShown WHERE deleted=0 AND occurrenceId IN (${placeholders(ids)})`, ids);
    return new Set(rows.map((row) => pyStr(row.occurrenceId)));
  }

  markTaskReminderShown(occurrenceId, taskId, userId) {
    const nowMs = this._nowMs();
    this._ensureTaskReminderTable();
    this._run(
      `INSERT OR IGNORE INTO TaskReminderShown (occurrenceId, taskId, userId, shownAt)
                   VALUES (?, ?, ?, ?)`,
      [occurrenceId, taskId, userId, nowMs],
    );
  }

  _ensureWhiteboardLinkTable() {
    this.sql.tx(() => {
      this._run(DDL_WHITEBOARD_LINK);
      this._run(DDL_WHITEBOARD_LINK_INDEX);
    });
  }

  getWhiteboardLink(targetType, targetId) {
    this._ensureWhiteboardLinkTable();
    return this._get("SELECT * FROM WhiteboardLink WHERE targetType=? AND targetId=?", [targetType, targetId]);
  }

  upsertWhiteboardLink(targetType, targetId, label, path) {
    this._ensureWhiteboardLinkTable();
    const now = this._nowMs();
    const linkId = uuidHex();
    this._run(
      `INSERT INTO WhiteboardLink (id,targetType,targetId,label,path,createdAt,updatedAt)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(targetType,targetId) DO UPDATE SET
                   label=excluded.label,path=excluded.path,updatedAt=excluded.updatedAt`,
      [linkId, targetType, targetId, label, path, now, now],
    );
    return this.getWhiteboardLink(targetType, targetId) || {
      id: linkId,
      targetType,
      targetId,
      label,
      path,
      createdAt: now,
      updatedAt: now,
    };
  }

  _ensureEventCompletionTable() {
    this.sql.tx(() => {
      this._run(DDL_EVENT_COMPLETION);
      this._run(DDL_EVENT_COMPLETION_INDEX);
    });
  }

  getEventCompletions() {
    this._ensureEventCompletionTable();
    const result = {};
    for (const row of this._all("SELECT * FROM EventCompletion WHERE deleted=0")) {
      if (!Object.hasOwn(result, row.eventId)) result[row.eventId] = [];
      result[row.eventId].push({ date: this._msDt(row.date), completed: truthy(row.completed) });
    }
    return result;
  }

  setEventCompletion(eventId, userId, key, completed) {
    this._ensureEventCompletionTable();
    const dateMs = localToMs(parseDateKey(key));
    const nowMs = this._nowMs();
    const newId = uuidHex();
    this._run(
      `INSERT INTO EventCompletion
                   (id, eventId, userId, date, completed, createdAt, updatedAt)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(eventId, userId, date) DO UPDATE SET
                   completed=excluded.completed, updatedAt=excluded.updatedAt`,
      [newId, eventId, userId, dateMs, truthy(completed) ? 1 : 0, nowMs, nowMs],
    );
  }

  _ensureNoteTitleColumn() {
    const cols = this._columnNames("Note");
    if (!cols.includes("title")) this._run("ALTER TABLE Note ADD COLUMN title TEXT");
  }

  addNote(userId, key, text, title = "") {
    this._ensureNoteTitleColumn();
    const nowMs = this._nowMs();
    const noteId = uuidHex();
    this._run(
      "INSERT INTO Note (id, userId, text, date, title, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      [noteId, userId, text, key, title, nowMs],
    );
    return { id: noteId, text, title, date: key, createdAt: nowMs };
  }

  removeNote(noteId) {
    this._run("UPDATE Note SET deleted=1 WHERE id = ?", [noteId]);
  }

  restoreNote(noteId) {
    this._run("UPDATE Note SET deleted=0 WHERE id = ?", [noteId]);
  }

  occurrencesForRange(fromDt, toDt) {
    return expandEvents(this._eventsWithCompletions(), fromDt, toDt);
  }

  getTasksWithCompletions() {
    const tasks = this._all("SELECT * FROM Task WHERE deleted=0");
    if (!tasks.length) return [];
    const rules = new Map();
    for (const r of this._all("SELECT * FROM RecurrenceRule WHERE deleted=0")) {
      if (truthy(r.taskId)) rules.set(r.taskId, r);
    }
    const completions = new Map();
    for (const row of this._all("SELECT * FROM TaskCompletion WHERE deleted=0")) {
      if (!completions.has(row.taskId)) completions.set(row.taskId, []);
      completions.get(row.taskId).push({ date: this._msDt(row.date), completed: truthy(row.completed) });
    }
    const result = [];
    for (const task of tasks) {
      const rawRule = rules.has(task.id) ? rules.get(task.id) : null;
      let rule = null;
      if (rawRule) {
        rule = {
          frequency: rawRule.frequency,
          interval: rawRule.interval,
          weekdays: rawRule.weekdays,
          startDate: this._msDt(rawRule.startDate),
          endDate: this._msDt(rawRule.endDate),
        };
      }
      result.push({
        id: task.id,
        title: task.title,
        notes: get(task, "notes"),
        dueDate: this._msDt(get(task, "dueDate")),
        time: get(task, "time"),
        status: get(task, "status", "todo"),
        createdAt: this._msDt(get(task, "createdAt")) || new Date(),
        recurrenceRule: rule,
        completions: completions.has(task.id) ? completions.get(task.id) : [],
      });
    }
    return result;
  }

  taskOccurrencesForRange(fromDt, toDt) {
    return expandTasks(this.getTasksWithCompletions(), fromDt, toDt);
  }

  _nowMs() {
    return Math.trunc(Date.now());
  }

  createEvent(userId, title, notes, startDt, endDt) {
    const eid = uuidHex();
    const now = this._nowMs();
    this._run(
      `INSERT INTO Event (id, userId, title, notes, startAt, endAt, createdAt, updatedAt)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [eid, userId, title, notes, localToMs(startDt), localToMs(endDt), now, now],
    );
    return eid;
  }

  updateEvent(eventId, title, notes, startDt, endDt) {
    const now = this._nowMs();
    this._run(
      "UPDATE Event SET title=?, notes=?, startAt=?, endAt=?, updatedAt=? WHERE id=?",
      [title, notes, localToMs(startDt), localToMs(endDt), now, eventId],
    );
  }

  setEventColor(eventId, color) {
    this._run("UPDATE Event SET color=?, updatedAt=? WHERE id=?", [color, this._nowMs(), eventId]);
  }

  deleteEvent(eventId) {
    this._run("UPDATE Event SET deleted=1 WHERE id = ?", [eventId]);
  }

  restoreEvent(eventId) {
    this._run("UPDATE Event SET deleted=0 WHERE id = ?", [eventId]);
  }

  moveEvent(eventId, startDt, endDt) {
    const now = this._nowMs();
    this._run(
      "UPDATE Event SET startAt=?, endAt=?, updatedAt=? WHERE id=?",
      [localToMs(startDt), localToMs(endDt), now, eventId],
    );
  }

  moveTask(taskId, day, timeStr) {
    let due;
    if (truthy(timeStr)) {
      const parts = String(timeStr).split(":");
      if (parts.length !== 2) throw new ValueError(`${parts.length < 2 ? "not enough" : "too many"} values to unpack (expected 2)`);
      const [hh, mm] = parts.map(pyInt);
      if (hh < 0 || hh > 23) throw new ValueError("hour must be in 0..23");
      if (mm < 0 || mm > 59) throw new ValueError("minute must be in 0..59");
      due = replace(day, { hour: hh, minute: mm, second: 0, ms: 0 });
    } else {
      due = replace(day, { hour: 0, minute: 0, second: 0, ms: 0 });
    }
    this._run("UPDATE Task SET dueDate=? WHERE id=?", [localToMs(due), taskId]);
  }

  moveContent(contentId, dateKeyStr) {
    this._run("UPDATE ContentItem SET scheduledDate=? WHERE id=?", [dateKeyStr, contentId]);
  }

  createTask(userId, title, dueDt, timeStr) {
    const tid = uuidHex();
    const now = this._nowMs();
    this._run(
      `INSERT INTO Task (id, userId, title, notes, dueDate, time, status, createdAt, updatedAt)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tid, userId, title, null, localToMs(dueDt), timeStr, "todo", now, now],
    );
    return tid;
  }

  deleteTask(taskId) {
    this._run("UPDATE Task SET deleted=1 WHERE id=?", [taskId]);
  }

  restoreTask(taskId) {
    this._run("UPDATE Task SET deleted=0 WHERE id=?", [taskId]);
  }

  dailyLog(key, timeFormat = "h12") {
    const day = parseDateKey(key);
    let occurrences = this.occurrencesForRange(startOfDay(day), endOfDay(day));
    const overrideDates = new Set(occurrences.filter((o) => truthy(get(o, "isRecurring")) && truthy(get(o, "isDayOverride"))).map((o) => get(o, "dateKey")));
    if (overrideDates.size) {
      occurrences = occurrences.filter(
        (o) => !truthy(get(o, "isRecurring")) || truthy(get(o, "isDayOverride")) || !overrideDates.has(get(o, "dateKey")),
      );
    }
    const content = this.getContentItems().filter((c) => get(c, "scheduledDate") === key);
    const notes = this.getNotes(key);

    let total = 0;
    let completed = 0;
    const unchecked = [];
    for (const occ of occurrences) {
      for (const item of get(occ, "checklistItems", [])) {
        total += 1;
        if (truthy(get(item, "completed"))) completed += 1;
        else unchecked.push(`${pyStr(occ.title)}: ${pyStr(item.title)}`);
      }
    }
    const rate = total ? pyRound((completed / total) * 100) : 0;

    const kindLabels = { upload: "Upload", tool: "Tool", research: "Research" };
    const statusLabels = { idea: "Idea", working: "Working", scheduled: "Scheduled", done: "Done" };
    const label = (labels, value) => (typeof value === "string" && Object.hasOwn(labels, value) ? labels[value] : value);

    const lines = [];
    lines.push(`# Planizo Daily Log — ${key} (${strftime(day, "%A")})`);
    lines.push("");
    lines.push("## Completion Summary");
    lines.push(total ? `- Checklist: ${completed} of ${total} completed (${rate}%)` : "- Checklist: no checklist items");
    const eventsDone = occurrences.filter((o) => truthy(get(o, "eventCompleted"))).length;
    lines.push(`- Events done: ${eventsDone} of ${occurrences.length}`);
    lines.push(`- Blocks scheduled: ${occurrences.length}`);
    lines.push(`- Content items: ${content.length}`);
    const contentDone = content.filter((c) => get(c, "status") === "done").length;
    lines.push(content.length ? `- Content done: ${contentDone} of ${content.length}` : "- Content done: 0");
    lines.push(`- Notes: ${notes.length}`);
    lines.push("");
    lines.push("## Schedule");
    if (!occurrences.length) {
      lines.push("_No tasks scheduled._");
    } else {
      for (const occ of occurrences) {
        const t = formatTimeRange(occ.startAt, occ.endAt, timeFormat);
        const tag = truthy(get(occ, "isRecurring")) ? "" : " (event)";
        const doneTag = truthy(get(occ, "eventCompleted")) ? " [DONE]" : "";
        lines.push("");
        lines.push(`### ${pyStr(occ.title)}${tag}${doneTag} (${t})`);
        if (truthy(get(occ, "notes"))) lines.push(`> ${pyStr(occ.notes)}`);
        const items = get(occ, "checklistItems", []);
        if (truthy(items)) {
          for (const it of items) lines.push(`- [${truthy(get(it, "completed")) ? "x" : " "}] ${pyStr(it.title)}`);
        } else {
          lines.push("_No checklist._");
        }
      }
    }
    lines.push("");
    lines.push("## Content");
    if (!content.length) {
      lines.push("_No content items._");
    } else {
      for (const c of content) {
        const kind = label(kindLabels, get(c, "kind", ""));
        const status = label(statusLabels, get(c, "status", ""));
        lines.push(`- ${pyStr(c.title)} — ${pyStr(kind)} / ${pyStr(status)}`);
      }
    }
    lines.push("");
    lines.push("## Notes");
    if (!notes.length) {
      lines.push("_No notes._");
    } else {
      for (const n of notes) lines.push(`- ${pyStr(n.text)}`);
    }
    lines.push("");
    if (unchecked.length) {
      lines.push("## Unchecked Items");
      for (const u of unchecked) lines.push(`- ${u}`);
      lines.push("");
    }

    const stats = {
      date: key,
      totalChecklist: total,
      completedChecklist: completed,
      uncheckedChecklist: total - completed,
      completionRate: rate,
      blockCount: occurrences.length,
      contentCount: content.length,
      noteCount: notes.length,
    };
    return { markdown: lines.join("\n"), stats };
  }

  getRoutineTemplates() {
    const templates = [];
    for (const event of this.getEventsWithChecklists()) {
      const rule = get(event, "recurrenceRule");
      if (!truthy(rule)) continue;
      templates.push({
        id: event.id,
        title: event.title,
        notes: get(event, "notes"),
        color: get(event, "color"),
        startAt: event.startAt,
        endAt: event.endAt,
        recurrenceRule: {
          id: get(rule, "id"),
          frequency: rule.frequency,
          interval: get(rule, "interval", 1),
          weekdays: parseWeekdays(get(rule, "weekdays")),
          startDate: get(rule, "startDate"),
          endDate: get(rule, "endDate"),
        },
        checklistItems: sorted(get(event, "checklistItems", []), (i) => get(i, "order", 0)).map((it) => ({
          id: it.id,
          title: it.title,
          order: get(it, "order", 0),
        })),
      });
    }
    return templates;
  }

  saveRoutine(userId, eventId, title, notes, startDt, endDt, rule, checklist, color = null) {
    const now = this._nowMs();
    const weekdaysValue = get(rule, "weekdays");
    const weekdays = truthy(weekdaysValue) ? weekdaysValue : [];
    const weekdayList = Array.isArray(weekdays) || weekdays instanceof Set ? Array.from(weekdays) : [];
    const wdJson = pyJsonDumps(weekdayList.filter((d) => (typeof d === "boolean" || Number.isInteger(d)) && 0 <= d && d <= 6));
    const sd = truthy(get(rule, "startDate")) ? localToMs(rule.startDate) : null;
    const ed = truthy(get(rule, "endDate")) ? localToMs(rule.endDate) : null;
    const interval = get(rule, "interval", 1);
    const frequencyValue = get(rule, "frequency", "daily");
    const frequency = truthy(frequencyValue) ? frequencyValue : "daily";

    return this.sql.tx(() => {
      if (truthy(eventId)) {
        this._run(
          "UPDATE Event SET title=?, notes=?, startAt=?, endAt=?, color=COALESCE(?,color), updatedAt=? WHERE id=?",
          [title, notes, localToMs(startDt), localToMs(endDt), color, now, eventId],
        );
        const existing = this._get("SELECT id FROM RecurrenceRule WHERE eventId=? AND deleted=0", [eventId]);
        if (existing) {
          this._run(
            "UPDATE RecurrenceRule SET frequency=?, interval=?, weekdays=?, startDate=?, endDate=?, updatedAt=? WHERE eventId=?",
            [frequency, interval, wdJson, sd, ed, now, eventId],
          );
        } else {
          this._run(
            "INSERT INTO RecurrenceRule (id,eventId,frequency,interval,weekdays,startDate,endDate,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
            [uuidHex(), eventId, frequency, interval, wdJson, sd, ed, now, now],
          );
        }
      } else {
        eventId = uuidHex();
        this._run(
          "INSERT INTO Event (id,userId,title,notes,startAt,endAt,color,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
          [eventId, userId, title, notes, localToMs(startDt), localToMs(endDt), color, now, now],
        );
        this._run(
          "INSERT INTO RecurrenceRule (id,eventId,frequency,interval,weekdays,startDate,endDate,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
          [uuidHex(), eventId, frequency, interval, wdJson, sd, ed, now, now],
        );
      }

      const uniqueChecklist = [];
      const seenChecklist = new Set();
      for (const item of checklist) {
        const titleValue = get(item, "title");
        const key = JSON.stringify([casefold(pyStrip(truthy(titleValue) ? titleValue : "")), get(item, "order", 0)]);
        if (seenChecklist.has(key)) continue;
        seenChecklist.add(key);
        uniqueChecklist.push(item);
      }
      const keepIds = uniqueChecklist.filter((it) => truthy(get(it, "id"))).map((it) => it.id);
      if (keepIds.length) {
        this._run(
          `UPDATE ChecklistItem SET deleted=1 WHERE eventId=? AND deleted=0 AND id NOT IN (${placeholders(keepIds)})`,
          [eventId, ...keepIds],
        );
      } else {
        this._run("UPDATE ChecklistItem SET deleted=1 WHERE eventId=? AND deleted=0", [eventId]);
      }
      for (const it of uniqueChecklist) {
        if (truthy(get(it, "id")) && this._get("SELECT 1 FROM ChecklistItem WHERE id=? AND deleted=0", [it.id])) {
          this._run("UPDATE ChecklistItem SET title=?, \"order\"=?, updatedAt=? WHERE id=?", [it.title, it.order, now, it.id]);
        } else {
          this._run(
            "INSERT INTO ChecklistItem (id,eventId,title,\"order\",createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
            [uuidHex(), eventId, it.title, it.order, now, now],
          );
        }
      }
      return eventId;
    });
  }

  setTimeFormat(userId, value) {
    this._run("UPDATE User SET timeFormat=? WHERE id=?", [value, userId]);
  }

  setDailyLogsDir(userId, value) {
    this._run("UPDATE User SET dailyLogsDir=? WHERE id=?", [value, userId]);
  }

  _ensureUserColumn(column, colType = "TEXT") {
    const cols = this._columnNames("User");
    if (!cols.includes(column)) this._run(`ALTER TABLE User ADD COLUMN ${column} ${colType}`);
  }

  setCloudBackupDir(userId, value) {
    this._ensureUserColumn("cloudBackupDir");
    this._run("UPDATE User SET cloudBackupDir=? WHERE id=?", [value, userId]);
  }

  getSyncSettings() {
    const user = this.getUser() || {};
    return {
      enabled: truthy(get(user, "syncEnabled", 0)),
      url: truthy(get(user, "supabaseUrl")) ? user.supabaseUrl : "",
      key: truthy(get(user, "supabaseServiceKey")) ? user.supabaseServiceKey : "",
      lastSyncAt: get(user, "lastSyncAt"),
      lastSyncError: truthy(get(user, "lastSyncError")) ? user.lastSyncError : "",
    };
  }

  setSyncSettings(userId, enabled, url, key) {
    this._run(
      "UPDATE User SET syncEnabled=?, supabaseUrl=?, supabaseServiceKey=? WHERE id=?",
      [truthy(enabled) ? 1 : 0, pyStrip(url).replace(/\/+$/, ""), pyStrip(key), userId],
    );
  }

  recordSyncResult(error = "") {
    this._run(
      "UPDATE User SET lastSyncAt=?, lastSyncError=? WHERE id=(SELECT id FROM User ORDER BY createdAt ASC LIMIT 1)",
      [this._nowMs(), truthy(error) ? error : null],
    );
  }

  exportData() {
    this._ensureTaskReminderTable();
    this._ensureWhiteboardLinkTable();
    const tables = [
      "Project", "Stage", "DayTodo",
      "Event", "RecurrenceRule", "ChecklistItem", "ChecklistCompletion",
      "Task", "TaskCompletion", "TaskReminderShown", "EventCompletion", "WhiteboardLink", "ContentItem", "Note",
      "StepPreset", "RoutinePreset",
    ];
    const out = { version: 1 };
    for (const t of tables) {
      if (Object.hasOwn(SYNC_TABLE_PRIMARY_KEYS, t)) {
        out[t] = this._all(`SELECT * FROM ${q(t)} WHERE deleted=0`).map(withoutSyncColumns);
      } else {
        out[t] = this._all(`SELECT * FROM ${q(t)}`);
      }
    }
    const u = this._get("SELECT * FROM User LIMIT 1");
    out.user = u ? u : {};
    delete out.user.supabaseServiceKey;
    return out;
  }

  importData(payload) {
    this._ensureTaskReminderTable();
    this._ensureWhiteboardLinkTable();
    const deleteOrder = [
      "ChecklistCompletion", "ChecklistItem", "RecurrenceRule",
      "TaskReminderShown", "EventCompletion", "WhiteboardLink", "TaskCompletion", "Task", "ContentItem", "Note", "Event",
      "Stage", "DayTodo", "Project", "StepPreset", "RoutinePreset",
    ];
    const insertOrder = [
      "Project", "Stage", "DayTodo",
      "Event", "RecurrenceRule", "ChecklistItem", "ChecklistCompletion",
      "Task", "TaskCompletion", "TaskReminderShown", "EventCompletion", "WhiteboardLink", "ContentItem", "Note",
      "StepPreset", "RoutinePreset",
    ];
    const isDict = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !Buffer.isBuffer(value);
    this.sql.tx(() => {
      for (const t of deleteOrder) {
        if (Object.hasOwn(SYNC_TABLE_PRIMARY_KEYS, t)) this._run(`UPDATE ${q(t)} SET deleted=1 WHERE deleted=0`);
        else this._run(`DELETE FROM ${q(t)}`);
      }
      if (!isDict(payload)) throw new TypeError("'payload' object has no attribute 'get'");
      for (const t of insertOrder) {
        for (const source of get(payload, t, [])) {
          if (!truthy(source)) continue;
          let row;
          if (isDict(source)) row = { ...source };
          else if (Array.isArray(source) && source.every((pair) => Array.isArray(pair) && pair.length === 2)) row = Object.fromEntries(source);
          else throw new TypeError("cannot convert dictionary update sequence element");
          delete row.syncDirty;
          if (Object.hasOwn(SYNC_TABLE_PRIMARY_KEYS, t)) row.deleted = 0;
          const keys = Object.keys(row);
          const values = Object.values(row);
          values.forEach((value, index) => {
            if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
              throw new TypeError(`Error binding parameter ${index} - probably unsupported type.`);
            }
          });
          const cols = keys.map(q).join(",");
          this._run(`INSERT OR REPLACE INTO ${q(t)} (${cols}) VALUES (${placeholders(keys)})`, values);
        }
      }
      const userValue = get(payload, "user");
      const user = truthy(userValue) ? userValue : {};
      if (!isDict(user)) throw new TypeError("'user' object has no attribute 'get'");
      if (truthy(user) && truthy(get(user, "timeFormat"))) {
        this._run("UPDATE User SET timeFormat=? WHERE id=(SELECT id FROM User LIMIT 1)", [user.timeFormat]);
      }
      if (truthy(user) && has(user, "dailyLogsDir")) {
        this._run("UPDATE User SET dailyLogsDir=? WHERE id=(SELECT id FROM User LIMIT 1)", [get(user, "dailyLogsDir")]);
      }
    });
  }

  globalSearch(query, limit = 12) {
    const text = pyStrip(query);
    if (!text) return [];
    this._ensureWhiteboardLinkTable();
    const needle = `%${text}%`;
    const results = [];
    const eventRows = this._all(
      `SELECT id,title,notes,startAt,endAt FROM Event
                   WHERE deleted=0 AND (title LIKE ? OR COALESCE(notes,'') LIKE ?)
                   ORDER BY startAt DESC LIMIT ?`,
      [needle, needle, limit],
    );
    const taskRows = this._all(
      `SELECT id,title,notes,dueDate,time,status FROM Task
                   WHERE deleted=0 AND (title LIKE ? OR COALESCE(notes,'') LIKE ?)
                   ORDER BY dueDate DESC LIMIT ?`,
      [needle, needle, limit],
    );
    const eventDates = this._searchOccurrenceDates("event", eventRows.map((row) => row.id));
    const taskDates = this._searchOccurrenceDates("task", taskRows.map((row) => row.id));
    for (const row of eventRows) {
      const start = this._msDt(row.startAt);
      const found = eventDates.get(row.id);
      const key = truthy(found) ? found : (start ? dateKey(start) : null);
      results.push({
        kind: "event",
        title: row.title,
        subtitle: `Event - ${truthy(key) ? key : "no date"}`,
        dateKey: key,
        targetType: "event",
        targetId: row.id,
      });
    }
    for (const row of taskRows) {
      const due = this._msDt(row.dueDate);
      const found = taskDates.get(row.id);
      const key = truthy(found) ? found : (due ? dateKey(due) : null);
      results.push({
        kind: "task",
        title: row.title,
        subtitle: `Task - ${truthy(key) ? key : "no date"}`,
        dateKey: key,
        targetType: "task",
        targetId: row.id,
      });
    }
    for (const row of this._all(
      `SELECT id,title,kind,status,scheduledDate FROM ContentItem
                   WHERE deleted=0 AND (title LIKE ? OR COALESCE(notes,'') LIKE ? OR kind LIKE ?)
                   ORDER BY createdAt DESC LIMIT ?`,
      [needle, needle, needle, limit],
    )) {
      results.push({
        kind: "content",
        title: row.title,
        subtitle: `Content - ${pyStr(row.kind)} - ${truthy(row.scheduledDate) ? row.scheduledDate : "unscheduled"}`,
        dateKey: row.scheduledDate,
        targetType: "content",
        targetId: row.id,
      });
    }
    for (const row of this._all(
      `SELECT id,text,date FROM Note
                   WHERE deleted=0 AND text LIKE ? ORDER BY createdAt DESC LIMIT ?`,
      [needle, limit],
    )) {
      results.push({
        kind: "note",
        title: row.text,
        subtitle: `Note - ${pyStr(row.date)}`,
        dateKey: row.date,
        targetType: "day",
        targetId: row.date,
      });
    }
    for (const row of this._all(
      `SELECT targetType,targetId,label,path FROM WhiteboardLink
                   WHERE label LIKE ? OR targetId LIKE ? ORDER BY updatedAt DESC LIMIT ?`,
      [needle, needle, limit],
    )) {
      const dateKeyValue = row.targetType === "day" ? row.targetId : null;
      results.push({
        kind: "whiteboard",
        title: row.label,
        subtitle: `Whiteboard - ${pyStr(row.targetType)}`,
        dateKey: dateKeyValue,
        targetType: row.targetType,
        targetId: row.targetId,
        path: row.path,
      });
    }
    const settingsItems = [
      ["Preferences", "settings", "preferences"],
      ["Time format", "settings", "preferences"],
      ["Daily logs", "settings", "daily_logs"],
      ["Daily logs folder", "settings", "daily_logs"],
      ["Export data", "settings", "data"],
      ["Import data", "settings", "data"],
      ["Local backups", "settings", "data"],
      ["Startup launch", "settings", "preferences"],
      ["Device sync", "settings", "sync"],
      ["Supabase", "settings", "sync"],
      ["Sync now", "settings", "sync"],
    ];
    for (const [labelText, kind, section] of settingsItems) {
      if (labelText.toLowerCase().includes(text.toLowerCase())) {
        results.push({
          kind,
          title: labelText,
          subtitle: `Settings - ${section}`,
          dateKey: null,
          targetType: "settings",
          targetId: section,
        });
      }
    }
    return results.slice(0, limit);
  }

  _searchOccurrenceDates(kind, sourceIds) {
    const result = new Map();
    if (!sourceIds.length) return result;
    const wanted = new Set(sourceIds);
    const today = new Date();
    const start = startOfDay(today);
    const end = endOfDay(shift(today, { days: 370 }));
    let occurrences;
    try {
      occurrences = kind === "event" ? this.occurrencesForRange(start, end) : this.taskOccurrencesForRange(start, end);
    } catch {
      return new Map();
    }
    const sourceKey = kind === "event" ? "sourceEventId" : "sourceTaskId";
    for (const occurrence of occurrences) {
      const sourceId = get(occurrence, sourceKey);
      if (wanted.has(sourceId) && !result.has(sourceId)) result.set(sourceId, occurrence.dateKey);
    }
    return result;
  }

  createContentItem(userId, title, kind, status, scheduledDate, notes = null, projectId = null, stageId = null, parentStepId = null) {
    const now = this._nowMs();
    const cid = uuidHex();
    this._run(
      "INSERT INTO ContentItem (id,userId,kind,title,status,scheduledDate,notes,projectId,stageId,parentStepId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [cid, userId, kind, title, status, scheduledDate, notes, projectId, stageId, parentStepId, now, now],
    );
    return cid;
  }

  updateContentItem(itemId, patch = {}) {
    const now = this._nowMs();
    const sets = [];
    const vals = [];
    for (const k of ["title", "kind", "status", "scheduledDate", "notes", "projectId", "stageId", "parentStepId"]) {
      if (has(patch, k)) {
        sets.push(`${k}=?`);
        vals.push(patch[k]);
      }
    }
    if (!sets.length) return;
    sets.push("updatedAt=?");
    vals.push(now, itemId);
    this._run(`UPDATE ContentItem SET ${sets.join(",")} WHERE id=?`, vals);
  }

  deleteContentItem(itemId) {
    this._run("UPDATE ContentItem SET deleted=1 WHERE id=? OR parentStepId=?", [itemId, itemId]);
  }

  restoreContentItem(itemId) {
    this._run("UPDATE ContentItem SET deleted=0 WHERE id=? OR parentStepId=?", [itemId, itemId]);
  }

  restoreContentItems(itemIds) {
    const ids = Array.from(itemIds).filter((i) => truthy(i));
    if (!ids.length) return;
    this._run(`UPDATE ContentItem SET deleted=0, updatedAt=? WHERE id IN (${placeholders(ids)})`, [this._nowMs(), ...ids]);
  }

  getSubsteps(parentId) {
    return this._all("SELECT * FROM ContentItem WHERE parentStepId=? AND deleted=0 ORDER BY createdAt ASC", [parentId]);
  }

  syncParentStatus(parentId) {
    const substeps = this.getSubsteps(parentId);
    if (!substeps.length) return;
    const allDone = substeps.every((s) => get(s, "status") === "done");
    const newStatus = allDone ? "done" : "todo";
    this.updateContentItem(parentId, { status: newStatus });
  }

  createProject(userId, name, description = "", thumbnail = null, status = "idea") {
    const now = this._nowMs();
    const pid = uuidHex();
    this._run(
      "INSERT INTO Project (id,userId,name,description,thumbnail,status,\"order\",createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
      [pid, userId, name, truthy(description) ? description : "", thumbnail, status, now, now, now],
    );
    this.createStage(pid, "General");
    return pid;
  }

  getProjects(userId = null) {
    let out = this._all("SELECT * FROM Project WHERE deleted=0 ORDER BY createdAt DESC");
    if (truthy(userId)) out = out.filter((p) => get(p, "userId") === userId);
    return out;
  }

  getProject(projectId) {
    return this._get("SELECT * FROM Project WHERE id=? AND deleted=0", [projectId]);
  }

  updateProject(projectId, patch = {}) {
    const now = this._nowMs();
    const sets = [];
    const vals = [];
    for (const k of ["name", "description", "thumbnail", "status", "order"]) {
      if (has(patch, k)) {
        sets.push(`${q(k)}=?`);
        vals.push(patch[k]);
      }
    }
    if (!sets.length) return;
    sets.push("updatedAt=?");
    vals.push(now, projectId);
    this._run(`UPDATE Project SET ${sets.join(",")} WHERE id=?`, vals);
  }

  deleteProject(projectId, unfileItems = true) {
    this.sql.tx(() => {
      this._run("UPDATE Project SET deleted=1 WHERE id=?", [projectId]);
      if (truthy(unfileItems)) this._run("UPDATE ContentItem SET projectId=NULL WHERE projectId=?", [projectId]);
    });
  }

  restoreProject(projectId) {
    this._run("UPDATE Project SET deleted=0 WHERE id=?", [projectId]);
  }

  _migrateProjectStages() {
    this.sql.tx(() => {
      for (const row of this._all("SELECT id FROM Project WHERE deleted=0")) {
        const pid = row.id;
        const exists = this._get("SELECT 1 FROM Stage WHERE projectId=? AND deleted=0 LIMIT 1", [pid]);
        if (exists) continue;
        const now = this._nowMs();
        const sid = uuidHex();
        this._run("INSERT INTO Stage (id,projectId,name,\"order\",createdAt,updatedAt) VALUES (?,?,?,?,?,?)", [sid, pid, "General", now, now, now]);
        this._run("UPDATE ContentItem SET stageId=? WHERE projectId=? AND stageId IS NULL AND deleted=0", [sid, pid]);
      }
    });
  }

  createStage(projectId, name) {
    const now = this._nowMs();
    const sid = uuidHex();
    const stageName = pyStrip(truthy(name) ? name : "Stage") || "Stage";
    this._run("INSERT INTO Stage (id,projectId,name,\"order\",createdAt,updatedAt) VALUES (?,?,?,?,?,?)", [sid, projectId, stageName, now, now, now]);
    return sid;
  }

  getStages(projectId) {
    return this._all("SELECT * FROM Stage WHERE projectId=? AND deleted=0 ORDER BY \"order\" ASC, createdAt ASC", [projectId]);
  }

  updateStage(stageId, patch = {}) {
    const now = this._nowMs();
    const sets = [];
    const vals = [];
    for (const k of ["name", "order"]) {
      if (has(patch, k)) {
        sets.push(`${q(k)}=?`);
        vals.push(patch[k]);
      }
    }
    if (!sets.length) return;
    sets.push("updatedAt=?");
    vals.push(now, stageId);
    this._run(`UPDATE Stage SET ${sets.join(",")} WHERE id=?`, vals);
  }

  deleteStage(stageId) {
    this.sql.tx(() => {
      this._run("UPDATE ContentItem SET stageId=NULL WHERE stageId=?", [stageId]);
      this._run("UPDATE Stage SET deleted=1 WHERE id=?", [stageId]);
    });
  }

  assignUnfiledSteps(projectId, stageId) {
    this._run("UPDATE ContentItem SET stageId=? WHERE projectId=? AND stageId IS NULL AND deleted=0", [stageId, projectId]);
  }

  getStepPresets(userId = "") {
    const rows = this._all("SELECT id, name, steps, createdAt FROM StepPreset ORDER BY createdAt DESC");
    return rows.map((row) => {
      let steps;
      try {
        steps = pyJsonLoads(row.steps);
      } catch {
        steps = [];
      }
      return { id: row.id, name: row.name, steps, createdAt: row.createdAt };
    });
  }

  saveStepPreset(name, steps) {
    const pid = uuidHex();
    const now = this._nowMs();
    this._run("INSERT INTO StepPreset (id,userId,name,steps,createdAt) VALUES (?,?,?,?,?)", [pid, "", name, pyJsonDumps(steps), now]);
    return pid;
  }

  deleteStepPreset(presetId) {
    this._run("DELETE FROM StepPreset WHERE id=?", [presetId]);
  }

  getRoutinePresets() {
    const rows = this._all("SELECT id, name, title, startTime, endTime, notes, checklist, createdAt FROM RoutinePreset ORDER BY createdAt DESC");
    return rows.map((row) => {
      let checklist;
      try {
        checklist = pyJsonLoads(row.checklist);
      } catch {
        checklist = [];
      }
      return {
        id: row.id,
        name: row.name,
        title: row.title,
        startTime: row.startTime,
        endTime: row.endTime,
        notes: row.notes,
        checklist,
        createdAt: row.createdAt,
      };
    });
  }

  saveRoutinePreset(name, title, startTime, endTime, notes, checklist) {
    const pid = uuidHex();
    const now = this._nowMs();
    this._run(
      "INSERT INTO RoutinePreset (id,name,title,startTime,endTime,notes,checklist,createdAt) VALUES (?,?,?,?,?,?,?,?)",
      [pid, name, title, startTime, endTime, notes, pyJsonDumps(checklist), now],
    );
    return pid;
  }

  deleteRoutinePreset(presetId) {
    this._run("DELETE FROM RoutinePreset WHERE id=?", [presetId]);
  }

  addDayTodo(userId, dateKeyStr, text) {
    const now = this._nowMs();
    const tid = uuidHex();
    this._run(
      "INSERT INTO DayTodo (id,userId,date,text,completed,\"order\",createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)",
      [tid, userId, dateKeyStr, pyStrip(text), 0, now, now, now],
    );
    return tid;
  }

  getDayTodos(dateKeyStr) {
    return this._all("SELECT * FROM DayTodo WHERE date=? AND deleted=0 ORDER BY completed ASC, \"order\" ASC, createdAt ASC", [dateKeyStr]);
  }

  dayTodoDates() {
    return new Set(this._all("SELECT DISTINCT date FROM DayTodo WHERE deleted=0").map((row) => row.date));
  }

  setDayTodoDone(todoId, completed) {
    const now = this._nowMs();
    this._run("UPDATE DayTodo SET completed=?, updatedAt=? WHERE id=?", [truthy(completed) ? 1 : 0, now, todoId]);
  }

  deleteDayTodo(todoId) {
    this._run("UPDATE DayTodo SET deleted=1 WHERE id=?", [todoId]);
  }

  moveDayTodos(fromDateKey, toDateKey) {
    if (!truthy(fromDateKey) || fromDateKey === toDateKey) return;
    const now = this._nowMs();
    this._run("UPDATE DayTodo SET date=?, updatedAt=? WHERE date=? AND deleted=0", [toDateKey, now, fromDateKey]);
  }

  reorderSteps(projectId, stepIds) {
    this.sql.tx(() => {
      Array.from(stepIds).forEach((sid, i) => {
        this._run("UPDATE ContentItem SET createdAt=?, updatedAt=? WHERE id=?", [i + 1, this._nowMs(), sid]);
      });
    });
  }

  dueThisWeekItems(userId) {
    const today = new Date();
    const startDt = startOfDay(today);
    const endDt = endOfDay(shift(today, { days: 6 }));
    const items = [];
    const seenEvents = new Set();
    for (const occ of this.occurrencesForRange(startDt, endDt)) {
      if (truthy(get(occ, "isRecurring")) || truthy(get(occ, "eventCompleted")) || seenEvents.has(get(occ, "sourceEventId"))) continue;
      seenEvents.add(get(occ, "sourceEventId"));
      const full = get(occ, "fullStartAt");
      items.push({ kind: "event", title: get(occ, "title", ""), when: truthy(full) ? full : get(occ, "startAt") });
    }
    const startMs = localToMs(startDt);
    const endMs = localToMs(endDt);
    for (const row of this._all(
      "SELECT title,dueDate,time FROM Task WHERE userId=? AND deleted=0 AND status!='done' AND dueDate IS NOT NULL AND dueDate>=? AND dueDate<=? ORDER BY dueDate",
      [userId, startMs, endMs],
    )) {
      items.push({
        kind: "task",
        title: row.title,
        when: truthy(row.dueDate) ? this._msDt(row.dueDate) : null,
      });
    }
    return sorted(items, (it) => (truthy(get(it, "when")) ? it.when : MAX_DATE));
  }

  dueThisWeek(userId) {
    return this.dueThisWeekItems(userId).length;
  }

  activeCompletionDates() {
    const dates = new Set();
    for (const table of ["ChecklistCompletion", "TaskCompletion"]) {
      for (const row of this._all(`SELECT date FROM ${table} WHERE deleted=0 AND completed=1 AND date IS NOT NULL`)) {
        dates.add(dateKey(msToLocal(pyInt(row.date))));
      }
    }
    return dates;
  }

  contentStatusCounts() {
    const counts = { idea: 0, working: 0, scheduled: 0, done: 0 };
    for (const row of this._all("SELECT status, COUNT(*) AS n FROM ContentItem WHERE deleted=0 GROUP BY status")) {
      const key = String(truthy(row.status) ? row.status : "idea").toLowerCase();
      counts[key] = (Object.hasOwn(counts, key) ? counts[key] : 0) + pyInt(row.n);
    }
    return counts;
  }
}
