"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const root = path.resolve(__dirname, "..");
const scratch = path.resolve(process.env.PLANIZO_TEST_DIR || path.join(os.tmpdir(), "planizo-mount-test"));
const planizoData = path.join(scratch, "planizo-data");
const syncData = path.join(scratch, "sync-data");
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(planizoData, { recursive: true });
fs.mkdirSync(syncData, { recursive: true });
process.env.CALENDIZO_WEB_DATA = planizoData;
process.env.SYNC_DATA_DIR = syncData;
process.env.SYNC_TOKEN_FILE = path.join(scratch, "sync-token");

let base = "";
let server = null;
let link = "";
let cookie = "";

const get = (pathname, headers = {}) => fetch(base + pathname, { redirect: "manual", headers });
const authed = (pathname) => get(pathname, { Cookie: cookie });

test.before(async () => {
  const { AccessGate } = await import(pathToFileURL(path.join(__dirname, "src", "access.js")).href);
  link = "/planizo/k/" + new AccessGate(planizoData).newLink("mount-test");
  const { createApp } = require(path.join(root, "app.js"));
  const app = createApp({ dataDir: syncData, token: "t".repeat(40) });
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) {
    server.closeAllConnections();
    server.close();
  }
});

test("Downloadizo keeps its own routes and headers", async () => {
  const health = await get("/api/health");
  assert.strictEqual(health.status, 200);
  assert.deepStrictEqual(await health.json(), { status: "ok" });
  assert.match(health.headers.get("content-security-policy"), /default-src 'none'/);
  assert.strictEqual((await get("/api/queue")).status, 401);
  assert.strictEqual((await get("/api/bootstrap")).status, 401);
  const home = await get("/");
  assert.match(await home.text(), /Downloadizo sync hub/);
});

test("everything under /planizo is hidden without the private link", async () => {
  for (const pathname of ["/planizo", "/planizo/", "/planizo/index.html", "/planizo/api/bootstrap", "/planizo/k/" + "x".repeat(43), "/planizo/robots"]) {
    const res = await get(pathname);
    assert.strictEqual(res.status, 404, pathname);
    assert.doesNotMatch(await res.text(), /id="root"/, pathname);
  }
});

test("the private link sets a cookie scoped to /planizo", async () => {
  const res = await get(link);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/planizo/");
  const setCookie = res.headers.get("set-cookie") || "";
  assert.match(setCookie, /Path=\/planizo;/);
  assert.match(setCookie, /HttpOnly/);
  cookie = setCookie.split(";")[0];
  assert.ok(cookie.length > 20);
});

test("with the cookie the app and its API work", async () => {
  assert.strictEqual((await authed("/planizo")).headers.get("location"), "/planizo/");
  const page = await authed("/planizo/");
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="root"/);
  assert.match(html, /\/planizo\/assets\//);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(page.headers.get("x-robots-tag"), /noindex/);
  assert.match(page.headers.get("cache-control"), /no-store/);
  const boot = await authed("/planizo/api/bootstrap");
  assert.strictEqual(boot.status, 200);
  assert.ok((await boot.json()).today);
  assert.strictEqual((await authed("/planizo/iconizo/iconizo-sprite.svg")).status, 200);
  const access = await (await authed("/planizo/api/access")).json();
  assert.strictEqual(access.enabled, true);
  assert.ok(access.devices.some((d) => d.current));
  assert.strictEqual((await get("/planizo/api/access")).status, 404);
});

test("nothing outside planizo/public is served under /planizo", async () => {
  const secret = [];
  for (const name of ["app.js", "security.js", "package.json"]) secret.push(fs.readFileSync(path.join(root, name), "utf-8").slice(0, 40));
  for (const name of ["mount.cjs", "server.js", "package.json", "src/main.js", "vendor/imapflow.mjs"]) {
    const file = path.join(__dirname, name);
    if (fs.existsSync(file)) secret.push(fs.readFileSync(file, "utf-8").slice(0, 40));
  }
  const probes = [
    "/planizo/mount.cjs", "/planizo/mount.test.cjs", "/planizo/server.js", "/planizo/package.json", "/planizo/package-lock.json",
    "/planizo/planizo-hosted.json", "/planizo/src/main.js", "/planizo/src/core/db.js", "/planizo/vendor/imapflow.mjs",
    "/planizo/vendor/THIRD-PARTY-LICENSES.txt", "/planizo/public/index.html", "/planizo/../app.js", "/planizo/%2e%2e/app.js",
    "/planizo/..%2fapp.js", "/planizo/..%2f..%2fapp.js", "/planizo/assets/..%2f..%2fsrc%2fmain.js", "/planizo/%2e%2e%2fmount.cjs",
    "/planizo/..%5capp.js", "/planizo/calendizo.db", "/planizo/.access.json", "/planizo/.secret.key", "/planizo/api/../calendizo.db",
    "/planizo/%00", "/planizo/%E0%A4%A", "/app.js", "/security.js", "/package.json", "/planizo/mount.cjs%00.png",
  ];
  for (const probe of probes) {
    const res = await authed(probe);
    const body = await res.text();
    assert.notStrictEqual(res.status, 200, probe);
    for (const head of secret) assert.ok(!body.includes(head), probe);
  }
});
