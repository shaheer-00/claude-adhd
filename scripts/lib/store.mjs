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
export function digestItems(items, config, now = Date.now(), limit = 3) {
  return eligibleItems(items, config, now)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .slice(0, limit);
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
export function addItem(idx, { summary, project, source = 'capture', sessionPath = null, now = Date.now() }) {
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

// Edit an item's summary (dashboard inline edit).
export function updateItem(idx, id, { summary }, now = Date.now()) {
  const it = idx.items.find((i) => i.id === id);
  if (!it) return false;
  const clean = String(summary).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!clean) return false;
  it.summary = clean;
  it.editedAt = now;
  saveIndex(idx);
  return true;
}

// ---------- per-session nudge state ----------

function stateFile() {
  return path.join(adhdDir(), 'state.json');
}

export function sessionNudges(sessionId) {
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
