"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const { createApp } = require("./app");

// Private Unix sockets let the suite run on hosts that block loopback TCP.
function requestHttp(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = typeof url === "string" ? new URL(url) : null;
    const target = parsed ? { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search } : url;
    const request = http.request({ ...target, method: options.method || "GET", headers: options.headers, agent: false }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode,
        headers: { get: key => response.headers[key.toLowerCase()] ?? null },
        text: async () => Buffer.concat(chunks).toString("utf8") }));
    });
    request.setTimeout(10000, () => request.destroy(new Error("test request timeout")));
    request.on("error", reject);
    request.end(options.body);
  });
}

function listen(app, dataDir) {
  const address = process.platform === "win32" ? [0, "127.0.0.1"] : [path.join(dataDir, "http.sock")];
  return new Promise((resolve, reject) => {
    const server = app.listen(...address, () => resolve(server));
    server.once("error", reject);
  });
}

function endpoint(server, route) {
  const address = server.address();
  return typeof address === "string" ? { socketPath: address, path: route } : `http://127.0.0.1:${address.port}${route}`;
}

async function fixture(t, options = {}) {
  const scratch = path.join(__dirname, "Safe_to_delete");
  fs.mkdirSync(scratch, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(scratch, "security-"));
  const token = options.token === undefined ? crypto.randomBytes(32).toString("hex") : options.token;
  const app = createApp({ dataDir, token, auth: options.auth });
  const server = await listen(app, dataDir);
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function request(route, method = "GET", body, authorized = true, extra = {}) {
    const headers = { ...(authorized ? { "X-Token": token } : {}), ...extra };
    if (body !== undefined && typeof body !== "string") {
      body = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const response = await requestHttp(endpoint(server, route), { method, headers, body });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, raw,
      body: response.headers.get("content-type")?.includes("application/json") && raw ? JSON.parse(raw) : raw };
  }
  return { request, dataDir, token };
}

test("health reveals only liveness and every response prevents caching/framing/sniffing", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dataDir, "queue.json"), JSON.stringify([{ id: "private", url: "https://example.com/private" }]));
  await f.request("/api/transfer", "POST", { address: "http://192.168.1.5:53317" });
  const health = await f.request("/api/health", "GET", undefined, false);
  assert.deepEqual(health.body, { status: "ok" });
  for (const route of ["/", "/api/health", "/api/queue", "/missing"]) {
    const r = await f.request(route);
    assert.match(r.headers.get("cache-control"), /no-store/);
    assert.equal(r.headers.get("x-powered-by"), null);
    assert.equal(r.headers.get("etag"), null);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(r.headers.get("strict-transport-security"), /max-age=31536000/);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  }
});

test("all data reads and writes authenticate before parsing and leave state untouched", async t => {
  const f = await fixture(t);
  const protectedRoutes = [["GET", "/api/queue"], ["HEAD", "/api/queue"], ["POST", "/api/queue"],
    ["PATCH", "/api/queue/fixture"], ["DELETE", "/api/queue/fixture"], ["GET", "/api/cookies"],
    ["POST", "/api/cookies"], ["GET", "/api/pot"], ["POST", "/api/pot"],
    ["GET", "/api/transfer"], ["POST", "/api/transfer"], ["DELETE", "/api/transfer"]];
  for (const [method, route] of protectedRoutes) {
    const body = ["POST", "PATCH"].includes(method) ? '{"broken":' : undefined;
    const r = await f.request(route, method, body, false, { "Content-Type": "application/json" });
    assert.equal(r.status, 401, `${method} ${route}`);
  }
  assert.deepEqual(fs.readdirSync(f.dataDir).filter(name => name !== "http.sock"), []);
});

test("missing or weak configuration fails closed without revealing its name", async t => {
  for (const token of ["", "short"]) {
    const f = await fixture(t, { token });
    const r = await f.request("/api/queue");
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: "service unavailable" });
  }
});

test("the private rotated token overrides an old hosting environment token", async t => {
  const scratch = path.join(__dirname, "Safe_to_delete");
  fs.mkdirSync(scratch, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(scratch, "rotation-"));
  const tokenFile = path.join(dataDir, "private-token");
  const rotated = crypto.randomBytes(32).toString("hex");
  const obsolete = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenFile, rotated, { mode: 0o600 });
  const previous = process.env.SYNC_TOKEN;
  process.env.SYNC_TOKEN = obsolete;
  const app = createApp({ dataDir, tokenFile });
  if (previous === undefined) delete process.env.SYNC_TOKEN;
  else process.env.SYNC_TOKEN = previous;
  const server = await listen(app, dataDir);
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const [token, expected] of [[rotated, 200], [obsolete, 401]]) {
    const response = await requestHttp(endpoint(server, "/api/queue"), { headers: { "X-Token": token } });
    assert.equal(response.status, expected);
    await response.text();
  }
});

