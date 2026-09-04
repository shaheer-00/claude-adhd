#!/usr/bin/env node
// Small CLI over the claude-adhd store, used by the remind-me skill,
// the live-capture hook instruction, and the dashboard.
//
// Usage:
//   node mark.mjs list [--all] [--energy low|high]   # list items (JSON)
//   node mark.mjs add "<summary>" [--project <name>] [--energy low|high]
//   node mark.mjs done <id>            # mark item done
//   node mark.mjs dismiss <id>         # permanently dismiss item
//   node mark.mjs open <id>            # reopen item
//   node mark.mjs reindex              # run the indexer now
//
// Env overrides (for tests): ADHD_DIR, ADHD_PROJECTS_DIR.

import path from 'node:path';
import { loadIndex, markStatus, itemProject, addItem } from './lib/store.mjs';
import { runIndex } from './indexer.mjs';

const [cmd, ...rest] = process.argv.slice(2);

const usage = () => {
  console.error('usage: mark.mjs list [--all] | add "<summary>" [--project <name>] | done|dismiss|open <id> | reindex');
  process.exit(1);
};

const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (!cmd) usage();

if (cmd === 'list') {
  const all = rest.includes('--all');
  const energy = flag('energy');
  if (energy && !['low', 'high'].includes(energy)) usage();
  const idx = loadIndex();
  let items = all ? idx.items : idx.items.filter((i) => i.status === 'open');
  if (energy) items = items.filter((i) => i.energy === energy);
  items = items.map((i) => ({ ...i, project: itemProject(i) }));
  console.log(JSON.stringify({ items }, null, 2));
} else if (cmd === 'add') {
  const summary = rest.find((a) => !a.startsWith('--'));
  if (!summary) usage();
  const project = flag('project') || process.cwd().split(/[\\/]/).filter(Boolean).pop() || 'unknown';
  const energy = flag('energy');
  if (energy && !['low', 'high'].includes(energy)) usage();
  const idx = loadIndex();
  const item = addItem(idx, { summary, project, source: 'capture', energy: energy || null });
  if (!item) {
    console.error('duplicate or empty summary');
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, id: item.id, project: item.project, summary: item.summary }));
} else if (cmd === 'reindex') {
  console.log(JSON.stringify(runIndex(false)));
} else if (cmd === 'done' || cmd === 'dismiss' || cmd === 'open') {
  const id = rest.find((a) => !a.startsWith('--'));
  if (!id) usage();
  const status = cmd === 'dismiss' ? 'dismissed' : cmd;
  const idx = loadIndex();
  if (!markStatus(idx, id, status)) {
    console.error(`no item with id ${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, id, status }));
} else {
  usage();
}
