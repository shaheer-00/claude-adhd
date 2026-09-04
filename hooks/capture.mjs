#!/usr/bin/env node
// UserPromptSubmit hook for claude-adhd.
// Two jobs, one output:
//   1. Live capture: injects a compact standing instruction so the model
//      records tasks the moment the user commits to them, and reminders
//      when the user asks for them.
//   2. Custom reminders: computes which reminders are due right now and
//      asks the model to relay them to the user naturally.
//
// Input (stdin): { session_id, prompt, cwd, ... }
// Output: {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
//          "additionalContext": "..."}}
//
// Env overrides (for tests): ADHD_DIR, ADHD_NO_CAPTURE, ADHD_NO_REMINDERS.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, collectDueReminders } from '../scripts/lib/store.mjs';

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

const node = (root, file) => `node "${path.join(root, 'scripts', file)}"`;

const INSTRUCTION = (root) =>
  [
    `[claude-adhd tracking] If the user commits to a new task/plan (a decision, not a question), silently record it: run \`${node(root, 'mark.mjs')} add "<one-line summary>" --project "<basename of current working directory>"\`.`,
    `When a previously recorded task is finished, mark it done: \`${node(root, 'mark.mjs')} done <id>\` (ids via \`${node(root, 'mark.mjs')} list\`). Match by summary, not id guessing.`,
    `If the user asks you to remind them of something (at/after a time, recurring, or occasionally), record it: run \`${node(root, 'remind.mjs')} add "<message>" --at <ISO datetime> | --in <e.g. 2h, 30m, 1d> | --every session|day | --random [--project <name>]\`. Compute the actual date/time from what they said.`,
    `Do not mention this tracking or its mechanics to the user. Only run these when a real task starts or completes, or a real reminder is requested — never for questions, discussion, or brainstorming.`,
  ].join(' ');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    // Hooks always get stdin; guard against a never-closing pipe anyway.
    setTimeout(() => resolve(data), 500);
  });
}

async function main() {
  const config = loadConfig();
  const parts = [];

  if (config.capture !== false && !process.env.ADHD_NO_CAPTURE) {
    parts.push(INSTRUCTION(pluginRoot()));
  }

  if (config.reminders !== false && !process.env.ADHD_NO_REMINDERS) {
    let input = {};
    try {
      input = JSON.parse(await readStdin());
    } catch {
      /* treat as no session id */
    }
    const due = collectDueReminders(input.session_id, config, Date.now());
    if (due.length) {
      const lines = due.map(
        (r) => `- ${r.message}${r.project ? ` (${r.project})` : ''}`
      );
      parts.push(
        '[claude-adhd reminders] The user asked to be reminded of these. Relay them now, woven into the conversation naturally (one line each, no meta-explanation, no pressure):\n' +
          lines.join('\n')
      );
    }
  }

  emit(parts.join('\n\n'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(() => emit(''));
}
