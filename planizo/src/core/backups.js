import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Sqlite } from "./sqlite.js";
import { isoLocal, shift, strftime, truthy, wallDiffMs } from "../py.js";

export const MANIFEST_NAME = "backup-manifest.json";

const WIN = process.platform === "win32";

export class RuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeError";
  }
}

export class BadZipFile extends Error {
  constructor(message) {
    super(message);
    this.name = "BadZipFile";
  }
}

export class FileNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "FileNotFoundError";
    this.code = "ENOENT";
  }
}

const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const ZIP64_LIMIT = 2 ** 31 - 1;
const ZIP_FILECOUNT_LIMIT = 0xffff;
const MAX_EXTRACT_VERSION = 63;
const CREATE_SYSTEM = WIN ? 0 : 3;
const EOCD_BYTES = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

function decodeName(buf, utf8) {
  if (utf8) return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  let out = "";
  for (const byte of buf) out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  return out;
}

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function dosDateTime(date) {
  let y = date.getFullYear();
  let mo = date.getMonth() + 1;
  let d = date.getDate();
  let h = date.getHours();
  let mi = date.getMinutes();
  let s = date.getSeconds();
  if (y < 1980) [y, mo, d, h, mi, s] = [1980, 1, 1, 0, 0, 0];
  if (y > 2107) [y, mo, d, h, mi, s] = [2107, 12, 31, 23, 59, 59];
  return { time: (h << 11) | (mi << 5) | Math.floor(s / 2), date: ((y - 1980) << 9) | (mo << 5) | d };
}

function u64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

export class ZipWriter {
  constructor(file) {
    this.file = String(file);
    this.fd = fs.openSync(this.file, "w", 0o600);
    this.offset = 0;
    this.entries = [];
  }

  _write(buf) {
    let done = 0;
    while (done < buf.length) done += fs.writeSync(this.fd, buf, done, buf.length - done);
    this.offset += buf.length;
  }

