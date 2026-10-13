import { dateKey, eachDay, localToMs, msToLocal, startOfDay, withTime } from "./dates.js";
import { floorDiv, mod, pyWeekday, shift, sorted, truthy, wallDiffMs, wallDiffSeconds } from "../py.js";

const FLOAT_ITEM = Symbol("float");

function isWeekdayValue(d) {
  return (typeof d === "boolean" || Number.isInteger(d)) && 0 <= d && d <= 6;
}

function hasWeekday(list, weekday) {
  return list.some((d) => Number(d) === weekday);
}

function get(obj, key, fallback = null) {
  return obj !== null && obj !== undefined && Object.hasOwn(obj, key) ? obj[key] : fallback;
}

export function parseWeekdays(value) {
  if (Array.isArray(value)) return value.filter(isWeekdayValue);
  if (!truthy(value)) return [];
  if (typeof value !== "string" && !Buffer.isBuffer(value)) return [];
  try {
    const parsed = JSON.parse(String(value), (key, item, context) => (typeof item === "number" && context?.source && /[.eE]/.test(context.source) ? FLOAT_ITEM : item));
    return Array.isArray(parsed) ? parsed.filter(isWeekdayValue) : [];
  } catch {
    return [];
  }
}

export function jsWeekday(d) {
  return (pyWeekday(d) + 1) % 7;
}

function occurrencePriority(occ) {
  const rule = get(occ, "recurrenceRule");
  if (!truthy(rule)) return 4;
  return rule.frequency === "daily" ? 1 : 3;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

export function wholeDay(start, end) {
  return end > start && start.getTime() === startOfDay(start).getTime() && end.getTime() === startOfDay(end).getTime();
}

export function dayPieces(start, end) {
  const firstFullDay = start.getTime() === startOfDay(start).getTime() ? start : shift(startOfDay(start), { days: 1 });
  if (shift(firstFullDay, { days: 1 }) > end) return [[start, end]];
  const pieces = [];
  let cursor = start;
  while (cursor < end) {
    const midnight = shift(startOfDay(cursor), { days: 1 });
    pieces.push([cursor, end < midnight ? end : midnight]);
    cursor = midnight;
  }
  return pieces;
}

export function occursOn(rule, templateStart, day) {
  const anchor = startOfDay(get(rule, "startDate") ? rule.startDate : templateStart);
  const current = startOfDay(day);
  if (current < anchor) return false;
  if (get(rule, "endDate") && current > startOfDay(rule.endDate)) return false;
  const diffDays = floorDiv(wallDiffMs(current, anchor), 86400000);
  const interval = Math.max(get(rule, "interval", 1), 1);
  if (rule.frequency === "daily") return mod(diffDays, interval) === 0;
  const ruleWeekdays = parseWeekdays(get(rule, "weekdays"));
  const allowed = ruleWeekdays.length ? ruleWeekdays : [jsWeekday(templateStart)];
  const weekIndex = floorDiv(diffDays, 7);
  if (rule.frequency === "weekly") return hasWeekday(allowed, jsWeekday(current)) && mod(weekIndex, interval) === 0;
  const weekdays = ruleWeekdays.length ? ruleWeekdays : [1, 2, 3, 4, 5];
  return hasWeekday(weekdays, jsWeekday(current)) && mod(weekIndex, interval) === 0;
}

function completionForDate(completions, key) {
  if (!truthy(completions)) return false;
  return completions.some((c) => dateKey(c.date) === key && truthy(get(c, "completed")));
}

export function serializeRule(rule) {
  if (!truthy(rule)) return null;
  return {
    frequency: rule.frequency,
    interval: get(rule, "interval", 1),
    weekdays: parseWeekdays(get(rule, "weekdays")),
    startDate: get(rule, "startDate"),
    endDate: get(rule, "endDate"),
  };
}

function checklistFor(event, key) {
  const items = sorted(get(event, "checklistItems", []), (i) => get(i, "order", 0));
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    order: get(item, "order", 0),
    completed: completionForDate(get(item, "completions"), key),
  }));
}

function resolveEventOverlaps(occurrences) {
  const byDate = new Map();
  for (const occ of occurrences) {
    if (!byDate.has(occ.dateKey)) byDate.set(occ.dateKey, []);
    byDate.get(occ.dateKey).push(occ);
  }

  const resolved = [];
  for (const items of byDate.values()) {
    const blockers = [];
    const ordered = sorted(items, (o) => [-occurrencePriority(o), o.startAt]);
    for (const item of ordered) {
      if (!truthy(item.isRecurring) && wholeDay(item.startAt, item.endAt)) {
        const occ = { ...item };
        occ.occurrenceId = `${item.occurrenceId}:0`;
        occ.fullStartAt = get(item, "fullStartAt", item.startAt);
        occ.fullEndAt = get(item, "fullEndAt", item.endAt);
        resolved.push(occ);
        continue;
      }
      let segments = [[item.startAt, item.endAt]];
      for (const blocker of blockers) {
        if (occurrencePriority(blocker) < occurrencePriority(item)) continue;
        const bStart = blocker.startAt;
        const bEnd = blocker.endAt;
        const nextSegments = [];
        for (const [sStart, sEnd] of segments) {
          if (!rangesOverlap(sStart, sEnd, bStart, bEnd)) {
            nextSegments.push([sStart, sEnd]);
            continue;
          }
          if (sStart < bStart) nextSegments.push([sStart, bStart]);
          if (sEnd > bEnd) nextSegments.push([bEnd, sEnd]);
        }
        segments = nextSegments;
      }
      const valid = segments.filter((s) => wallDiffSeconds(s[1], s[0]) >= 5 * 60);
      valid.forEach(([sStart, sEnd], index) => {
        const occ = { ...item };
        occ.occurrenceId = `${item.occurrenceId}:${index}`;
        occ.fullStartAt = get(item, "fullStartAt", item.startAt);
        occ.fullEndAt = get(item, "fullEndAt", item.endAt);
        occ.startAt = sStart;
        occ.endAt = sEnd;
        resolved.push(occ);
        blockers.push(occ);
      });
    }
  }
  return sorted(resolved, (o) => o.startAt);
}

