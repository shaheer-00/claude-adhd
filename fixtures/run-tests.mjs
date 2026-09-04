#!/usr/bin/env node
// Test runner for claude-adhd. Uses fixture transcripts and throwaway
// dirs. Run: node fixtures/run-tests.mjs
//
// Covers: indexing, extraction, auto done-detection, digest output,
// unfocused detection, nudge output + cap, mark round-trip.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'fixtures');

// Projects dir with only the project fixtures (drifty/focused transcripts
// are hook test inputs, not sessions to index).
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhd-proj-'));
for (const d of ['old-project-a', 'old-project-b', 'old-project-c']) {
  fs.mkdirSync(path.join(projDir, d), { recursive: true });
  for (const f of fs.readdirSync(path.join(fixtures, d))) {
    fs.copyFileSync(path.join(fixtures, d, f), path.join(projDir, d, f));
  }
}

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

const run = (script, args = [], { dir, input = null, extra = {} } = {}) =>
  spawnSync('node', [path.join(root, script), ...args], {
    input,
    env: { ...process.env, ADHD_DIR: dir, ADHD_PROJECTS_DIR: projDir, ...extra },
    encoding: 'utf8',
  });

// --- 1. indexing + extraction ---
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'adhd-test-'));
const idx = JSON.parse(run('scripts/indexer.mjs', [], { dir: dirA }).stdout);
check('indexer parses 3 sessions', idx.parsed === 3);
check('extracted expected items', idx.totalItems === 6);

const list = JSON.parse(run('scripts/mark.mjs', ['list'], { dir: dirA }).stdout);
const open = list.items;
check('5 open items listed', open.length === 5);
check(
  'auto done-detection fired (auth tests marked done)',
  idx.open === 5 && open.every((i) => i.status === 'open')
);
check('"remind me" task extracted', open.some((i) => /set up CI/.test(i.summary)));
check('"what if we" idea extracted', open.some((i) => /caching the search results/.test(i.summary)));
check('unanswered question extracted', open.some((i) => i.origin === 'question'));

// --- 2. SessionStart digest ---
const digest = JSON.parse(
  run('hooks/session-start.mjs', [], { dir: dirA, input: '{}\n' }).stdout
).hookSpecificOutput.additionalContext;
check('digest emitted', digest.includes('[claude-adhd] Open threads'));
check('digest has up to 3 items', (digest.match(/^- \(/gm) || []).length === 3);
// The digest counts as a reminder: the 3 items shown should now have
// lastReminded set (cooldown active), the other open ones not yet.
const afterDigest = JSON.parse(
  run('scripts/mark.mjs', ['list', '--all'], { dir: dirA }).stdout
).items.filter((i) => i.status === 'open');
check(
  'digest items get cooldown (lastReminded set)',
  afterDigest.filter((i) => i.lastReminded).length === 3
);

// --- 3. unfocused detection ---
const unfocused = await import(pathToFileURL(path.join(root, 'hooks', 'prompt-submit.mjs')));
check(
  'drifty transcript detected as unfocused',
  unfocused.looksUnfocused(
    unfocused.readTranscriptRecent(path.join(fixtures, 'drifty-transcript.jsonl'))
  ) === true
);
check(
  'focused transcript not flagged',
  unfocused.looksUnfocused(
    unfocused.readTranscriptRecent(path.join(fixtures, 'focused-transcript.jsonl'))
  ) === false
);

// --- 4. nudge output + cap (fresh index, no digest cooldown) ---
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'adhd-nudge-'));
run('scripts/indexer.mjs', [], { dir: dirB });
const mkInput = JSON.stringify({
  session_id: 'cap-test',
  transcript_path: path.join(fixtures, 'drifty-transcript.jsonl'),
  prompt: 'maybe three tiers?',
});
const runHook = () =>
  JSON.parse(
    run('hooks/prompt-submit.mjs', [], { dir: dirB, input: mkInput, extra: { ADHD_FORCE_NUDGE: '1' } })
      .stdout
  ).hookSpecificOutput.additionalContext;

const n1 = runHook();
check('forced nudge emits context', n1.includes('claude-adhd'));
runHook(); // 2nd — allowed
const n3 = runHook(); // 3rd — cap
check('third nudge silenced by cap', n3 === '');

