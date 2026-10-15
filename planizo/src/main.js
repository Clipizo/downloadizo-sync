import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AccessGate, deviceLabel } from "./access.js";
import { ApiError, dispatch, route, send } from "./http.js";
import { configureSecrets } from "./core/secretBox.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
};

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

export function applyHostedMarker() {
  try {
    const hosted = JSON.parse(fs.readFileSync(path.join(appRoot, "planizo-hosted.json"), "utf-8"));
    process.env.CALENDIZO_HOSTED = "1";
    if (hosted.timezone && !process.env.CALENDIZO_TZ) process.env.CALENDIZO_TZ = hosted.timezone;
    if (hosted.publicUrl && !process.env.CALENDIZO_PUBLIC_URL) process.env.CALENDIZO_PUBLIC_URL = hosted.publicUrl;
  } catch {}
  if (process.env.CALENDIZO_TZ && process.env.TZ !== process.env.CALENDIZO_TZ) process.env.TZ = process.env.CALENDIZO_TZ;
}

function isHosted() {
  return Boolean(process.env.PASSENGER_APP_ENV) || process.env.CALENDIZO_HOSTED === "1";
}

export function resolveDataDir() {
  if (process.env.CALENDIZO_WEB_DATA) return path.resolve(process.env.CALENDIZO_WEB_DATA);
  if (isHosted()) return path.join(os.homedir(), ".local", "share", "planizo");
  return path.resolve(appRoot, "..", "data");
}

function resolveStaticDir() {
  const candidates = [process.env.CALENDIZO_STATIC, path.join(appRoot, "public"), path.resolve(appRoot, "..", "client", "dist")].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return path.resolve(dir);
  }
  return null;
}

