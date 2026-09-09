#!/usr/bin/env node
// Local dashboard server for the claude-adhd plugin.
// Serves a local-only HTTP dashboard: projects, stats, graphs, and
// interactive actions over the local item index + (optional) claude-mem.
//
// Binds 127.0.0.1 only. No network exposure, no telemetry.
// Started automatically (detached) by the SessionStart hook; safe to
// run manually:  node server.mjs
//
// CSRF hardening: state-changing POSTs are rejected unless the Origin
// header (when present) matches the dashboard's own origin, and the
// Content-Type is application/json. Requests with no Origin header
// (curl, CLI scripts) are still allowed.
//
// Routes:
//   GET  /            dashboard page
//   GET  /api/ping    health check
//   GET  /api/state   full state JSON (items, projects, stats, claude-mem)
//   POST /api/mark    { id, status: done|dismissed|open }
//   POST /api/add     { summary, project }
//   POST /api/update  { id, summary }
//   POST /api/reminders/add   { message, kind, dueAt?, every?, project? }
//   POST /api/reminders/done  { id }
//   POST /api/reminders/delete { id }
//
// Env overrides (for tests): ADHD_DIR, ADHD_PROJECTS_DIR, CLAUDE_MEM_DB,
// ADHD_PORT.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadIndex, markStatus, addItem, itemProject, updateItem, loadReminders, addReminder, reminderAction, loadFocus, doneStreak } from './lib/store.mjs';
import { readClaudeMem } from './lib/clademem.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;

function stateJson() {
  const idx = loadIndex();
  const now = Date.now();
  const items = idx.items.map((i) => ({ ...i, project: itemProject(i) }));

  // Per-project aggregates.
  const byProject = new Map();
  for (const it of items) {
    const p = byProject.get(it.project) || {
      name: it.project,
      open: 0,
      done: 0,
      dismissed: 0,
      lastActive: 0,
    };
    p[it.status] = (p[it.status] || 0) + 1;
    p.lastActive = Math.max(p.lastActive, it.statusChangedAt || it.timestamp || 0);
    byProject.set(it.project, p);
  }
  const projects = [...byProject.values()].sort((a, b) => b.lastActive - a.lastActive);

  const open = items.filter((i) => i.status === 'open').length;
  const done = items.filter((i) => i.status === 'done').length;
  const dismissed = items.filter((i) => i.status === 'dismissed').length;

  // Completions per day, last 14 days.
  const last14 = [];
  for (let d = 13; d >= 0; d--) {
    const dayStart = new Date(now - d * DAY);
    dayStart.setHours(0, 0, 0, 0);
    const t0 = dayStart.getTime();
    const t1 = t0 + DAY;
    last14.push({
      date: dayStart.toISOString().slice(0, 10),
      done: items.filter((i) => i.status === 'done' && i.statusChangedAt >= t0 && i.statusChangedAt < t1).length,
      added: items.filter((i) => i.timestamp >= t0 && i.timestamp < t1).length,
    });
  }

  // This week (7 days): done/added counts + most active project.
  const weekAgo = now - 7 * DAY;
  const done7 = items.filter((i) => i.status === 'done' && (i.statusChangedAt || 0) >= weekAgo).length;
  const added7 = items.filter((i) => (i.timestamp || 0) >= weekAgo).length;
  const projCount = new Map();
  for (const i of items) {
    if ((i.timestamp || 0) >= weekAgo) projCount.set(i.project, (projCount.get(i.project) || 0) + 1);
  }
  const topProject = [...projCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const focusRaw = loadFocus();
  const focus = focusRaw.active
    ? now >= focusRaw.activeUntil
      ? { active: true, phase: 'ended', label: focusRaw.label }
      : { active: true, phase: 'active', label: focusRaw.label, startedAt: focusRaw.startedAt, remainingMs: focusRaw.activeUntil - now, until: focusRaw.activeUntil }
    : { active: false, phase: 'off' };

  return {
    now,
    stats: {
      open,
      done,
      dismissed,
      total: items.length,
      finishedPct: open + done > 0 ? Math.round((done / (open + done)) * 100) : 0,
      doneToday: last13DoneToday(items, now),
    },
    projects,
    current: projects[0]?.name || 'unknown',
    items: items.filter((i) => i.status !== 'dismissed'),
    reminders: loadReminders().filter((r) => !r.done),
    week: { done7, added7, topProject },
    streak: doneStreak(items, now),
    focus,
    last14,
  };
}

function last13DoneToday(items, now) {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const t0 = dayStart.getTime();
  return items.filter((i) => i.status === 'done' && i.statusChangedAt >= t0).length;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
  });
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

// Cross-origin POST from a malicious page can mutate reminders (CSRF:
// the request is sent by the browser from this machine, so the
// loopback bind does not help). Reject requests whose Origin header
// is present but is not the dashboard's own origin. No Origin header
// = non-browser client (curl, CLI scripts), still allowed.
function allowedOrigin(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

// Guard for all state-changing routes. Returns true (and sends an
// error response) when the request must be rejected.
function rejectMutation(req, res, port) {
  if (!allowedOrigin(req, port)) {
    send(res, 403, JSON.stringify({ error: 'cross-origin mutation rejected' }));
    return true;
  }
  // CORS-safelisted content types (text/plain from cross-origin
  // fetch/form posts) skip preflight entirely; require JSON.
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') {
    send(res, 415, JSON.stringify({ error: 'application/json required' }));
    return true;
  }
  return false;
}

