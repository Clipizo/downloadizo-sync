import { isoLocal, truthy } from "./py.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.message = message;
  }
}

export class Raw {
  constructor(data, contentType, headers = {}) {
    this.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.contentType = contentType;
    this.headers = headers;
  }
}

export class Stream {
  constructor(generator) {
    this.generator = generator;
  }
}

export const ROUTES = [];

export function route(method, pattern, fn) {
  const source = String(pattern).replace(/\(\?P</g, "(?<");
  ROUTES.push([method, new RegExp("^" + source + "$"), fn]);
  return fn;
}

function jsonReplacer(key, value) {
  const raw = this[key];
  if (raw instanceof Date) return isoLocal(raw);
  if (raw instanceof Set) return [...raw].sort();
  if (raw instanceof Map) return Object.fromEntries(raw);
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return Buffer.from(raw).toString("base64");
  if (typeof raw === "bigint") return Number(raw);
  return value;
}

export function toJson(value) {
  return Buffer.from(JSON.stringify(value === undefined ? null : value, jsonReplacer), "utf-8");
}

export function parseQuery(search) {
  const query = {};
  for (const [name, value] of new URLSearchParams(search)) {
    if (value === "") continue;
    (query[name] ||= []).push(value);
  }
  return query;
}

export class Ctx {
  constructor(req, res, match, query, body) {
    this.req = req;
    this.res = res;
    this.handler = req;
    this.match = match;
    this.query = query;
    this.body = truthy(body) ? body : {};
    this.headers = req.headers;
  }

  q(name, fallback = null) {
    const values = this.query[name];
    return values && values.length ? values[0] : fallback;
  }

  b(name, fallback = null) {
    const body = this.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return fallback;
    return Object.prototype.hasOwnProperty.call(body, name) ? body[name] : fallback;
  }

  arg(index) {
    return this.match[index];
  }
}

export function send(res, status, data, contentType, headers = {}) {
  const extra = { ...headers };
  const cache = res.forceNoStore ? "no-store, private" : extra["Cache-Control"] ?? "no-store";
  delete extra["Cache-Control"];
  res.writeHead(status, {
    ...(res.calendizoHeaders || {}),
    "Content-Type": contentType,
    "Content-Length": String(data.length),
    "Cache-Control": cache,
    ...extra,
  });
  res.end(data);
}

const MAX_BODY = 64 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.readableEnded) return resolve(Buffer.alloc(0));
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, "That request is too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function dispatch(req, res, method, parsedUrl) {
  const query = parseQuery(parsedUrl.search);
  for (const [routeMethod, rx, fn] of ROUTES) {
    if (routeMethod !== method) continue;
    const match = rx.exec(parsedUrl.pathname);
    if (!match) continue;
    let body = null;
    const raw = await readBody(req);
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString("utf-8"));
      } catch {
        send(res, 400, toJson({ error: "Invalid JSON body." }), "application/json");
        return;
      }
    }
    let result;
    try {
      result = await fn(new Ctx(req, res, match, query, body));
    } catch (exc) {
      if (exc instanceof ApiError) {
        send(res, exc.status, toJson({ error: exc.message }), "application/json");
        return;
      }
      console.error(exc && exc.stack ? exc.stack : exc);
      send(res, 500, toJson({ error: (exc && exc.message) || "Server error." }), "application/json");
      return;
    }
    if (res.headersSent || res.writableEnded) return;
    if (result instanceof Raw) {
      send(res, 200, result.data, result.contentType, { ...result.headers });
    } else if (result instanceof Stream) {
      res.writeHead(200, {
        ...(res.calendizoHeaders || {}),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": res.forceNoStore ? "no-store, private" : "no-store",
        Connection: "close",
      });
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      try {
        for await (const event of result.generator) {
          if (closed) break;
          res.write(Buffer.concat([Buffer.from("data: "), toJson(event), Buffer.from("\n\n")]));
        }
      } catch (exc) {
        console.error(exc && exc.stack ? exc.stack : exc);
      }
      res.end();
    } else {
      send(res, 200, toJson(result === null || result === undefined ? { ok: true } : result), "application/json");
    }
    return;
  }
  send(res, 404, toJson({ error: "Not found." }), "application/json");
}