function serveStatic(staticDir, pathname, res) {
  if (!staticDir) return false;
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (rel === "/" || rel === "") rel = "/index.html";
  if (rel.includes("\0")) return false;
  const target = path.resolve(staticDir, "." + rel);
  if (!target.startsWith(staticDir + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const data = fs.readFileSync(target);
  send(res, 200, data, MIME[path.extname(target).toLowerCase()] || "application/octet-stream", { "Cache-Control": "no-store, private" });
  return true;
}

function plain(res, status, text, extra = {}) {
  send(res, status, Buffer.from(text), "text/plain; charset=utf-8", { "Cache-Control": "no-store, private", ...extra });
}

function tightenTree(dir) {
  let entries;
  try {
    fs.chmodSync(dir, 0o700);
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tightenTree(full);
    else if (entry.isFile()) {
      try {
        fs.chmodSync(full, 0o600);
      } catch {}
    }
  }
}

function openData() {
  applyHostedMarker();
  const dataDir = resolveDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") tightenTree(dataDir);
  configureSecrets(dataDir);
  return { dataDir, gate: new AccessGate(dataDir) };
}

export async function createPlanizo({ basePath = "" } = {}) {
  const { dataDir, gate } = openData();
  const { startApp } = await import("./app.js");
  const app = await startApp({ dataDir });
  const staticDir = resolveStaticDir();
  const hosted = isHosted();
  const requireAccess = hosted || gate.enabled || process.env.CALENDIZO_PRIVATE === "1";
  const secureCookie = process.env.CALENDIZO_INSECURE_COOKIE !== "1" && (hosted || process.env.CALENDIZO_PRIVATE === "1");
  const base = String(basePath).replace(/\/+$/, "");
  const home = base + "/";
  const accessState = (ctx) => (requireAccess ? { enabled: true, devices: gate.devices(ctx.req) } : { enabled: false, devices: [] });
  const needAccess = () => {
    if (!requireAccess) throw new ApiError(404, "Not found.");
  };
  route("GET", "/api/access", accessState);
  route("POST", "/api/access/sign-out", (ctx) => {
    needAccess();
    const id = String(ctx.b("id") || "");
    if (!/^(others|[0-9a-f]{16})$/.test(id)) throw new ApiError(400, "Choose a device.");
    gate.signOut(ctx.req, id);
    return accessState(ctx);
  });
  route("POST", "/api/access/new-link", () => {
    needAccess();
    return { path: `${base}/k/${gate.replaceLinks("owner")}` };
  });

  async function handle(req, res) {
    res.calendizoHeaders = SECURITY_HEADERS;
    res.forceNoStore = requireAccess;
    try {
      const full = new URL("http://localhost");
      const raw = String(req.originalUrl || req.url || "/");
      const queryAt = raw.indexOf("?");
      full.pathname = queryAt >= 0 ? raw.slice(0, queryAt) : raw;
      full.search = queryAt >= 0 ? raw.slice(queryAt) : "";
      const method = (req.method || "GET").toUpperCase();
      let pathname = full.pathname;
      if (base) {
        if (pathname !== base && !pathname.startsWith(base + "/")) return plain(res, 404, "Not found\n");
        pathname = pathname.slice(base.length);
      }
      if (pathname === "/robots.txt") return plain(res, 200, "User-agent: *\nDisallow: /\n");
      if (requireAccess) {
        const linkMatch = /^\/k\/([A-Za-z0-9_-]{20,100})\/?$/.exec(pathname);
        if (linkMatch && method === "GET") {
          const ip = gate.clientIp(req);
          if (gate.tooManyFails(ip)) return plain(res, 429, "Too many attempts\n");
          const session = gate.redeem(linkMatch[1], deviceLabel(req.headers["user-agent"]));
          if (!session) {
            gate.noteFail(ip);
            return plain(res, 404, "Not found\n");
          }
          res.writeHead(302, { ...SECURITY_HEADERS, Location: home, "Set-Cookie": gate.cookie(session, secureCookie, base || "/"), "Cache-Control": "no-store, private", "Content-Length": "0" });
          res.end();
          return;
        }
        if (!gate.allowed(req)) {
          if (linkMatch || pathname.startsWith("/k/")) gate.noteFail(gate.clientIp(req));
          return plain(res, 404, "Not found\n");
        }
      }
      if (pathname === "") {
        res.writeHead(302, { ...SECURITY_HEADERS, Location: home + full.search, "Cache-Control": "no-store, private", "Content-Length": "0" });
        res.end();
        return;
      }
      const url = new URL("http://localhost");
      url.pathname = pathname;
      url.search = full.search;
      if (pathname.startsWith("/api/")) {
        await dispatch(req, res, method, url);
        return;
      }
      if ((method === "GET" || method === "HEAD") && serveStatic(staticDir, pathname, res)) return;
      plain(res, 404, "Not found\n");
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      try {
        if (!res.headersSent) plain(res, 500, "Server error\n");
        else res.end();
      } catch {}
    }
  }

  return { handle, afterListen: () => app.afterListen?.(), dataDir, staticDir, requireAccess };
}

export async function main(args) {
  if (args.includes("--new-link")) {
    const { gate } = openData();
    const base = (argValue(args, "--base") || "").replace(/\/+$/, "");
    const token = gate.newLink(argValue(args, "--label") || "owner");
    console.log(`${base}/k/${token}`);
    return;
  }
  if (args.includes("--revoke-links")) {
    openData().gate.revokeAll();
    console.log("All private links and sessions revoked.");
    return;
  }

  const planizo = await createPlanizo({ basePath: argValue(args, "--base-path") || "" });
  const server = http.createServer((req, res) => void planizo.handle(req, res));
  server.keepAliveTimeout = 65000;
  const port = Number(argValue(args, "--port") || process.env.PORT || process.env.CALENDIZO_API_PORT || 8766);
  const host = argValue(args, "--host") || (process.env.PASSENGER_APP_ENV ? undefined : "127.0.0.1");
  await new Promise((resolve) => server.listen(port, host, resolve));
  const { dataDir, staticDir, requireAccess } = planizo;
  console.log(`[api] Planizo on ${host || "*"}:${port} (data: ${dataDir}${staticDir ? `, static: ${staticDir}` : ""}${requireAccess ? ", private link required" : ""})`);
  planizo.afterListen();
  return server;
}
