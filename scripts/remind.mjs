#!/usr/bin/env node
// CLI over claude-adhd custom reminders (user-authored messages that
// surface in Claude Code while working).
//
// Usage:
//   remind.mjs add "<message>" --at <ISO datetime>   # once, at a time
//   remind.mjs add "<message>" --in <2h|30m|1d>      # once, relative
//   remind.mjs add "<message>" --every session|day   # recurring
//   remind.mjs add "<message>" --random              # occasional pop
//   remind.mjs list [--all]                          # active (or all)
//   remind.mjs done <id>                             # mark handled
//   remind.mjs delete <id>                           # remove forever
//
// Optional: --project <name> scopes a reminder to one project.
// The model converts natural language ("tomorrow 3pm") to these flags.
//
// Env overrides (for tests): ADHD_DIR.

import { loadReminders, addReminder, reminderAction } from './lib/store.mjs';

const [cmd, ...rest] = process.argv.slice(2);

const usage = () => {
  console.error(
    'usage: remind.mjs add "<message>" (--at <ISO> | --in <Nd|Nh|Nm> | --every session|day | --random) [--project <name>]\n' +
    '       remind.mjs list [--all] | done <id> | delete <id>'
  );
  process.exit(1);
};

const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

// "2h" / "30m" / "1d" / "10s" -> ms
function parseRelative(v) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(v || '').trim());
  if (!m) return null;
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(m[1]) * mult[m[2]];
}

if (!cmd) usage();

if (cmd === 'add') {
  const message = rest.find((a) => !a.startsWith('--'));
  if (!message) usage();
  const at = flag('at');
  const rel = flag('in');
  const every = flag('every');
  const isRandom = rest.includes('--random');
  const project = flag('project') || null;

  const modes = [at, rel, every, isRandom].filter(Boolean).length;
  if (modes !== 1) usage();

  let kind, dueAt = null;
  if (at || rel) {
    kind = 'once';
    if (at) {
      dueAt = new Date(at).getTime();
      if (Number.isNaN(dueAt)) {
        console.error(`unparseable --at value: ${at}`);
        process.exit(1);
      }
    } else {
      const ms = parseRelative(rel);
      if (ms === null) {
        console.error(`unparseable --in value: ${rel} (use e.g. 30m, 2h, 1d)`);
        process.exit(1);
      }
      dueAt = Date.now() + ms;
    }
  } else if (every) {
    if (!['session', 'day'].includes(every)) usage();
    kind = 'recurring';
  } else {
    kind = 'random';
  }

  const r = addReminder({ message, kind, dueAt, every: every || null, project });
  if (!r) {
    console.error('empty or invalid message');
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    id: r.id,
    kind: r.kind,
    dueAt: r.dueAt,
    every: r.every,
    project: r.project,
    message: r.message,
  }));
} else if (cmd === 'list') {
  const all = rest.includes('--all');
  const items = all ? loadReminders() : loadReminders().filter((r) => !r.done);
  console.log(JSON.stringify({ items }, null, 2));
} else if (cmd === 'done' || cmd === 'delete') {
  const id = rest.find((a) => !a.startsWith('--'));
  if (!id) usage();
  if (!reminderAction(id, cmd)) {
    console.error(`no reminder with id ${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, id, action: cmd }));
} else {
  usage();
}