test("header credentials work; URL credentials, invalid headers and forwarding spoofing do not", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/queue?token=" + f.token, "GET", undefined, false)).status, 400);
  assert.equal((await f.request("/api/queue", "GET", undefined, false, { "X-Token": "wrong", "X-Forwarded-For": "127.0.0.1" })).status, 401);
  assert.equal((await f.request("/api/queue")).status, 200);
});

test("authentication attempts are bounded without letting an attacker lock out valid clients", async t => {
  let now = 0;
  const f = await fixture(t, { auth: { failedLimit: 2, requestLimit: 2, now: () => now } });
  assert.equal((await f.request("/api/queue", "GET", undefined, false)).status, 401);
  assert.equal((await f.request("/api/queue", "GET", undefined, false)).status, 401);
  const limited = await f.request("/api/queue", "GET", undefined, false, { "X-Forwarded-For": "different" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal((await f.request("/api/queue")).status, 200);
  assert.equal((await f.request("/api/queue")).status, 200);
  assert.equal((await f.request("/api/queue")).status, 429);
  now += 60001;
  assert.equal((await f.request("/api/queue")).status, 200);
});

test("invalid JSON, encodings and large bodies return bounded JSON errors", async t => {
  const f = await fixture(t);
  for (const [body, headers, status] of [
    ['{"broken":', { "Content-Type": "application/json" }, 400],
    [JSON.stringify({ url: "https://example.com", label: "a".repeat(40000) }), { "Content-Type": "application/json" }, 413],
    ["data", { "Content-Type": "text/plain" }, 415],
    ["gzip", { "Content-Type": "application/json", "Content-Encoding": "gzip" }, 415],
  ]) {
    const r = await f.request("/api/queue", "POST", body, true, headers);
    assert.equal(r.status, status);
    assert.equal(typeof r.body.error, "string");
    assert.doesNotMatch(r.raw, /node_modules|SyntaxError|stack|\/home\//);
  }
});

test("queue create/update/pause/reset/delete remains compatible with both clients", async t => {
  const f = await fixture(t);
  const r = await f.request("/api/queue", "POST", { url: "https://example.com/video?q=1", device: "pc", label: "Title", time_start: "1:30.5", time_end: "2:00" });
  assert.equal(r.status, 200);
  assert.equal(r.body.addedBy, "pc");
  assert.equal(r.body.status, "queued");
  const id = r.body.id;
  for (const patch of [{ status: "downloading", device: "mobile", progress: 0.4 }, { status: "paused" },
    { status: "queued", device: null, progress: 0, error: "" }, { status: "done", filename: "video.mp4" }]) {
    const update = await f.request("/api/queue/" + id, "PATCH", patch);
    assert.equal(update.status, 200);
    for (const [key, value] of Object.entries(patch)) assert.deepEqual(update.body[key], value);
  }
  assert.equal((await f.request("/api/queue")).body.length, 1);
  assert.equal((await f.request("/api/queue/" + id, "DELETE")).body.deleted, true);
  assert.deepEqual((await f.request("/api/queue")).body, []);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(f.dataDir, "queue.json")).mode & 0o777, 0o600);
});

test("untrusted shapes, schemes, status, nested values and prototype keys cannot alter stored queue", async t => {
  const f = await fixture(t);
  const created = await f.request("/api/queue", "POST", { url: "https://example.com" });
  const before = fs.readFileSync(path.join(f.dataDir, "queue.json"), "utf8");
  for (const body of [[], { url: "file:///private" }, { url: "javascript:alert(1)" }, { url: "https://user:secret@example.com" },
    { url: "https://example.com", label: {} }, { url: "https://example.com", device: ["pc"] },
    { url: "https://example.com", time_end: "1;command" }, { url: "https://example.com", label: "x".repeat(513) }]) {
    assert.equal((await f.request("/api/queue", "POST", body)).status, 400);
  }
  const route = "/api/queue/" + created.body.id;
  for (const body of [{ status: "admin" }, { progress: 2 }, { progress: "1" }, { error: {} }, { id: "replacement" }, { url: "file:///private" }]) {
    assert.equal((await f.request(route, "PATCH", body)).status, 400);
  }
  assert.equal((await f.request(route, "PATCH", '{"__proto__":{"polluted":true}}', true, { "Content-Type": "application/json" })).status, 400);
  assert.equal({}.polluted, undefined);
  assert.equal(fs.readFileSync(path.join(f.dataDir, "queue.json"), "utf8"), before);
});

test("corrupt queues fail safely instead of being replaced with a new empty store", async t => {
  const f = await fixture(t);
  const file = path.join(f.dataDir, "queue.json");
  fs.writeFileSync(file, "invalid-existing-state");
  assert.equal((await f.request("/api/queue")).status, 500);
  assert.equal((await f.request("/api/queue", "POST", { url: "https://example.com" })).status, 500);
  assert.equal(fs.readFileSync(file, "utf8"), "invalid-existing-state");
});

test("queue capacity cannot grow without bound", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dataDir, "queue.json"), JSON.stringify(Array.from({ length: 5000 }, (_, id) => ({ id }))));
  assert.equal((await f.request("/api/queue", "POST", { url: "https://example.com" })).status, 409);
});

