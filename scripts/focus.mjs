#!/usr/bin/env node
// CLI over claude-adhd focus mode (timed focus sessions with drift
// redirection and wrap-up, driven by the capture hook).
//
// Usage:
//   focus.mjs start [minutes] [task label...]   # default 25
//   focus.mjs status                            # current phase + time left
//   focus.mjs stop                              # end early
//
// Env overrides (for tests): ADHD_DIR.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFocus, stopFocus, loadFocus } from './lib/store.mjs';

const [cmd, ...rest] = process.argv.slice(2);

const usage = () => {
  console.error('usage: focus.mjs start [minutes] [task label...] | status | stop');
  process.exit(1);
};

async function main() {
  if (cmd === 'start') {
    const mins = rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : 25;
    const label = (rest[0] && /^\d+$/.test(rest[0]) ? rest.slice(1) : rest).join(' ') || null;
    const f = await startFocus(mins, label);
    const end = new Date(f.activeUntil).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    console.log(JSON.stringify({ ok: true, minutes: mins, label: f.label, until: f.activeUntil, untilLocal: end }));
  } else if (cmd === 'status') {
    const f = loadFocus();
    const now = Date.now();
    const out = !f.active
      ? { active: false, phase: 'off' }
      : now >= f.activeUntil
        ? { active: true, phase: 'ended', label: f.label }
        : { active: true, phase: 'active', label: f.label, remainingMs: f.activeUntil - now };
    console.log(JSON.stringify(out));
  } else if (cmd === 'stop') {
    await stopFocus();
    console.log(JSON.stringify({ ok: true, stopped: true }));
  } else {
    usage();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
