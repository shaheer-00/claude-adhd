#!/usr/bin/env node
// Local dashboard server for the claude-adhd plugin.
// Serves a local-only HTTP dashboard: projects, stats, graphs, and
// interactive actions over the local item index + (optional) claude-mem.
//
// Binds 127.0.0.1 only. No network exposure, no telemetry.
// Started automatically (detached) by the SessionStart hook; safe to
// run manually:  node server.mjs
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

import { loadConfig, loadIndex, markStatus, addItem, itemProject, updateItem, loadReminders, addReminder, reminderAction } from './lib/store.mjs';
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

export function startServer(portOverride) {
  const config = loadConfig();
  const port = Number(portOverride || process.env.ADHD_PORT || config.dashboardPort || 37987);

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
      const body = await readBody(req);
      if (!body?.id || !body?.summary) {
        return send(res, 400, JSON.stringify({ error: 'need id and summary' }));
      }
      const idx = loadIndex();
      if (!updateItem(idx, body.id, { summary: body.summary })) {
        return send(res, 404, JSON.stringify({ error: 'no such item or empty summary' }));
      }
      return send(res, 200, JSON.stringify({ ok: true }));
    }

    if (url === '/api/reminders/add' && req.method === 'POST') {
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
      const body = await readBody(req);
      if (!body?.id) return send(res, 400, JSON.stringify({ error: 'need id' }));
      if (!reminderAction(body.id, 'done')) {
        return send(res, 404, JSON.stringify({ error: 'no such reminder' }));
      }
      return send(res, 200, JSON.stringify({ ok: true }));
    }

    if (url === '/api/reminders/delete' && req.method === 'POST') {
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
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().then(({ port }) => {
    console.log(`claude-adhd dashboard: http://127.0.0.1:${port}`);
  });
}
