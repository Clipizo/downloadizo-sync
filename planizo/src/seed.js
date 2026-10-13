import fs from "node:fs";
import path from "node:path";
import { dateKey, startOfDay } from "./core/dates.js";
import { replace, shift } from "./py.js";

const CLIPIZO_THUMBS = "D:\\A-WORK\\CLIPIZO\\website\\Repo\\thumbnails";

function thumb(dataDir, sourceName) {
  const source = path.join(CLIPIZO_THUMBS, sourceName);
  try {
    if (!fs.statSync(source).isFile()) return null;
  } catch {
    return null;
  }
  const folder = path.join(dataDir, "content-thumbnails");
  fs.mkdirSync(folder, { recursive: true });
  const ext = path.extname(sourceName);
  const stem = path.basename(sourceName, ext);
  const target = path.join(folder, `demo-${stem.toLowerCase()}${ext.toLowerCase()}`);
  fs.copyFileSync(source, target);
  return path.basename(target);
}

export function seedDemo(db, userId, dataDir) {
  const today = startOfDay(new Date());
  const anchor = shift(today, { days: -60 });
  const days = (n) => shift(today, { days: n });

  const at = (day, hhmm) => {
    const [h, m] = hhmm.split(":").map((x) => Number(x));
    return replace(day, { hour: h, minute: m });
  };

  const routine = (title, start, end, frequency, weekdays, color, checklist = [], notes = null, day = null) => {
    const base = day || anchor;
    const s = at(base, start);
    let e = at(base, end);
    if (e <= s) e = shift(e, { days: 1 });
    const rule = { frequency, interval: 1, weekdays: [...weekdays], startDate: day, endDate: day };
    const items = checklist.map((t, i) => ({ id: null, title: t, order: i }));
    return db.saveRoutine(userId, null, title, notes, s, e, rule, items, color);
  };

  routine("Morning routine", "07:00", "08:00", "daily", [], "#ffd60a",
    ["Water + stretch", "Review today's plan", "Inbox zero"]);
  routine("Deep work", "09:00", "12:00", "weekly", [1, 2, 3, 4, 5], "#0a84ff",
    ["Script draft", "Edit pass"], "Phone in another room.");
  routine("Lunch", "12:30", "13:30", "daily", [], "#30d158");
  routine("Editing block", "14:00", "17:00", "weekly", [1, 3, 5], "#7b3ff2", ["Rough cut", "Color", "Export"]);
  routine("Admin & email", "14:00", "15:30", "weekly", [2, 4], "#64d2ff", ["Invoices", "Sponsor replies"]);
  routine("Gym", "18:00", "19:00", "weekly", [1, 3, 5], "#ff3b3b", ["Warm-up", "Workout", "Stretch"]);
  routine("Weekly review", "17:00", "18:00", "weekly", [0], "#ff8c1a", ["Review calendar", "Plan next week"]);
  routine("Wind down", "22:30", "23:30", "daily", [], "#ac8c68", ["Journal", "No screens"]);

  const shoot = days(3);
  routine("Shoot day", "10:00", "16:00", "weekly", [shoot.getDay()], "#ff2d92",
    ["Charge batteries", "Pack lights", "Back up footage"], "Studio B, bring the green screen.", shoot);

  const sponsor = db.createEvent(userId, "Sponsor call", "Talk through the Dashizo integration.",
    at(today, "15:30"), at(today, "16:00"));
  db.setEventColor(sponsor, "#ff375f");
  db.createEvent(userId, "Podcast recording", null, at(days(1), "11:00"), at(days(1), "12:00"));
  db.createEvent(userId, "Dinner with Sam", "Table for two at 19:30.", at(days(5), "19:30"), at(days(5), "21:00"));
  const dentist = db.createEvent(userId, "Dentist", null, at(days(-1), "10:00"), at(days(-1), "10:45"));
  db.setEventCompletion(dentist, userId, dateKey(days(-1)), true);

  db.createTask(userId, "Send invoice to sponsor", at(today, "10:00"), "10:00");
  db.createTask(userId, "Reply to Discord feedback", today, null);
  db.createTask(userId, "Upload thumbnail tests", at(days(1), "09:00"), "09:00");
  db.createTask(userId, "Renew domain", days(2), null);

  for (const text of ["Buy SD cards", "Back up project drive", "Call mum"]) db.addDayTodo(userId, dateKey(today), text);
  for (const todo of db.getDayTodos(dateKey(today))) {
    if (todo.text === "Call mum") db.setDayTodoDone(todo.id, true);
  }
  db.addDayTodo(userId, dateKey(days(1)), "Prep podcast questions");

  db.addNote(userId, dateKey(today), "Show how Planizo plans a full week in 30 seconds.", "Video idea");
  db.addNote(userId, dateKey(days(-2)), "Viewers asked for a slower walkthrough of the Merge node.", "Feedback");

  db.createContentItem(userId, "Planizo devlog #3", "upload", "scheduled", dateKey(days(2)));

  const launch = db.createProject(userId, "Planizo web launch video", "", null, "working");
  const stages = db.getStages(launch);
  db.updateStage(stages[0].id, { name: "Research" });
  const research = stages[0].id;
  const script = db.createStage(launch, "Script");
  const edit = db.createStage(launch, "Edit");

  const step = (project, stage, title, done = false, notes = null, subs = []) => {
    const sid = db.createContentItem(userId, title, "step", done ? "done" : "todo", null, notes, project, stage);
    for (const [subTitle, subDone] of subs) {
      db.createContentItem(userId, subTitle, "substep", subDone ? "done" : "todo", null, null, project, stage, sid);
    }
    return sid;
  };

  step(launch, research, "Collect feature list", true);
  step(launch, research, "Look at three competitor launch videos", true, "Keep it under 60 seconds.");
  step(launch, script, "Write the hook", true);
  step(launch, script, "Script the feature walkthrough", false, null,
    [["Today page", true], ["Calendar", true], ["Content Tracker", false]]);
  step(launch, script, "Record voice-over");
  step(launch, edit, "Rough cut");
  step(launch, edit, "Motion graphics in Fusion", false, "Reuse the lime dot reveal.");
  step(launch, edit, "Thumbnail");
  db.updateProject(launch, { description: '[{"id": "a1b2c3d4e5", "text": "Publish on a Tuesday, 17:00 CET."}]' });

  const tutorial = db.createProject(userId, "Exprizo tutorial series", "", thumb(dataDir, "Exprizo-card.jpg"), "idea");
  let general = db.getStages(tutorial)[0].id;
  for (const title of ["Outline five episodes", "Record episode 1", "Edit episode 1"]) step(tutorial, general, title);

  const dashizo = db.createProject(userId, "Dashizo 2.0 release", "", thumb(dataDir, "Dashizo-card.jpg"), "scheduled");
  general = db.getStages(dashizo)[0].id;
  step(dashizo, general, "Changelog", true);
  step(dashizo, general, "Product page update", true);
  step(dashizo, general, "Release trailer");

  const trailer = db.createProject(userId, "Channel trailer", "", thumb(dataDir, "CRTizo-card.jpg"), "done");
  general = db.getStages(trailer)[0].id;
  for (const title of ["Script", "Edit", "Upload"]) step(trailer, general, title, true);

  db.saveStepPreset("YouTube video", ["Research topic", "Write script", "Record", "Edit", "Thumbnail", "Upload"]);
  db.saveRoutinePreset("Gym session", "Gym", "18:00", "19:00", "", [{ title: "Warm-up", order: 0 }, { title: "Workout", order: 1 }]);

  const board = path.join(dataDir, "whiteboard", "projects", `${launch}.cwboard`);
  fs.mkdirSync(path.dirname(board), { recursive: true });
  const payload = {
    version: 2,
    project_name: "Planizo web launch video",
    mode: "canvas",
    view: { zoom: 1.0, center_x: 120, center_y: 40 },
    cards: [
      {
        title: "Hook", kind: "text", x: -260, y: -150, width: 360, height: 220, z: 11,
        item_id: "c0ffee0001", broll_links: [],
        text: "\u201cYour week, planned in one screen.\u201d\n\nOpen on the Today page with the NOW badge.",
      },
      {
        title: "Shot list", kind: "text", x: 180, y: -120, width: 340, height: 260, z: 12,
        item_id: "c0ffee0002", broll_links: [],
        text: "1. Today timeline\n2. Calendar drag and drop\n3. Routines week grid\n4. Content Tracker progress\n5. Botizo creating a routine",
      },
    ],
    annotations: [
      {
        elements: [{ x: 110, y: -40, type: 0 }, { x: 165, y: -40, type: 1 },
          { x: 152, y: -35, type: 0 }, { x: 165, y: -40, type: 1 }, { x: 152, y: -45, type: 1 }],
        pen_color: "#ffbfff00", pen_width: 3.0, brush_color: "#ffbfff00", kind: "arrow", z: 9000,
        tag: "annotation", item_id: "a0a0a0a0a1", broll_links: [],
      },
    ],
    links: [],
    floating_texts: [
      {
        text: "Launch video board", x: -260, y: -230, w: 320, h: 40, font_size: 20, bold: true,
        italic: false, underline: false, color: "#BFFF00",
      },
    ],
    script: {
      version: 2, active_script_id: "s1demo0001", open_script_ids: ["s1demo0001"], scripts: [
        {
          id: "s1demo0001", title: "Script 1", broll_sections: [],
          script_html: "<p>Your week, planned in one screen.</p><p>Planizo shows what is happening now, what is next, and what is due.</p><p>Drag anything on the calendar to move it.</p>",
        },
      ], inactive_brolls: [],
    },
  };
  const text = JSON.stringify(payload, null, 2)
    .replace('"zoom": 1,', '"zoom": 1.0,')
    .replace('"pen_width": 3,', '"pen_width": 3.0,');
  fs.writeFileSync(board, text, "utf-8");
}
