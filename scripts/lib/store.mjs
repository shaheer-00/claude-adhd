// Shared store for the claude-adhd plugin.
// All state lives under <adhdDir> (default ~/.claude/adhd).
// Reads tolerate missing/corrupt files (start fresh); writes are atomic.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

export function adhdDir() {
  return process.env.ADHD_DIR || path.join(os.homedir(), '.claude', 'adhd');
}

export function projectsDir() {
  return process.env.ADHD_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

export const DEFAULT_CONFIG = {
  reminderProbability: 0.1,
  cooldownDays: 3,
  maxNudgesPerSession: 2,
  digestOnStart: true,
  maxSessionsIndexed: 50,
  maxItemAgeDays: 90,
  randomReminderProbability: 0.15,
};

export function loadConfig() {
  const file = path.join(adhdDir(), 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- index (extracted items) ----------

export function loadIndex() {
  const idx = readJson(path.join(adhdDir(), 'index.json'), { items: [], sessions: {} });
  if (!Array.isArray(idx.items)) idx.items = [];
  if (!idx.sessions || typeof idx.sessions !== 'object') idx.sessions = {};
  return idx;
}

export function saveIndex(idx) {
  writeJsonAtomic(path.join(adhdDir(), 'index.json'), idx);
}

export function itemId(summary, sessionPath) {
  return crypto.createHash('sha1').update(`${summary}::${sessionPath}`).digest('hex').slice(0, 16);
}

// Items eligible for reminders: open, older than cooldown since last nudge,
// not too old to matter.
export function eligibleItems(items, config, now = Date.now()) {
  return items.filter((it) => {
    if (it.status !== 'open') return false;
    if (it.lastReminded && now - it.lastReminded < config.cooldownDays * DAY_MS) return false;
    if (now - (it.timestamp || 0) > config.maxItemAgeDays * DAY_MS) return false;
    return true;
  });
}

export function openItems(items, config, now = Date.now()) {
  return items.filter(
    (it) =>
      it.status === 'open' &&
      now - (it.timestamp || 0) <= config.maxItemAgeDays * DAY_MS
  );
}

// Most stale first (oldest timestamp at top) for the session digest.
// When a current project is known, prefer its threads (a digest about
// some other project is noise); fall back to everything if it has none.
export function digestItems(items, config, now = Date.now(), limit = 3, project = null) {
  const sorted = eligibleItems(items, config, now).sort(
    (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
  );
  if (project) {
    const mine = sorted.filter((i) => itemProject(i) === project);
    if (mine.length) return mine.slice(0, limit);
  }
  return sorted.slice(0, limit);
}

export function markReminded(idx, id, now = Date.now()) {
  const it = idx.items.find((i) => i.id === id);
  if (it) it.lastReminded = now;
  saveIndex(idx);
}

// Project name for an item. Captured items carry an explicit project;
// transcript-derived ones get it from the munged projects dir name
// (e.g. "F--Claude-vibeXcode-Skills-ADHD" -> "ADHD").
export function itemProject(it) {
  if (it.project) return it.project;
  if (!it.sessionPath) return 'unknown';
  const dir = path.basename(path.dirname(it.sessionPath));
  const parts = dir.split('-');
  return parts[parts.length - 1] || dir;
}

// Record a new tracked task (live capture by the model, or the dashboard).
export function addItem(idx, { summary, project, source = 'capture', sessionPath = null, energy = null, now = Date.now() }) {
  const clean = String(summary).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!clean) return null;
  const id = itemId(clean, sessionPath || project || 'capture');
  if (idx.items.some((i) => i.id === id)) return null; // duplicate
  const item = {
    id,
    summary: clean,
    project: project || 'unknown',
    source,
    sessionPath,
    sessionKey: sessionPath,
    sessionTs: now,
    timestamp: now,
    status: 'open',
    lastReminded: null,
    origin: 'capture',
    energy: ['low', 'high'].includes(energy) ? energy : null,
  };
  idx.items.push(item);
  saveIndex(idx);
  return item;
}

export function markStatus(idx, id, status, now = Date.now()) {
  const it = idx.items.find((i) => i.id === id);
  if (!it) return false;
  it.status = status;
  it.statusChangedAt = now;
  saveIndex(idx);
  return true;
}

// Edit an item's summary and/or energy (dashboard inline edit).
export function updateItem(idx, id, { summary, energy }, now = Date.now()) {
  const it = idx.items.find((i) => i.id === id);
  if (!it) return false;
  if (summary !== undefined) {
    const clean = String(summary).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return false;
    it.summary = clean;
  }
  if (energy !== undefined) {
    if (!['low', 'high', null].includes(energy)) return false;
    it.energy = energy;
  }
  it.editedAt = now;
  saveIndex(idx);
  return true;
}

// ---------- per-session nudge state ----------

function stateFile() {
  return path.join(adhdDir(), 'state.json');
}export function sessionNudges(sessionId) {
  const st = readJson(stateFile(), {});
  const key = sessionId || 'unknown';
  return { ...st, key, count: Number(st[key]?.count || 0) };
}

export function bumpSessionNudges(sessionId, now = Date.now()) {
  const st = readJson(stateFile(), {});
  const key = sessionId || 'unknown';
  const entry = st[key] || { count: 0 };
  entry.count += 1;
  entry.updated = now;
  st[key] = entry;
  // Prune stale session keys (older than 2 days).
  for (const k of Object.keys(st)) {
    if (st[k].updated && now - st[k].updated > 2 * DAY_MS) delete st[k];
  }
  writeJsonAtomic(stateFile(), st);
}

export function humanAge(ts, now = Date.now()) {
  const days = Math.max(0, Math.round((now - ts) / DAY_MS));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

export function formatDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// ---------- reminders (custom, user-authored) ----------

function remindersFile() {
  return path.join(adhdDir(), 'reminders.json');
}

export function loadReminders() {
  const list = readJson(remindersFile(), []);
  return Array.isArray(list) ? list : [];
}

export function saveReminders(list) {
  writeJsonAtomic(remindersFile(), list);
}

export function addReminder(
  { message, kind = 'once', dueAt = null, every = null, project = null, now = Date.now() }
) {
  const clean = String(message).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return null;
  if (!['once', 'recurring', 'random'].includes(kind)) return null;
  const r = {
    id: crypto.createHash('sha1').update(`${clean}::${now}`).digest('hex').slice(0, 16),
    message: clean,
    kind, // once | recurring | random
    dueAt: kind === 'once' ? Number(dueAt) || null : null,
    every, // session | day (recurring only)
    project,
    lastShown: null,
    lastSession: null,
    done: false,
    doneAt: null,
    createdAt: now,
  };
  const list = loadReminders();
  list.push(r);
  saveReminders(list);
  return r;
}

// done | delete
export function reminderAction(id, action, now = Date.now()) {
  const list = loadReminders();
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return false;
  if (action === 'delete') list.splice(i, 1);
  else if (action === 'done') {
    list[i].done = true;
    list[i].doneAt = now;
  } else return false;
  saveReminders(list);
  return true;
}

// Reminders due right now. Mutates shown-state (once: auto-done on fire;
// recurring/random: cooldown stamps) and persists when anything fired.
export function collectDueReminders(sessionId, config = {}, now = Date.now(), opts = {}) {
  const list = loadReminders();
  const randomP = config.randomReminderProbability ?? 0.15;
  const due = [];
  for (const r of list) {
    if (r.done) continue;
    let fire = false;
    if (r.kind === 'once') {
      if (r.dueAt && now >= r.dueAt) {
        fire = true;
        r.done = true;
        r.doneAt = now;
      }
    } else if (r.kind === 'recurring' && r.every === 'session') {
      if (r.lastSession !== sessionId) {
        fire = true;
        r.lastSession = sessionId;
      }
    } else if (r.kind === 'recurring' && r.every === 'day') {
      if (!r.lastShown || now - r.lastShown >= DAY_MS) {
        fire = true;
        r.lastShown = now;
      }
    } else if (r.kind === 'random') {
      const cooled = !r.lastShown || now - r.lastShown >= DAY_MS;
      if (cooled && (opts.forceRandom || Math.random() < randomP)) {
        fire = true;
        r.lastShown = now;
      }
    }
    if (fire) due.push(r);
  }
  if (due.length) saveReminders(list);
  return due;
}

// ---------- focus mode ----------

function focusFile() {
  return path.join(adhdDir(), 'focus.json');
}

export function loadFocus() {
  return readJson(focusFile(), { active: false });
}

export function saveFocus(f) {
  writeJsonAtomic(focusFile(), f);
}

export function startFocus(minutes, label = null, now = Date.now()) {
  const mins = Math.max(1, Math.min(240, Number(minutes) || 25));
  const f = {
    active: true,
    startedAt: now,
    activeUntil: now + mins * 60_000,
    label: label ? String(label).slice(0, 200) : null,
    wrappedUp: false,
  };
  saveFocus(f);
  return f;
}

export function stopFocus() {
  saveFocus({ active: false, endedAt: Date.now() });
}

// Current focus phase: 'off' | 'active' | 'ended' (just expired, wrap-up
// pending — returned exactly once, then marked wrapped up).
export function focusPhase(now = Date.now()) {
  const f = loadFocus();
  if (!f.active || !f.activeUntil) return { phase: 'off' };
  if (now < f.activeUntil) {
    return { ...f, phase: 'active', remainingMs: f.activeUntil - now };
  }
  if (f.wrappedUp) return { phase: 'off' };
  f.wrappedUp = true;
  saveFocus(f);
  return { ...f, phase: 'ended' };
}

// ---------- streaks + aging ----------

// Consecutive days (ending today or yesterday) with at least one item done.
export function doneStreak(items, now = Date.now()) {
  const days = new Set(
    items
      .filter((i) => i.status === 'done' && i.statusChangedAt)
      .map((i) => new Date(i.statusChangedAt).toDateString())
  );
  const d = new Date(now);
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (days.has(d.toDateString())) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

export function itemAgeDays(ts, now = Date.now()) {
  return Math.floor((now - (ts || 0)) / DAY_MS);
}

export const AGING_DAYS = 14;