  add(name, data, { mtime = new Date(), mode = 0o600 } = {}) {
    const nameBuf = Buffer.from(name, "utf8");
    const flags = /[^\x00-\x7f]/.test(name) ? 0x800 : 0;
    const crc = crc32(data);
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const { time, date } = dosDateTime(mtime);
    const zip64 = data.length > ZIP64_LIMIT || comp.length > ZIP64_LIMIT;
    const extra = zip64 ? Buffer.concat([Buffer.from([1, 0, 16, 0]), u64(data.length), u64(comp.length)]) : Buffer.alloc(0);
    const version = zip64 ? 45 : 20;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt8(version, 4);
    header.writeUInt8(0, 5);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(zip64 ? 0xffffffff : comp.length, 18);
    header.writeUInt32LE(zip64 ? 0xffffffff : data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(extra.length, 28);
    const headerOffset = this.offset;
    this._write(Buffer.concat([header, nameBuf, extra]));
    this._write(comp);
    this.entries.push({
      nameBuf,
      flags,
      time,
      date,
      crc,
      compressSize: comp.length,
      fileSize: data.length,
      headerOffset,
      externalAttr: ((mode & 0xffff) << 16) >>> 0,
      version,
    });
  }

  writestr(name, text) {
    this.add(name, Buffer.from(text, "utf8"), { mtime: new Date(), mode: 0o600 });
  }

  close() {
    const start = this.offset;
    for (const e of this.entries) {
      const values = [];
      let fileSize = e.fileSize;
      let compressSize = e.compressSize;
      let headerOffset = e.headerOffset;
      if (fileSize > ZIP64_LIMIT || compressSize > ZIP64_LIMIT) {
        values.push(fileSize, compressSize);
        fileSize = 0xffffffff;
        compressSize = 0xffffffff;
      }
      if (headerOffset > ZIP64_LIMIT) {
        values.push(headerOffset);
        headerOffset = 0xffffffff;
      }
      const extra = values.length ? Buffer.concat([Buffer.from([1, 0, 8 * values.length, 0]), ...values.map(u64)]) : Buffer.alloc(0);
      const version = values.length ? 45 : e.version;
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt8(version, 4);
      h.writeUInt8(CREATE_SYSTEM, 5);
      h.writeUInt8(version, 6);
      h.writeUInt8(0, 7);
      h.writeUInt16LE(e.flags, 8);
      h.writeUInt16LE(8, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(compressSize, 20);
      h.writeUInt32LE(fileSize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE(e.externalAttr, 38);
      h.writeUInt32LE(headerOffset, 42);
      this._write(Buffer.concat([h, e.nameBuf, extra]));
    }
    const end = this.offset;
    let count = this.entries.length;
    let cdSize = end - start;
    let cdOffset = start;
    if (count > ZIP_FILECOUNT_LIMIT || cdOffset > ZIP64_LIMIT || cdSize > ZIP64_LIMIT) {
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(SIG_EOCD64, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE(45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeUInt32LE(0, 16);
      rec.writeUInt32LE(0, 20);
      rec.writeBigUInt64LE(BigInt(count), 24);
      rec.writeBigUInt64LE(BigInt(count), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40);
      rec.writeBigUInt64LE(BigInt(cdOffset), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(SIG_LOC64, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(end), 8);
      loc.writeUInt32LE(1, 16);
      this._write(Buffer.concat([rec, loc]));
      count = Math.min(count, 0xffff);
      cdSize = Math.min(cdSize, 0xffffffff);
      cdOffset = Math.min(cdOffset, 0xffffffff);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    this._write(eocd);
    this.abort();
  }

  abort() {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } finally {
      this.fd = null;
    }
  }
}

function splitDriveWin(p) {
  if (p.length >= 2) {
    const normp = p.replace(/\//g, "\\");
    if (normp.slice(0, 2) === "\\\\" && normp.slice(2, 3) !== "\\") {
      const index = normp.indexOf("\\", 2);
      if (index === -1) return ["", p];
      let index2 = normp.indexOf("\\", index + 1);
      if (index2 === index + 1) return ["", p];
      if (index2 === -1) index2 = p.length;
      return [p.slice(0, index2), p.slice(index2)];
    }
    if (normp.slice(1, 2) === ":") return [p.slice(0, 2), p.slice(2)];
  }
  return ["", p];
}

export class ZipReader {
  constructor(file) {
    this.file = String(file);
    this.fd = fs.openSync(this.file, "r");
    this.entries = [];
    this.byName = new Map();
    try {
      this._load();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  _readAt(pos, len) {
    const buf = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const n = fs.readSync(this.fd, buf, done, len - done, pos + done);
      if (n <= 0) break;
      done += n;
    }
    return done === len ? buf : buf.subarray(0, done);
  }

  _load() {
    const size = fs.fstatSync(this.fd).size;
    if (size < 22) throw new BadZipFile("File is not a zip file");
    let eocdPos = -1;
    const tail = this._readAt(size - 22, 22);
    if (tail.length === 22 && tail.readUInt32LE(0) === SIG_EOCD && tail.readUInt16LE(20) === 0) {
      eocdPos = size - 22;
    } else {
      const start = Math.max(size - (1 << 16) - 22, 0);
      const data = this._readAt(start, size - start);
      const idx = data.lastIndexOf(EOCD_BYTES);
      if (idx >= 0 && data.length - idx >= 22) eocdPos = start + idx;
    }
    if (eocdPos < 0) throw new BadZipFile("File is not a zip file");
    const rec = this._readAt(eocdPos, 22);
    let cdSize = rec.readUInt32LE(12);
    let cdOffset = rec.readUInt32LE(16);
    let zip64 = false;
    if (eocdPos >= 20) {
      const loc = this._readAt(eocdPos - 20, 20);
      if (loc.length === 20 && loc.readUInt32LE(0) === SIG_LOC64) {
        if (loc.readUInt32LE(4) !== 0 || loc.readUInt32LE(16) > 1) throw new BadZipFile("zipfiles that span multiple disks are not supported");
        const pos64 = eocdPos - 20 - 56;
        if (pos64 >= 0) {
          const rec64 = this._readAt(pos64, 56);
          if (rec64.length === 56 && rec64.readUInt32LE(0) === SIG_EOCD64) {
            cdSize = Number(rec64.readBigUInt64LE(40));
            cdOffset = Number(rec64.readBigUInt64LE(48));
            zip64 = true;
          }
        }
      }
    }
    let concat = eocdPos - cdSize - cdOffset;
    if (zip64) concat -= 56 + 20;
    const startDir = cdOffset + concat;
    if (startDir < 0) throw new BadZipFile("Bad offset for central directory");
    const cd = this._readAt(startDir, cdSize);
    let pos = 0;
    while (pos < cdSize) {
      if (cd.length - pos < 46) throw new BadZipFile("Truncated central directory");
      if (cd.readUInt32LE(pos) !== SIG_CENTRAL) throw new BadZipFile("Bad magic number for central directory");
      const flags = cd.readUInt16LE(pos + 8);
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      const extractVersion = cd.readUInt8(pos + 6);
      const origName = decodeName(cd.subarray(pos + 46, pos + 46 + nameLen), (flags & 0x800) !== 0);
      let name = origName;
      const nul = name.indexOf("\0");
      if (nul >= 0) name = name.slice(0, nul);
      if (WIN) name = name.replace(/\\/g, "/");
      const entry = {
        name,
        origName,
        flags,
        method: cd.readUInt16LE(pos + 10),
        crc: cd.readUInt32LE(pos + 16),
        compressSize: cd.readUInt32LE(pos + 20),
        fileSize: cd.readUInt32LE(pos + 24),
        headerOffset: cd.readUInt32LE(pos + 42),
        externalAttr: cd.readUInt32LE(pos + 38),
      };
      if (extractVersion > MAX_EXTRACT_VERSION) throw new Error(`zip file version ${(extractVersion / 10).toFixed(1)}`);
      this._decodeExtra(entry, cd.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen));
      entry.headerOffset += concat;
      this.entries.push(entry);
      this.byName.set(entry.name, entry);
      pos += 46 + nameLen + extraLen + commentLen;
    }
  }

  _decodeExtra(entry, extra) {
    let rest = extra;
    while (rest.length >= 4) {
      const tp = rest.readUInt16LE(0);
      const ln = rest.readUInt16LE(2);
      if (ln + 4 > rest.length) throw new BadZipFile(`Corrupt extra field ${tp.toString(16).padStart(4, "0")} (size=${ln})`);
      if (tp === 0x0001) {
        let data = rest.subarray(4, ln + 4);
        const take = (field) => {
          if (data.length < 8) throw new BadZipFile(`Corrupt zip64 extra field. ${field} not found.`);
          const value = Number(data.readBigUInt64LE(0));
          data = data.subarray(8);
          return value;
        };
        if (entry.fileSize === 0xffffffff) entry.fileSize = take("File size");
        if (entry.compressSize === 0xffffffff) entry.compressSize = take("Compress size");
        if (entry.headerOffset === 0xffffffff) entry.headerOffset = take("Header offset");
      }
      rest = rest.subarray(ln + 4);
    }
  }

  namelist() {
    return this.entries.map((e) => e.name);
  }

  has(name) {
    return this.byName.has(name);
  }

  readEntry(entry) {
    const header = this._readAt(entry.headerOffset, 30);
    if (header.length < 30) throw new BadZipFile("Truncated file header");
    if (header.readUInt32LE(0) !== SIG_LOCAL) throw new BadZipFile("Bad magic number for file header");
    const localFlags = header.readUInt16LE(6);
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    const fname = this._readAt(entry.headerOffset + 30, nameLen);
    if (entry.flags & 0x20) throw new Error("compressed patched data (flag bit 5)");
    if (entry.flags & 0x40) throw new Error("strong encryption (flag bit 6)");
    let localName;
    try {
      localName = decodeName(fname, (localFlags & 0x800) !== 0);
    } catch {
      localName = null;
    }
    if (localName !== entry.origName) {
      throw new BadZipFile(`File name in directory '${entry.origName}' and header b'${fname.toString("latin1")}' differ.`);
    }
    if (entry.flags & 0x1) throw new RuntimeError(`File '${entry.name}' is encrypted, password required for extraction`);
    if (entry.method !== 0 && entry.method !== 8) throw new Error("That compression method is not supported");
    const raw = this._readAt(entry.headerOffset + 30 + nameLen + extraLen, entry.compressSize);
    if (raw.length < entry.compressSize) throw new BadZipFile(`Truncated data for file '${entry.name}'`);
    let data = raw;
    if (entry.method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch (err) {
        throw new BadZipFile(`Error -3 while decompressing data: ${err.message}`);
      }
    }
    if (data.length > entry.fileSize) data = data.subarray(0, entry.fileSize);
    if (crc32(data) !== entry.crc) throw new BadZipFile(`Bad CRC-32 for file '${entry.name}'`);
    return data;
  }

  read(name) {
    const entry = this.byName.get(name);
    if (!entry) throw new Error(`"There is no item named '${name}' in the archive"`);
    return this.readEntry(entry);
  }

  testzip(onData = null) {
    for (const entry of this.entries) {
      let data;
      try {
        data = this.readEntry(entry);
      } catch (err) {
        if (err instanceof BadZipFile) return entry.name;
        throw err;
      }
      if (onData) onData(entry, data);
    }
    return null;
  }

  extractall(target) {
    for (const entry of this.entries) this._extractMember(entry, target);
  }

  _extractMember(entry, target) {
    let arcname = entry.name.split("/").join(path.sep);
    if (WIN) arcname = arcname.replace(/\//g, "\\");
    if (WIN) arcname = splitDriveWin(arcname)[1];
    arcname = arcname
      .split(path.sep)
      .filter((x) => x !== "" && x !== "." && x !== "..")
      .join(path.sep);
    if (WIN) {
      arcname = arcname
        .replace(/[:<>|"?*]/g, "_")
        .split("\\")
        .map((x) => x.replace(/\.+$/, ""))
        .filter((x) => x)
        .join("\\");
    }
    const targetPath = path.normalize(path.join(target, arcname));
    const upper = path.dirname(targetPath);
    if (upper && !fs.existsSync(upper)) fs.mkdirSync(upper, { recursive: true, mode: 0o700 });
    if (entry.name.endsWith("/")) {
      if (!isDir(targetPath)) fs.mkdirSync(targetPath, { mode: 0o700 });
      return targetPath;
    }
    fs.writeFileSync(targetPath, this.readEntry(entry), { mode: 0o600 });
    return targetPath;
  }

  close() {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } finally {
      this.fd = null;
    }
  }
}

function exists(p) {
  return fs.existsSync(p);
}

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

function rmQuiet(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
}

function unlinkMissingOk(p) {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!WIN || attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      sleepSync(100);
    }
  }
}

function withTempDir(root, prefix, fn) {
  const temp = fs.mkdtempSync(path.join(root, prefix));
  try {
    return fn(temp);
  } finally {
    rmQuiet(temp);
  }
}

export function resolvePath(p) {
  const abs = path.resolve(String(p));
  let head = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(head);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

function pathParts(p) {
  const root = path.parse(p).root;
  const rest = p
    .slice(root.length)
    .split(path.sep)
    .filter((x) => x);
  return root ? [root, ...rest] : rest;
}

function cparts(p) {
  const parts = pathParts(p);
  return WIN ? parts.map((x) => x.toLowerCase()) : parts;
}

function cmpStr(a, b) {
  if (a === b) return 0;
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const cx = x[i].codePointAt(0);
    const cy = y[i].codePointAt(0);
    if (cx !== cy) return cx - cy;
  }
  return x.length - y.length;
}

function cmpParts(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const c = cmpStr(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

export function pathKey(p) {
  let value;
  try {
    value = resolvePath(p);
  } catch {
    value = String(p);
  }
  return WIN ? value.replace(/\//g, "\\").toLowerCase() : value;
}

export function isRelativeTo(child, parent) {
  const a = cparts(resolvePath(child));
  const b = cparts(resolvePath(parent));
  if (b.length > a.length) return false;
  return b.every((x, i) => x === a[i]);
}

function samePath(a, b) {
  const x = cparts(resolvePath(a));
  const y = cparts(resolvePath(b));
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function pyTypeName(value) {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return "dict";
}

function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pyGet(obj, key, fallback = null) {
  if (!isDict(obj)) throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

function pyIter(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  if (isDict(value)) return Object.keys(value);
  throw new TypeError(`'${pyTypeName(value)}' object is not iterable`);
}

function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export function backupsDir(dataDir) {
  const p = path.join(String(dataDir), "backups");
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

function globBackups(root) {
  const rx = WIN ? /^Backup_[\s\S]*\.zip$/i : /^Backup_[\s\S]*\.zip$/;
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
    throw err;
  }
  return names.filter((name) => rx.test(name)).map((name) => path.join(root, name));
}

function byMtimeDesc(paths) {
  const decorated = paths.map((p, i) => [fs.statSync(p).mtimeMs, i, p]);
  decorated.sort((a, b) => (a[0] !== b[0] ? b[0] - a[0] : a[1] - b[1]));
  return decorated.map((x) => x[2]);
}

export function listBackups(dataDir) {
  return byMtimeDesc(globBackups(backupsDir(dataDir)));
}

export function createBackup(dataDir, dbPath, { reason = "manual", minIntervalMinutes = 0, keep = 120, sql = null } = {}) {
  const base = resolvePath(dataDir);
  const db = resolvePath(dbPath);
  const root = backupsDir(base);
  const now = new Date();

  if (minIntervalMinutes > 0) {
    const cutoff = shift(now, { minutes: -minIntervalMinutes });
    for (const existing of listBackups(base)) {
      if (wallDiffMs(new Date(fs.statSync(existing).mtimeMs), cutoff) >= 0) return null;
    }
  }

  const archive = path.join(root, `Backup_${strftime(now, "%Y-%m-%d_%H-%M-%S")}_${safeSlug(reason)}.zip`);
  const tempArchive = path.join(root, `.${path.basename(archive)}.tmp`);
  const manifest = {
    version: 2,
    app: "Calendizo",
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
    withTempDir(root, "calendizo-backup-", (temp) => {
      const dbExists = exists(db);
      if (dbExists) {
        const tempDb = path.join(temp, "calendizo.db");
        backupSqlite(db, tempDb, sql);
        scrubSecrets(tempDb);
        manifest.checks.sourceDbIntegrity = sqliteIntegrity(db, sql);
        manifest.checks.backupDbIntegrity = sqliteIntegrity(tempDb);
      }

      const sources = collectSources(base, db, manifest, sql);
      const seen = new Set();
      const zf = new ZipWriter(tempArchive);
      try {
        if (dbExists) addFile(zf, manifest, path.join(temp, "calendizo.db"), "calendizo.db", db, "sqlite_db");
        for (const source of sources) {
          const entry = Object.fromEntries(Object.entries(source).filter(([k]) => k !== "path"));
          if (source.type === "folder") {
            addFolder(zf, manifest, source.path, source.archivePrefix, source.kind, seen);
            manifest.restoreRoots.push(entry);
          } else if (source.type === "file") {
            const p = source.path;
            const key = pathKey(p);
            if (seen.has(key) || !exists(p)) continue;
            seen.add(key);
            addFile(zf, manifest, p, source.archivePath, p, source.kind);
            manifest.restoreFiles.push(entry);
          }
        }
        manifest.checks.fileCount = manifest.files.length;
        manifest.checks.cwboardCount = manifest.files.filter((f) => f.archivePath.toLowerCase().endsWith(".cwboard")).length;
        zf.writestr(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
        zf.close();
      } finally {
        zf.abort();
      }
      verifyArchive(tempArchive);
    });
    renameRetry(tempArchive, archive);
  } catch (err) {
    unlinkMissingOk(tempArchive);
    throw err;
  }

  pruneBackups(root, keep);
  return archive;
}

function copy2(source, target) {
  let dest = target;
  if (isDir(dest)) dest = path.join(dest, path.basename(source));
  fs.copyFileSync(source, dest);
  const st = fs.statSync(source);
  try {
    fs.utimesSync(dest, st.atime, st.mtime);
  } catch {}
  try {
    fs.chmodSync(dest, st.mode & 0o7777);
  } catch {}
  return dest;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function syncToCloud(archive, cloudDir, { retries = 3, delay = 5.0 } = {}) {
  if (!truthy(cloudDir)) return false;
  const source = String(archive);
  const dest = String(cloudDir);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
      const target = path.join(dest, path.basename(source));
      if (samePath(source, target)) return true;
      if (exists(target) && fs.statSync(target).size === fs.statSync(source).size) return true;
      copy2(source, target);
      return true;
    } catch {
      if (attempt < retries - 1) await sleep(delay * 1000);
    }
  }
  return false;
}

export async function syncAllBackupsToCloud(dataDir, cloudDir) {
  const backups = listBackups(dataDir);
  if (!truthy(cloudDir)) return [0, backups.length];
  try {
    fs.mkdirSync(String(cloudDir), { recursive: true, mode: 0o700 });
  } catch {
    return [0, backups.length];
  }
  let copied = 0;
  for (const archive of backups) {
    if (await syncToCloud(archive, cloudDir, { retries: 1 })) copied += 1;
  }
  return [copied, backups.length];
}

function pendingSidecar(db) {
  return ["-journal", "-wal"].some((suffix) => {
    let fd;
    try {
      fd = fs.openSync(db + suffix, "r");
    } catch {
      return false;
    }
    try {
      const head = Buffer.alloc(8);
      const n = fs.readSync(fd, head, 0, 8, 0);
      return head.subarray(0, n).some((x) => x !== 0);
    } finally {
      fs.closeSync(fd);
    }
  });
}

function installDb(sourceDb, db, hooks) {
  fs.mkdirSync(path.dirname(db), { recursive: true, mode: 0o700 });
  const temp = `${db}.${process.pid}.restore.tmp`;
  fs.copyFileSync(sourceDb, temp);
  let closed = false;
  try {
    if (hooks.closeDb) {
      hooks.closeDb();
      closed = true;
    }
    if (pendingSidecar(db) && exists(db)) {
      const probe = new Sqlite(db);
      try {
        probe.get("SELECT count(*) AS n FROM sqlite_master");
      } finally {
        probe.close();
      }
    }
    if (pendingSidecar(db)) throw new RuntimeError("The database is in use by another program.");
    renameRetry(temp, db);
  } catch (err) {
    unlinkMissingOk(temp);
    throw err;
  } finally {
    if (closed && hooks.reopenDb) hooks.reopenDb();
  }
}

export function restoreBackup(dataDir, dbPath, backupPath, hooks = {}) {
  const base = resolvePath(dataDir);
  const db = resolvePath(dbPath);
  const archive = String(backupPath);
  const manifest = verifyArchive(archive);
  if (!truthy(manifest)) {
    restoreLegacyBackup(base, db, archive, hooks);
    return;
  }

  withTempDir(backupsDir(base), "calendizo-restore-", (temp) => {
    const zf = new ZipReader(archive);
    try {
      extractZipSafely(zf, temp);
    } finally {
      zf.close();
    }

    const restoredDb = path.join(temp, "calendizo.db");
    if (exists(restoredDb)) {
      if (sqliteIntegrity(restoredDb) !== "ok") throw new RuntimeError("Backup database failed integrity check.");
      installDb(restoredDb, db, hooks);
    }

    for (const rootEntry of pyIter(pyGet(manifest, "restoreRoots", []))) {
      const prefix = pyGet(rootEntry, "archivePrefix", "");
      if (!truthy(prefix)) continue;
      const sourceFolder = path.resolve(temp, pyStr(prefix));
      const targetFolder = restoreTarget(base, rootEntry);
      if (targetFolder === null || !exists(sourceFolder)) continue;
      if (!safeToReplaceDir(targetFolder)) throw new RuntimeError(`Unsafe restore target: ${targetFolder}`);
      if (pyGet(rootEntry, "targetMode") === "data_dir") {
        replaceDir(sourceFolder, targetFolder);
      } else {
        fs.mkdirSync(targetFolder, { recursive: true, mode: 0o700 });
        fs.cpSync(sourceFolder, targetFolder, { recursive: true, force: true, preserveTimestamps: true });
      }
    }

    for (const fileEntry of pyIter(pyGet(manifest, "restoreFiles", []))) {
      const archivePath = pyGet(fileEntry, "archivePath", "");
      const targetFile = restoreTarget(base, fileEntry);
      if (!truthy(archivePath) || targetFile === null) continue;
      const sourceFile = path.resolve(temp, pyStr(archivePath));
      if (!exists(sourceFile)) continue;
      fs.mkdirSync(path.dirname(targetFile), { recursive: true, mode: 0o700 });
      copy2(sourceFile, targetFile);
    }
  });

  if (exists(db) && sqliteIntegrity(db) !== "ok") throw new RuntimeError("Restored database failed integrity check.");
}

function collectSources(base, db, manifest, sql = null) {
  const sources = [];
  const backupRoot = resolvePath(backupsDir(base));

  for (const name of ["whiteboard", "daily-logs", "content-thumbnails"]) {
    const folder = path.join(base, name);
    if (exists(folder)) {
      sources.push({
        type: "folder",
        kind: `data_${name}`,
        archivePrefix: `data/${name}`,
        targetMode: "data_dir",
        relativeTarget: name,
        path: folder,
      });
    }
  }

  for (const name of ["window_state.txt", "work-mail.json", "agent-chats.json", "deepseek-agent.json"]) {
    const p = path.join(base, name);
    if (exists(p)) {
      sources.push({
        type: "file",
        kind: "data_file",
        archivePath: `data/${name}`,
        targetMode: "data_dir",
        relativeTarget: name,
        path: p,
      });
    }
  }

  for (const [folder, kind, prefix] of externalFolders(base, db, manifest, sql)) {
    const resolved = resolvePath(folder);
    if (!exists(resolved) || isRelativeTo(resolved, base) || isRelativeTo(resolved, backupRoot)) continue;
    sources.push({
      type: "folder",
      kind,
      archivePrefix: prefix,
      targetMode: "absolute",
      target: resolved,
      path: resolved,
    });
  }

  for (const p of externalWorkspaceFiles(base, manifest)) {
    const resolved = resolvePath(p);
    if (!exists(resolved) || isRelativeTo(resolved, base)) continue;
    if (sources.some((s) => s.type === "folder" && isRelativeTo(resolved, resolvePath(s.path)))) continue;
    sources.push({
      type: "file",
      kind: "external_workspace_file",
      archivePath: `external/open-workspaces/${shortHash(resolved)}-${path.basename(resolved)}`,
      targetMode: "absolute",
      target: resolved,
      path: resolved,
    });
  }

  return sources;
}

function externalFolders(base, db, manifest, sql = null) {
  const folders = [];
  const session = readJson(path.join(base, "whiteboard", "session", "session.json")) || {};
  const workspaceDir = pyGet(session, "workspace_dir");
  if (truthy(workspaceDir)) folders.push([pyStr(workspaceDir), "external_whiteboard_workspaces", "external/whiteboard-workspaces"]);
  const dailyLogsDir = readUserPath(db, "dailyLogsDir", sql);
  if (dailyLogsDir) folders.push([dailyLogsDir, "external_daily_logs", "external/daily-logs"]);
  manifest.checks.workspaceDir = truthy(workspaceDir) ? workspaceDir : "";
  manifest.checks.dailyLogsDir = dailyLogsDir || "";
  return folders;
}

function externalWorkspaceFiles(base, manifest) {
  const session = readJson(path.join(base, "whiteboard", "session", "session.json")) || {};
  const out = [];
  for (const key of ["current_project_path", "last_workspace"]) {
    const value = pyGet(session, key);
    if (truthy(value)) out.push(pyStr(value));
  }
  const openWorkspaces = pyGet(session, "open_workspaces", []);
  if (Array.isArray(openWorkspaces)) {
    for (const value of openWorkspaces) {
      if (typeof value === "string" && value) out.push(value);
    }
  }
  const unique = [];
  const seen = new Set();
  for (const p of out) {
    const key = pathKey(p);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }
  manifest.checks.openWorkspaceCount = unique.length;
  return unique;
}

function rglob(folder) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      out.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(folder);
  return out;
}

export function addFolder(zf, manifest, folder, prefix, kind, seen) {
  const all = rglob(folder).map((p) => [cparts(p), p]);
  all.sort((a, b) => cmpParts(a[0], b[0]));
  for (const [, p] of all) {
    if (!isFile(p)) continue;
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = path.relative(folder, p).split(path.sep).join("/");
    addFile(zf, manifest, p, `${prefix}/${rel}`, p, kind);
  }
}

export function addFile(zf, manifest, file, archivePath, sourcePath, kind) {
  if (path.extname(file).toLowerCase() === ".cwboard") validateCwboard(file, manifest);
  const data = fs.readFileSync(file);
  const st = fs.statSync(file);
  const digest = crypto.createHash("sha256").update(data).digest("hex");
  zf.add(archivePath, data, { mtime: new Date(st.mtimeMs), mode: st.mode });
  manifest.files.push({
    archivePath,
    sourcePath: String(sourcePath),
    kind,
    size: data.length,
    sha256: digest,
  });
}

export function verifyArchive(archive) {
  const zf = new ZipReader(archive);
  try {
    const hashes = new Map();
    const bad = zf.testzip((entry, data) => {
      hashes.set(entry.name, crypto.createHash("sha256").update(data).digest("hex"));
    });
    if (bad) throw new RuntimeError(`Backup zip is corrupt at ${bad}.`);
    if (!zf.has(MANIFEST_NAME)) return null;
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(zf.read(MANIFEST_NAME));
    const manifest = JSON.parse(text);
    for (const entry of pyIter(pyGet(manifest, "files", []))) {
      const archivePath = pyGet(entry, "archivePath");
      const expected = pyGet(entry, "sha256");
      if (!truthy(archivePath) || !truthy(expected)) throw new RuntimeError("Backup manifest is missing file hash data.");
      if (!hashes.has(archivePath)) throw new Error(`"There is no item named '${pyStr(archivePath)}' in the archive"`);
      if (hashes.get(archivePath) !== expected) throw new RuntimeError(`Backup hash mismatch: ${pyStr(archivePath)}`);
    }
    return manifest;
  } finally {
    zf.close();
  }
}

export function extractZipSafely(zf, target) {
  const targetRoot = resolvePath(target);
  for (const entry of zf.entries) {
    const resolved = resolvePath(path.resolve(target, entry.name));
    if (!isRelativeTo(resolved, targetRoot)) throw new RuntimeError(`Unsafe backup path: ${entry.name}`);
  }
  zf.extractall(target);
}

export function backupSqlite(sourcePath, targetPath, sql = null) {
  const own = sql ? null : new Sqlite(sourcePath);
  try {
    (sql || own).run("VACUUM INTO ?", [String(targetPath)]);
  } finally {
    if (own) own.close();
  }
  if (sqliteIntegrity(targetPath) !== "ok") throw new RuntimeError("SQLite backup failed integrity check.");
}

export function scrubSecrets(file) {
  const conn = new Sqlite(file);
  try {
    const cols = conn.all("PRAGMA table_info(User)").map((row) => row.name);
    if (!cols.includes("supabaseServiceKey")) return;
    conn.exec("PRAGMA secure_delete=ON");
    conn.tx(() => conn.run("UPDATE User SET supabaseServiceKey=NULL"));
  } finally {
    conn.close();
  }
}

export function sqliteIntegrity(file, sql = null) {
  if (!exists(file)) return "missing";
  const own = sql ? null : new Sqlite(file);
  try {
    const row = (sql || own).get("PRAGMA integrity_check");
    return row ? String(Object.values(row)[0]) : "missing";
  } finally {
    if (own) own.close();
  }
}

export function validateCwboard(file, manifest) {
  let data;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
    data = JSON.parse(text);
  } catch (err) {
    manifest.warnings.push(`Invalid whiteboard workspace JSON: ${file} (${err.message})`);
    return;
  }
  if (!isDict(data)) {
    manifest.warnings.push(`Invalid whiteboard workspace: ${file}`);
    return;
  }
  const missing = ["cards", "annotations"].filter((key) => !Object.prototype.hasOwnProperty.call(data, key));
  if (missing.length) manifest.warnings.push(`${file} is missing ${missing.join(", ")}`);
  if (!Object.prototype.hasOwnProperty.call(data, "script")) manifest.warnings.push(`${file} has no script data`);
}

function readUserPath(db, column, sql = null) {
  if (!exists(db)) return "";
  let own = null;
  try {
    own = sql ? null : new Sqlite(db);
    const conn = sql || own;
    const cols = conn.all("PRAGMA table_info(User)").map((row) => row.name);
    if (!cols.includes(column)) return "";
    const row = conn.get(`SELECT ${column} FROM User LIMIT 1`);
    if (!row) return "";
    const value = Object.values(row)[0];
    return truthy(value) ? pyStr(value) : "";
  } catch {
    return "";
  } finally {
    if (own) own.close();
  }
}

function readJson(file) {
  try {
    if (exists(file)) {
      const data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file)));
      return isDict(data) ? data : null;
    }
  } catch {
    return null;
  }
  return null;
}

function restoreTarget(base, entry) {
  if (pyGet(entry, "targetMode") === "data_dir") {
    const relative = pyGet(entry, "relativeTarget", "");
    if (!truthy(relative)) return null;
    return path.resolve(base, pyStr(relative));
  }
  const target = pyGet(entry, "target", "");
  return truthy(target) ? path.resolve(pyStr(target)) : null;
}

function restoreLegacyBackup(base, db, archive, hooks = {}) {
  withTempDir(backupsDir(base), "calendizo-restore-", (temp) => {
    const zf = new ZipReader(archive);
    try {
      extractZipSafely(zf, temp);
    } finally {
      zf.close();
    }
    const restoredDb = path.join(temp, "calendizo.db");
    if (exists(restoredDb)) installDb(restoredDb, db, hooks);
    for (const folderName of ["whiteboard", "daily-logs"]) {
      const restoredFolder = path.join(temp, folderName);
      if (!exists(restoredFolder)) continue;
      replaceDir(restoredFolder, path.join(base, folderName));
    }
  });
}

export function replaceDir(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let old = null;
  if (exists(target)) {
    old = path.join(path.dirname(target), `${path.basename(target)}.restore-old`);
    if (exists(old)) rmQuiet(old);
    renameRetry(target, old);
  }
  try {
    fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } catch (err) {
    if (old !== null) {
      rmQuiet(target);
      renameRetry(old, target);
    }
    throw err;
  }
  if (old !== null) rmQuiet(old);
}

export function safeToReplaceDir(p) {
  const resolved = resolvePath(p);
  const root = path.parse(resolved).root;
  return pathParts(resolved).length >= pathParts(root).length + 1;
}

export function safeSlug(value) {
  const slug = String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "backup";
}

function shortHash(value) {
  return crypto.createHash("sha1").update(Buffer.from(String(value), "utf8")).digest("hex").slice(0, 10);
}

export function pruneBackups(root, keep) {
  if (keep <= 0) return;
  const backups = byMtimeDesc(globBackups(root));
  for (const p of backups.slice(keep)) unlinkMissingOk(p);
}
