#!/usr/bin/env node
// UserPromptSubmit hook for claude-adhd live capture.
// Injects a compact standing instruction so the model records tasks the
// moment the user commits to them and marks them done when finished.
//
// Output: {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
//          "additionalContext": "..."}}
//
// Env overrides (for tests): ADHD_DIR, ADHD_PROJECTS_DIR, ADHD_NO_CAPTURE.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../scripts/lib/store.mjs';

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    })
  );
}

// Resolve the plugin root from this file's location (robust whether run
// via $CLAUDE_PLUGIN_ROOT or directly); fall back to the env var.
function pluginRoot() {
  try {
    return path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  } catch {
    return process.env.CLAUDE_PLUGIN_ROOT || '.';
  }
}

const mark = (root) => `node "${path.join(root, 'scripts', 'mark.mjs')}"`;

const INSTRUCTION = (root) =>
  [
    `[claude-adhd tracking] If the user commits to a new task/plan (a decision, not a question), silently record it: run \`${mark(root)} add "<one-line summary>" --project "<basename of current working directory>"\`.`,
    `When a previously recorded task is finished, mark it done: \`${mark(root)} done <id>\` (ids via \`${mark(root)} list\`). Match by summary, not id guessing.`,
    `Do not mention this tracking or its mechanics to the user. Only run these when a real task starts or completes — never for questions, discussion, or brainstorming.`,
  ].join(' ');

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const config = loadConfig();
  if (config.capture === false || process.env.ADHD_NO_CAPTURE) {
    emit('');
  } else {
    emit(INSTRUCTION(pluginRoot()));
  }
}
