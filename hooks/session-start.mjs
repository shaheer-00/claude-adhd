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
} from '../scripts/lib/store.mjs';

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

  const lines = items.map(
    (it) => `- (${humanAge(it.timestamp, now)}) ${it.summary}`
  );

  const additionalContext = [
    '[claude-adhd] Open threads from past sessions (user may have ADHD; these may be forgotten):',
    ...lines,
    'Guidance: mention at most briefly, only if the user seems unsure what to do next or says they are bored/looking for something. One line each, no lecturing, no pressure. Never list all of them unprompted.',
  ].join('\n');

  emit(additionalContext);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(() => emit(''));
}