const cookie = ".youtube.com\tTRUE\t/\tTRUE\t2000000000\tfixture\tnot-a-session";
test("cookie uploads and legacy reads share only valid YouTube rows", async t => {
  const f = await fixture(t);
  const jar = cookie + "\n.bank.example\tTRUE\t/\tTRUE\t2000000000\tprivate\tfixture\n.youtube.com.evil.example\tTRUE\t/\tTRUE\t2000000000\tbad\tfixture\n";
  const r = await f.request("/api/cookies", "POST", jar, true, { "Content-Type": "text/plain" });
  assert.equal(r.status, 200);
  const downloaded = await f.request("/api/cookies");
  assert.match(downloaded.raw, /Netscape HTTP Cookie File/);
  assert.ok(downloaded.raw.includes(cookie));
  assert.doesNotMatch(downloaded.raw, /bank|evil/);
  fs.writeFileSync(path.join(f.dataDir, "cookies.txt"), jar);
  assert.doesNotMatch((await f.request("/api/cookies")).raw, /bank|evil/);
  assert.equal((await f.request("/api/cookies", "POST", "fake .youtube.com", true, { "Content-Type": "text/plain" })).status, 400);
  assert.equal((await f.request("/api/cookies", "POST", {})).status, 415);
  const large = Array.from({ length: 1200 }, (_, i) => `.youtube.com\tTRUE\t/\tTRUE\t2000000000\tfixture${i}\t${"x".repeat(240)}`).join("\n");
  assert.ok(Buffer.byteLength(large) > 256 * 1024);
  assert.equal((await f.request("/api/cookies", "POST", large, true, { "Content-Type": "text/plain" })).status, 200);
  assert.equal((await f.request("/api/cookies", "POST", "x".repeat(2 * 1024 * 1024 + 1), true, { "Content-Type": "text/plain" })).status, 413);
});

test("PO token and transfer registration validate input and retain their native formats", async t => {
  const f = await fixture(t);
  const pot = { token: "fixture-proof", visitorData: "fixture-visitor" };
  assert.equal((await f.request("/api/pot", "POST", pot)).status, 200);
  assert.equal((await f.request("/api/pot")).body.token, pot.token);
  assert.equal((await f.request("/api/pot", "POST", { token: {} })).status, 400);
  assert.equal((await f.request("/api/pot", "POST", { token: "fixture", expireAt: "tomorrow" })).status, 400);
  for (const address of ["https://192.168.1.3:53317", "192.168.1.3:53317", ""]) {
    assert.equal((await f.request("/api/transfer", "POST", { address })).status, 200);
    assert.equal((await f.request("/api/transfer")).body.address, address);
  }
  for (const address of [{ nested: true }, "file:///private", "https://user:pass@example.com", "https://example.com/path"]) {
    assert.equal((await f.request("/api/transfer", "POST", { address })).status, 400);
  }
  assert.equal((await f.request("/api/transfer", "DELETE")).body.ok, true);
});

test("runtime and source files are never exposed as static resources", async t => {
  const f = await fixture(t);
  for (const route of ["/.sync_token", "/queue.json", "/cookies.txt", "/pot.json", "/app.js", "/security.js", "/package.json", "/.env"]) {
    assert.equal((await f.request(route, "GET", undefined, false)).status, 404, route);
  }
});
