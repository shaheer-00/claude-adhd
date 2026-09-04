#!/usr/bin/env node
// Small CLI over the claude-adhd store, used by the remind-me skill.
//
// Usage:
//   node mark.mjs list                 # list open items (JSON)
//   node mark.mjs list --all           # include done/dismissed
//   node mark.mjs done <id>            # mark item done
//   node mark.mjs dismiss <id>         # permanently dismiss item
//   node mark.mjs open <id>            # reopen item
//   node mark.mjs reindex              # run the indexer now
//
// Env overrides (for tests): ADHD_DIR, ADHD_PROJECTS_DIR.

import { loadIndex, markStatus } from './lib/store.mjs';
import { runIndex } from './indexer.mjs';

const [cmd, id] = process.argv.slice(2);

const usage = () => {
  console.error('usage: mark.mjs list [--all] | done|dismiss|open <id> | reindex');
  process.exit(1);
};

if (!cmd) usage();

if (cmd === 'list') {
  const all = process.argv.includes('--all');
  const idx = loadIndex();
  const items = all ? idx.items : idx.items.filter((i) => i.status === 'open');
  console.log(JSON.stringify({ items }, null, 2));
} else if (cmd === 'reindex') {
  console.log(JSON.stringify(runIndex(false)));
} else if (cmd === 'done' || cmd === 'dismiss' || cmd === 'open') {
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
