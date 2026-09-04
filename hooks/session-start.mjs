#!/usr/bin/env node
// SessionStart hook for the claude-adhd plugin.
// Runs the indexer, then emits a brief digest of the most-stale open
// threads from past sessions as additional context.
//
// Input (stdin): { session_id, source, ... }
// Output: {"hookSpecificOutput": {"hookEventName": "SessionStart",
//          "additionalContext": "..."}}
//
// Env overrides (for tests): ADHD_DIR, ADHD_PROJECTS_DIR, ADHD_FORCE_DIGEST.

import { runIndex } from '../scripts/indexer.mjs';
import {
  loadConfig,
  loadIndex,
  saveIndex,
  digestItems,
  markReminded,
  humanAge,
  itemAgeDays,
  AGING_DAYS,
} from '../scripts/lib/store.mjs';

// Start the dashboard server (detached) if it isn't already running.
// Fire-and-forget: never blocks session start, never fails the hook.
async function ensureDashboard(config) {
  if (config.dashboard === false) return;
  const port = config.dashboardPort || 37987;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) return; // already up
  } catch {
    /* not running — start it */
  }
  try {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const server = fileURLToPath(new URL('../scripts/server.mjs', import.meta.url));
    const child = spawn(process.execPath, [server], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* dashboard is optional; ignore failures */
  }
}

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    })
  );
}

async function main() {
  const config = loadConfig();

  ensureDashboard(config); // fire-and-forget, never awaited

  if (!config.digestOnStart && !process.env.ADHD_FORCE_DIGEST) {
    emit('');
    return;
  }

  let stats;
  try {
    stats = runIndex();
  } catch (e) {
    emit('');
    return;
  }

  const idx = loadIndex();
  const now = Date.now();
  const items = digestItems(idx.items, config, now, 3);

  if (items.length === 0) {
    emit('');
    return;
  }

  // The digest counts as a reminder — start the cooldown clock so the
  // prompt-submit nudges don't immediately repeat the same items.
  for (const it of items) markReminded(idx, it.id, now);

  // Wrap-up: what finished since the previous session (last 36h keeps it
  // to "since you were last here" without reaching back days).
  const recentDone = idx.items.filter(
    (i) => i.status === 'done' && i.statusChangedAt && now - i.statusChangedAt < 36 * 60 * 60 * 1000
  );
  const wrapLine = recentDone.length
    ? `Since your last visit: ${recentDone.length} task${recentDone.length > 1 ? 's' : ''} finished.`
    : '';

  const lines = items.map((it) => {
    const old = itemAgeDays(it.timestamp, now) >= AGING_DAYS;
    return `- (${old ? 'aging, ' : ''}${humanAge(it.timestamp, now)}) ${it.summary}`;
  });

  const additionalContext = [
    '[claude-adhd] Open threads from past sessions (user may have ADHD; these may be forgotten):',
    ...lines,
    wrapLine,
    'Guidance: mention at most briefly, only if the user seems unsure what to do next or says they are bored/looking for something. One line each, no lecturing, no pressure. Never list all of them unprompted.',
  ]
    .filter(Boolean)
    .join('\n');

  emit(additionalContext);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(() => emit(''));
}
