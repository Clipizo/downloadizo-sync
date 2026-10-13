"use strict";
const path = require("path");
const { pathToFileURL } = require("url");

const BASE = "/planizo";
const HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};
let loading = null;

function start() {
  if (!loading) {
    loading = import(pathToFileURL(path.join(__dirname, "src", "main.js")).href)
      .then((planizo) => planizo.createPlanizo({ basePath: BASE }))
      .then((planizo) => {
        planizo.afterListen();
        return planizo.handle;
      })
      .catch((err) => {
        console.error("[planizo] could not start:", err && err.stack ? err.stack : err);
        return null;
      });
  }
  return loading;
}

function reply(res, status, text) {
  try {
    if (res.headersSent) return void res.end();
    res.writeHead(status, HEADERS);
    res.end(text);
  } catch {}
}

module.exports = function planizo(req, res) {
  start()
    .then((handle) => (handle ? handle(req, res) : reply(res, 503, "Planizo is unavailable\n")))
    .catch((err) => {
      console.error("[planizo]", err && err.stack ? err.stack : err);
      reply(res, 500, "Server error\n");
    });
};