export function expandEvents(events, fromDt, toDt) {
  const days = eachDay(fromDt, toDt);
  const occurrences = [];

  for (const event of events) {
    const startAt = event.startAt;
    const endAt = event.endAt;
    const rule = get(event, "recurrenceRule");
    const eventCompletions = get(event, "eventCompletions", []);
    if (!truthy(rule)) {
      if (!(startAt <= toDt && (endAt > fromDt || startAt >= fromDt))) continue;
      for (const [pieceStart, pieceEnd] of dayPieces(startAt, endAt)) {
        if (!(pieceStart <= toDt && (pieceEnd > fromDt || pieceStart >= fromDt))) continue;
        const key = dateKey(pieceStart);
        occurrences.push({
          occurrenceId: `${event.id}:${key}`,
          sourceEventId: event.id,
          dateKey: key,
          title: event.title,
          notes: get(event, "notes"),
          color: get(event, "color"),
          startAt: pieceStart,
          endAt: pieceEnd,
          fullStartAt: startAt,
          fullEndAt: endAt,
          isRecurring: false,
          recurrenceRule: null,
          checklistItems: checklistFor(event, key),
          eventCompleted: completionForDate(eventCompletions, key),
        });
      }
      continue;
    }

    const durationMs = Math.max(localToMs(endAt) - localToMs(startAt), 0);
    const ruleStart = get(rule, "startDate");
    const ruleEnd = get(rule, "endDate");
    const isDayOverride = ruleStart !== null && ruleEnd !== null && startOfDay(ruleStart).getTime() === startOfDay(ruleEnd).getTime();
    for (const day of days) {
      if (!occursOn(rule, startAt, day)) continue;
      const key = dateKey(day);
      const occStart = withTime(day, startAt);
      const occEnd = msToLocal(localToMs(occStart) + durationMs);
      occurrences.push({
        occurrenceId: `${event.id}:${key}`,
        sourceEventId: event.id,
        dateKey: key,
        title: event.title,
        notes: get(event, "notes"),
        color: get(event, "color"),
        startAt: occStart,
        endAt: occEnd,
        isRecurring: true,
        isDayOverride,
        recurrenceRule: serializeRule(rule),
        checklistItems: checklistFor(event, key),
        eventCompleted: completionForDate(eventCompletions, key),
      });
    }
  }

  return resolveEventOverlaps(occurrences);
}

export function expandTasks(tasks, fromDt, toDt) {
  const days = eachDay(fromDt, toDt);
  const occurrences = [];

  const completionFor = (completions, key) => {
    if (!truthy(completions)) return false;
    return completions.some((c) => dateKey(c.date) === key && truthy(get(c, "completed")));
  };

  for (const task of tasks) {
    const rule = get(task, "recurrenceRule");
    if (!truthy(rule)) {
      const due = get(task, "dueDate");
      const dueDay = truthy(due) ? startOfDay(due) : null;
      if (!dueDay || dueDay < startOfDay(fromDt) || dueDay > startOfDay(toDt)) continue;
      const key = dateKey(dueDay);
      const completed = completionFor(get(task, "completions"), key) || get(task, "status") === "done";
      occurrences.push({
        occurrenceId: `${task.id}:${key}`,
        sourceTaskId: task.id,
        dateKey: key,
        title: task.title,
        notes: get(task, "notes"),
        dueDate: dueDay,
        time: get(task, "time"),
        status: completed ? "done" : get(task, "status", "todo"),
        completed,
        isRecurring: false,
        recurrenceRule: null,
      });
      continue;
    }

    const anchor = truthy(get(task, "dueDate")) ? task.dueDate : get(task, "createdAt");
    for (const day of days) {
      if (!occursOn(rule, anchor, day)) continue;
      const key = dateKey(day);
      const completed = completionFor(get(task, "completions"), key);
      occurrences.push({
        occurrenceId: `${task.id}:${key}`,
        sourceTaskId: task.id,
        dateKey: key,
        title: task.title,
        notes: get(task, "notes"),
        dueDate: day,
        time: get(task, "time"),
        status: completed ? "done" : "todo",
        completed,
        isRecurring: true,
        recurrenceRule: serializeRule(rule),
      });
    }
  }

  return sorted(occurrences, (o) => [o.dateKey, truthy(get(o, "time")) ? o.time : "99:99"]);
}
