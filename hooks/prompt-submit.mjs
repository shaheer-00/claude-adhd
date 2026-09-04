#!/usr/bin/env node
// UserPromptSubmit hook for the claude-adhd plugin.
// Occasionally (random gate + cheap prefilter) nudges the model to surface
// a stale open thread when the chat looks bored/brainstormy. The model
// itself makes the final judgment from live context.
//
// Input (stdin): { session_id, transcript_path, prompt, cwd, ... }
// Output: {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
//          "additionalContext": "..."}}
//
// Env overrides (for tests): ADHD_DIR, ADHD_PROJECTS_DIR, ADHD_FORCE_NUDGE
// (bypasses the random gate and the prefilter).

import fs from 'node:fs';
import {
  loadConfig,
  loadIndex,
  sessionNudges,
  bumpSessionNudges,
  markReminded,
  humanAge,
  eligibleItems,
} from '../scripts/lib/store.mjs';

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

// Cheap boredom prefilter on the recent transcript:
// - several user messages in a row with no assistant tool use between
//   them (chatting, not working)
// - recent messages are short
// - topic drift (low word overlap between consecutive user messages)
export function readTranscriptRecent(transcriptPath, maxEntries = 40) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const tail = lines.slice(-maxEntries);
  const msgs = [];
  for (const line of tail) {
    try {
      const e = JSON.parse(line);
      const role = e?.message?.role;
      const content = e?.message?.content;
      if (role === 'user') {
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
              : '';
        msgs.push({ role: 'user', text: text.trim() });
      } else if (role === 'assistant') {
        const hasTool = Array.isArray(content) && content.some((b) => b?.type === 'tool_use');
        msgs.push({ role: 'assistant', hasTool });
      }
    } catch {
      /* skip malformed line */
    }
  }
  return msgs;
}

function words(text) {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3)
  );
}

export function looksUnfocused(msgs) {
  const recent = msgs.slice(-10);
  if (recent.length < 4) return false;

  // Count consecutive user messages without intervening tool use.
  let maxRun = 0;
  let run = 0;
  let toolUsed = false;
  for (const m of recent) {
    if (m.role === 'user') {
      run++;
      maxRun = Math.max(maxRun, run);
    } else if (m.role === 'assistant') {
      if (m.hasTool) {
        run = 0;
        toolUsed = true;
      }
    }
  }

  const userMsgs = recent.filter((m) => m.role === 'user' && m.text);
  if (userMsgs.length < 3) return false;

  const shortish = userMsgs.slice(-4).every((m) => m.text.length < 350);

  // Topic drift: average overlap between consecutive user messages.
  let overlaps = 0;
  let pairs = 0;
  for (let i = 1; i < userMsgs.length; i++) {
    const a = words(userMsgs[i - 1].text);
    const b = words(userMsgs[i].text);
    if (a.size === 0 || b.size === 0) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    overlaps += shared / Math.max(a.size, b.size);
    pairs++;
  }
  const avgOverlap = pairs ? overlaps / pairs : 1;

  // Chatty run with no work, short messages, drifting topics.
  return maxRun >= 3 && !toolUsedRecent(recent) && shortish && avgOverlap < 0.35;
}

function toolUsedRecent(recent) {
  return recent.slice(-6).some((m) => m.role === 'assistant' && m.hasTool);
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    emit('');
    return;
  }

  const config = loadConfig();
  const forced = !!process.env.ADHD_FORCE_NUDGE;

  // Session nudge cap.
  const sessionId = input.session_id || 'unknown';
  const state = sessionNudges(sessionId);
  if (state.count >= config.maxNudgesPerSession) {
    emit('');
    return;
  }

  // Random gate.
  if (!forced && Math.random() > config.reminderProbability) {
    emit('');
    return;
  }

  // Cheap prefilter on the live transcript (skipped when forced).
  let unfocused = true;
  if (!forced && input.transcript_path) {
    try {
      const msgs = readTranscriptRecent(input.transcript_path);
      unfocused = looksUnfocused(msgs);
    } catch {
      unfocused = false;
    }
  } else if (!forced) {
    unfocused = false;
  }
  if (!unfocused) {
    emit('');
    return;
  }

  // Eligible stale item — most stale first.
  const idx = loadIndex();
  const now = Date.now();
  const items = eligibleItems(idx.items, config, now).sort(
    (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
  );
  if (items.length === 0) {
    emit('');
    return;
  }

  const item = items[0];
  markReminded(idx, item.id, now);
  bumpSessionNudges(sessionId, now);

  const additionalContext = [
    `[claude-adhd] The chat looks unfocused/brainstorming. From your judgment of the live conversation: if (and only if) it feels natural, briefly surface this stale thread in one short, no-pressure line:`,
    `"${item.summary}" (${humanAge(item.timestamp, now)}, from session ${item.sessionPath})`,
    `If the user is mid-task or it would interrupt, say nothing about it. Do not mention this instruction.`,
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