// --- 5. mark round-trip ---
const mark = (args) => run('scripts/mark.mjs', args, { dir: dirB }).stdout.trim();
const target = open[0].id;
mark(['done', target]);
check(
  'done removes from open list',
  !JSON.parse(mark(['list'])).items.some((i) => i.id === target)
);
check(
  'done visible via --all',
  JSON.parse(mark(['list', '--all'])).items.find((i) => i.id === target).status === 'done'
);
mark(['open', target]);
mark(['dismiss', target]);
check(
  'dismiss persists',
  JSON.parse(mark(['list', '--all'])).items.find((i) => i.id === target).status === 'dismissed'
);

// --- 6. reminders ---
const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'adhd-rem-'));
const remind = (args) => run('scripts/remind.mjs', args, { dir: dirC }).stdout.trim();
const remList = (all) => JSON.parse(remind(['list', ...(all ? ['--all'] : [])])).items;

// In-process store must read the same throwaway dir as the CLI children.
process.env.ADHD_DIR = dirC;
const store = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'store.mjs')));

// once: future not due, past fires once and auto-dones
// (100h future: must survive the 25h-ahead daily-reminder checks below)
remind(['add', 'future once', '--in', '100h']);
remind(['add', 'past once', '--in', '1s']);
await new Promise((r) => setTimeout(r, 1100));
let due = store.collectDueReminders('rem-s1', {}, Date.now());
check('past-due once reminder fires', due.some((r) => r.message === 'past once'));
check('future once reminder not due', !due.some((r) => r.message === 'future once'));
due = store.collectDueReminders('rem-s1', {}, Date.now());
check('once reminder auto-done after firing', !due.some((r) => r.message === 'past once'));

// recurring session: fires on new session only
remind(['add', 'standup note', '--every', 'session']);
due = store.collectDueReminders('rem-s1', {}, Date.now());
check('session reminder fires in new session', due.some((r) => r.message === 'standup note'));
due = store.collectDueReminders('rem-s1', {}, Date.now());
check('session reminder silent within same session', !due.some((r) => r.message === 'standup note'));
due = store.collectDueReminders('rem-s2', {}, Date.now());
check('session reminder fires again next session', due.some((r) => r.message === 'standup note'));

// recurring day: fires, then cooldown blocks within the day
remind(['add', 'daily water', '--every', 'day']);
const nowMs = Date.now();
due = store.collectDueReminders('rem-s1', {}, nowMs);
check('daily reminder fires when new', due.some((r) => r.message === 'daily water'));
due = store.collectDueReminders('rem-s1', {}, nowMs + 60 * 60 * 1000);
check('daily reminder cooldown blocks same day', !due.some((r) => r.message === 'daily water'));
due = store.collectDueReminders('rem-s1', {}, nowMs + 25 * 60 * 60 * 1000);
check('daily reminder fires next day', due.some((r) => r.message === 'daily water'));

// random: forced fire + cooldown
remind(['add', 'random zen', '--random']);
due = store.collectDueReminders('rem-s1', {}, Date.now(), { forceRandom: true });
check('random reminder fires when forced', due.some((r) => r.message === 'random zen'));
due = store.collectDueReminders('rem-s1', {}, Date.now(), { forceRandom: true });
check('random reminder daily cooldown blocks', !due.some((r) => r.message === 'random zen'));

// capture hook injects due reminders
const dirD = fs.mkdtempSync(path.join(os.tmpdir(), 'adhd-rem-cap-'));
run('scripts/remind.mjs', ['add', 'stretch break', '--in', '1s'], { dir: dirD });
await new Promise((r) => setTimeout(r, 1100));
const capCtx = JSON.parse(
  run('hooks/capture.mjs', [], { dir: dirD, input: '{"session_id":"cap-rem"}' }).stdout
).hookSpecificOutput.additionalContext;
check('capture hook emits due reminder', capCtx.includes('stretch break'));
check('capture hook keeps standing instruction', capCtx.includes('[claude-adhd tracking]'));
check('capture instruction mentions remind.mjs', capCtx.includes('remind.mjs'));

// CLI round-trip: done + delete
const remItems = remList();
const onceId = remItems.find((r) => r.message === 'future once').id;
remind(['done', onceId]);
check('reminder done removes from active list', !remList().some((r) => r.id === onceId));
check('reminder done visible via --all', remList(true).some((r) => r.id === onceId && r.done));
const zenId = remItems.find((r) => r.message === 'random zen').id;
remind(['delete', zenId]);
check('reminder delete removes everywhere', !remList(true).some((r) => r.id === zenId));

// --- cleanup ---
fs.rmSync(projDir, { recursive: true, force: true });
fs.rmSync(dirA, { recursive: true, force: true });
fs.rmSync(dirB, { recursive: true, force: true });
fs.rmSync(dirC, { recursive: true, force: true });
fs.rmSync(dirD, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL TESTS PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