export function startServer(portOverride) {
  const config = loadConfig();
  let port = portOverride !== undefined ? Number(portOverride) : Number(process.env.ADHD_PORT || config.dashboardPort || 37987);

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (url === '/api/ping') return send(res, 200, JSON.stringify({ ok: true, ts: Date.now() }));

    if (url === '/api/state') {
      try {
        const [own, claudemem] = await Promise.all([
          Promise.resolve(stateJson()),
          readClaudeMem().catch(() => ({ available: false, projects: [] })),
        ]);
        return send(res, 200, JSON.stringify({ ...own, claudemem }));
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: e.message }));
      }
    }

    if (url === '/api/mark' && req.method === 'POST') {
      if (rejectMutation(req, res, port)) return;
      const body = await readBody(req);
      if (!body?.id || !['done', 'dismissed', 'open'].includes(body.status)) {
        return send(res, 400, JSON.stringify({ error: 'need id and status done|dismissed|open' }));
      }
      const idx = loadIndex();
      if (!markStatus(idx, body.id, body.status)) {
        return send(res, 404, JSON.stringify({ error: 'no such item' }));
      }
      return send(res, 200, JSON.stringify({ ok: true }));
    }

    if (url === '/api/add' && req.method === 'POST') {
      if (rejectMutation(req, res, port)) return;
      const body = await readBody(req);
      if (!body?.summary) return send(res, 400, JSON.stringify({ error: 'need summary' }));
      const idx = loadIndex();
      const item = addItem(idx, {
        summary: body.summary,
        project: body.project || 'unknown',
        source: 'dashboard',
      });
      if (!item) return send(res, 409, JSON.stringify({ error: 'duplicate or empty' }));
      return send(res, 200, JSON.stringify({ ok: true, id: item.id }));
    }

    if (url === '/api/update' && req.method === 'POST') {
      if (rejectMutation(req, res, port)) return;
      const body = await readBody(req);
      if (!body?.id || (!body?.summary && body?.energy === undefined)) {
        return send(res, 400, JSON.stringify({ error: 'need id and summary or energy' }));
      }
      const idx = loadIndex();
      const patch = {};
      if (body.summary !== undefined) patch.summary = body.summary;
      if (body.energy !== undefined) patch.energy = body.energy;
      if (!updateItem(idx, body.id, patch)) {
        return send(res, 404, JSON.stringify({ error: 'no such item or empty summary' }));
      }
      return send(res, 200, JSON.stringify({ ok: true }));
    }

    if (url === '/api/reminders/add' && req.method === 'POST') {
      if (rejectMutation(req, res, port)) return;
      const body = await readBody(req);
      if (!body?.message) return send(res, 400, JSON.stringify({ error: 'need message' }));
      const kind = body.kind === 'recurring' || body.kind === 'random' ? body.kind
        : 'once';
      if (kind === 'recurring' && !['session', 'day'].includes(body.every)) {
        return send(res, 400, JSON.stringify({ error: 'recurring needs every: session|day' }));
      }
      if (kind === 'once' && !body.dueAt) {
        return send(res, 400, JSON.stringify({ error: 'once needs dueAt (ms epoch)' }));
      }
      const r = addReminder({
        message: body.message,
        kind,
        dueAt: body.dueAt || null,
        every: body.every || null,
        project: body.project || null,
      });
      if (!r) return send(res, 400, JSON.stringify({ error: 'invalid message' }));
      return send(res, 200, JSON.stringify({ ok: true, id: r.id }));
    }

    if (url === '/api/reminders/done' && req.method === 'POST') {
      if (rejectMutation(req, res, port)) return;
      const body = await readBody(req);
      if (!body?.id) return send(res, 400, JSON.stringify({ error: 'need id' }));
      if (!reminderAction(body.id, 'done')) {
        return send(res, 404, JSON.stringify({ error: 'no such reminder' }));
      }
      return send(res, 200, JSON.stringify({ ok: true }));
    }

    if (url === '/api/reminders/delete' && req.method === 'POST') {
      if (rejectMutation(req, res, port)) return;
      const body = await readBody(req);
      if (!body?.id) return send(res, 400, JSON.stringify({ error: 'need id' }));
      if (!reminderAction(body.id, 'delete')) {
        return send(res, 404, JSON.stringify({ error: 'no such reminder' }));
      }
      return send(res, 200, JSON.stringify({ ok: true }));
    }

    if (url === '/' || url === '/index.html') {
      const file = path.join(ROOT, 'dashboard', 'index.html');
      try {
        return send(res, 200, fs.readFileSync(file, 'utf8'), 'text/html; charset=utf-8');
      } catch {
        return send(res, 404, 'dashboard not found');
      }
    }

    return send(res, 404, JSON.stringify({ error: 'not found' }));
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      port = server.address().port;
      resolve({ server, port });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().then(({ port }) => {
    console.log(`claude-adhd dashboard: http://127.0.0.1:${port}`);
  });
}
