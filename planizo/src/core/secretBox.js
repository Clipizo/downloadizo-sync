import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PREFIX = "k1:";
let keyFile = null;
let cachedKey = null;
const dpapiCache = new Map();

export function configureSecrets(dataDir) {
  keyFile = process.env.CALENDIZO_SECRET_KEY_FILE || path.join(String(dataDir), ".secret.key");
  cachedKey = null;
}

function masterKey() {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.CALENDIZO_SECRET_KEY;
  if (fromEnv) {
    cachedKey = crypto.createHash("sha256").update(fromEnv, "utf-8").digest();
    return cachedKey;
  }
  if (!keyFile) throw new Error("Secret storage is not configured.");
  try {
    const existing = fs.readFileSync(keyFile);
    if (existing.length >= 32) {
      cachedKey = existing.subarray(0, 32);
      return cachedKey;
    }
  } catch {}
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const fresh = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, fresh, { mode: 0o600 });
  try {
    fs.chmodSync(keyFile, 0o600);
  } catch {}
  cachedKey = fresh;
  return cachedKey;
}

function subKey(label) {
  return crypto.createHmac("sha256", masterKey()).update(label).digest();
}

function keystream(key, nonce, length) {
  const blocks = [];
  let total = 0;
  for (let counter = 0; total < length; counter += 1) {
    const ctr = Buffer.alloc(8);
    ctr.writeBigUInt64BE(BigInt(counter));
    const block = crypto.createHmac("sha256", key).update(Buffer.concat([Buffer.from("ks"), nonce, ctr])).digest();
    blocks.push(block);
    total += block.length;
  }
  return Buffer.concat(blocks).subarray(0, length);
}

export function protect(secret) {
  const plaintext = Buffer.from(String(secret), "utf-8");
  const nonce = crypto.randomBytes(16);
  const stream = keystream(subKey("calendizo-enc"), nonce, plaintext.length);
  const cipher = Buffer.alloc(plaintext.length);
  for (let i = 0; i < plaintext.length; i += 1) cipher[i] = plaintext[i] ^ stream[i];
  const tag = crypto.createHmac("sha256", subKey("calendizo-mac")).update(Buffer.concat([Buffer.from("k1"), nonce, cipher])).digest();
  return PREFIX + Buffer.concat([nonce, cipher, tag]).toString("base64url");
}

function openK1(blob) {
  const raw = Buffer.from(blob.slice(PREFIX.length), "base64url");
  if (raw.length < 48) throw new Error("locked");
  const nonce = raw.subarray(0, 16);
  const tag = raw.subarray(raw.length - 32);
  const cipher = raw.subarray(16, raw.length - 32);
  const expected = crypto.createHmac("sha256", subKey("calendizo-mac")).update(Buffer.concat([Buffer.from("k1"), nonce, cipher])).digest();
  if (!crypto.timingSafeEqual(tag, expected)) throw new Error("locked");
  const stream = keystream(subKey("calendizo-enc"), nonce, cipher.length);
  const plain = Buffer.alloc(cipher.length);
  for (let i = 0; i < cipher.length; i += 1) plain[i] = cipher[i] ^ stream[i];
  return plain.toString("utf-8");
}

function openDpapi(blob) {
  if (process.platform !== "win32") throw new Error("locked");
  if (dpapiCache.has(blob)) return dpapiCache.get(blob);
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
    "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
    "[Console]::Out.Write([Convert]::ToBase64String($p))";
  let out;
  try {
    out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: blob,
      encoding: "utf-8",
      windowsHide: true,
      timeout: 20000,
    });
  } catch {
    throw new Error("locked");
  }
  const value = Buffer.from(out.trim(), "base64").toString("utf-8");
  dpapiCache.set(blob, value);
  return value;
}

export function unprotect(blob) {
  const text = String(blob || "");
  if (!text) return "";
  if (text.startsWith(PREFIX)) return openK1(text);
  if (text.startsWith("plain:")) return Buffer.from(text.slice(6), "base64").toString("utf-8");
  return openDpapi(text);
}

export function canUnprotect(blob) {
  try {
    unprotect(blob);
    return true;
  } catch {
    return false;
  }
}
