import fs from "node:fs";
import path from "node:path";
import { CalendizoDB } from "./core/db.js";
import * as workMail from "./core/workMail.js";
import * as agent from "./agent.js";
import * as googleSync from "./googleSync.js";
import * as icsIo from "./icsIo.js";
import { register as registerRoutes } from "./routes.js";
import { seedDemo } from "./seed.js";

export async function startApp({ dataDir }) {
  const base = path.resolve(String(dataDir));
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const dbPath = path.join(base, "calendizo.db");
  const fresh = !fs.existsSync(dbPath);
  const state = { db: new CalendizoDB(dbPath), userId: "", dataDir: base };
  state.userId = (state.db.getUser() || {}).id || "";
  if (fresh) {
    seedDemo(state.db, state.userId, base);
    console.log(`[api] Created demo data in ${base}`);
  }

  state.afterRestore = () => {
    if (typeof agent.clearSessions === "function") agent.clearSessions();
    else if (agent.AgentState && agent.AgentState.sessions) agent.AgentState.sessions.clear();
  };

  const { mailState, mailRead, autoBackups } = registerRoutes(state);
  agent.register(() => ({ db: state.db, userId: state.userId, dataDir: state.dataDir, workMail, mailState, mailRead }));
  const googleAutoSync = googleSync.register(() => ({ db: state.db, userId: state.userId, dataDir: state.dataDir, workMail }));
  icsIo.register(() => ({ db: state.db, userId: state.userId }));

  let started = false;
  return {
    state,
    afterListen() {
      if (started) return;
      started = true;
      autoBackups();
      if (typeof googleAutoSync === "function") googleAutoSync();
    },
  };
}
