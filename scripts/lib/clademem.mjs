// Read-only adapter over claude-mem's SQLite database (~/.claude-mem/claude-mem.db).
// Optional integration: everything degrades gracefully when claude-mem
// isn't installed or the db isn't readable.
//
// Uses Node's built-in node:sqlite (Node >= 22.5). Never writes.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export function claudeMemDbPath() {
  return process.env.CLAUDE_MEM_DB || path.join(os.homedir(), '.claude-mem', 'claude-mem.db');
}

const trim = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

// Parse next_steps/completed free text into bullet-ish lines.
function splitLines(text, maxLen = 240) {
  if (!text) return [];
  return text
    .split(/\n+|(?<=\.) (?=[A-Z-])|; (?=[a-z])/)
    .map((l) => trim(l).replace(/^[-•*]\s*/, ''))
    .filter((l) => l.length > 8)
    .slice(0, 8)
    .map((l) => (l.length > maxLen ? l.slice(0, maxLen - 1) + '…' : l));
}

export async function readClaudeMem() {
  const dbPath = claudeMemDbPath();
  if (!fs.existsSync(dbPath)) return { available: false, reason: 'no db', projects: [] };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return { available: false, reason: 'node:sqlite unavailable', projects: [] };
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return { available: false, reason: `db open failed: ${e.message}`, projects: [] };
  }

  try {
    // Latest summary row per project (window function; fallback to grouping in JS
    // if the installed sqlite lacks window functions).
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT project, request, completed, next_steps, created_at, created_at_epoch
           FROM session_summaries
           WHERE id IN (SELECT MAX(id) FROM session_summaries GROUP BY project)
           ORDER BY created_at_epoch DESC`
        )
        .all();
    } catch {
      const all = db
        .prepare(
          `SELECT project, request, completed, next_steps, created_at, created_at_epoch
           FROM session_summaries ORDER BY created_at_epoch DESC`
        )
        .all();
      const seen = new Set();
      rows = [];
      for (const r of all) {
        if (seen.has(r.project)) continue;
        seen.add(r.project);
        rows.push(r);
      }
    }

    const stats = db
      .prepare(
        `SELECT project,
                COUNT(*) sessions,
                SUM(CASE WHEN completed IS NOT NULL AND TRIM(completed) != '' THEN 1 ELSE 0 END) completedRows,
                SUM(CASE WHEN next_steps IS NOT NULL AND TRIM(next_steps) != '' THEN 1 ELSE 0 END) nextRows,
                MAX(created_at_epoch) lastActive
         FROM session_summaries GROUP BY project ORDER BY lastActive DESC`
      )
      .all();

    const projects = stats.map((s) => {
      const latest = rows.find((r) => r.project === s.project);
      return {
        name: s.project,
        sessions: s.sessions,
        lastActive: s.lastActive || 0,
        completedCount: s.completedRows || 0,
        openCount: s.nextRows || 0,
        latestRequest: trim(latest?.request || '').slice(0, 240),
        latestNextSteps: splitLines(latest?.next_steps),
        latestCompleted: splitLines(latest?.completed),
      };
    });

    return { available: true, projects };
  } catch (e) {
    return { available: false, reason: `query failed: ${e.message}`, projects: [] };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
