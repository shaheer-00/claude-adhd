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
const indexer = await import(pathToFileURL(path.join(root, 'scripts', 'indexer.mjs')));
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

// --- 7. focus mode ---
const dirE = fs.mkdtempSync(path.join(os.tmpdir(), 'adhd-focus-'));
process.env.ADHD_DIR = dirE; // in-process store reads this too
const focusCli = (args) => run('scripts/focus.mjs', args, { dir: dirE }).stdout.trim();

focusCli(['start', '25', 'ship it']);
let fstate = store.focusPhase();
check('focus starts active', fstate.phase === 'active' && fstate.label === 'ship it');
check('focus remaining ~25m', Math.abs(fstate.remainingMs - 25 * 60_000) < 5000);
// expire by writing past activeUntil
fs.writeFileSync(path.join(dirE, 'focus.json'), JSON.stringify({ active: true, startedAt: Date.now() - 7e6, activeUntil: Date.now() - 1000, label: 'ship it', wrappedUp: false }));
fstate = store.focusPhase();
check('expired focus returns ended once', fstate.phase === 'ended');
fstate = store.focusPhase();
check('ended only once, then off', fstate.phase === 'off');
// capture hook injects active focus
focusCli(['start', '10', 'stay on task']);
const focusCtx = JSON.parse(
  run('hooks/capture.mjs', [], { dir: dirE, input: '{"session_id":"f"}' }).stdout
).hookSpecificOutput.additionalContext;
check('capture hook injects focus context', focusCtx.includes('[claude-adhd focus] Focus session active'));
check('focus context has label', focusCtx.includes('stay on task'));
focusCli(['stop']);
check('focus stop clears', store.focusPhase().phase === 'off');

// --- 8. streak + aging ---
check('streak counts consecutive done days', store.doneStreak([
  { status: 'done', statusChangedAt: Date.now() },
  { status: 'done', statusChangedAt: Date.now() - 86400000 },
  { status: 'done', statusChangedAt: Date.now() - 2 * 86400000 },
]) === 3);
check('streak survives today missing', store.doneStreak([
  { status: 'done', statusChangedAt: Date.now() - 86400000 },
]) === 1);
check('streak zero when gap', store.doneStreak([
  { status: 'done', statusChangedAt: Date.now() - 3 * 86400000 },
]) === 0);

// --- 9. energy tagging ---
const dirF = fs.mkdtempSync(path.join(os.tmpdir(), 'adhd-energy-'));
const markF = (args) => run('scripts/mark.mjs', args, { dir: dirF }).stdout.trim();
markF(['add', 'quick README tweak', '--energy', 'low', '--project', 'P']);
markF(['add', 'big refactor job', '--energy', 'high', '--project', 'P']);
const lowItems = JSON.parse(markF(['list', '--energy', 'low'])).items;
check('energy filter returns only low', lowItems.length === 1 && lowItems[0].summary === 'quick README tweak');
check('energy stored on add', JSON.parse(markF(['list'])).items.find((i) => i.summary === 'big refactor job').energy === 'high');

// --- 10. pending-reply extraction ---
const pendingLines = [
  { type: 'user', message: { role: 'user', content: 'hey can you look at the auth flow?' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Sure. Do you want me to also rotate the tokens while I am in there?' }] } },
];
check('pending reply extracted from trailing assistant question',
  indexer.extractPendingReply(pendingLines)?.summary.includes('rotate the tokens'));
const answeredLines = [...pendingLines, { type: 'user', message: { role: 'user', content: 'yes rotate them' } }];
check('no pending reply when user answered', indexer.extractPendingReply(answeredLines) === null);
const noQuestion = [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All done, the build is green.' }] } },
];
check('no pending reply without question', indexer.extractPendingReply(noQuestion) === null);

// --- 11. aging marker in digest ---
const dirG = fs.mkdtempSync(path.join(os.tmpdir(), 'adhd-aging-'));
process.env.ADHD_DIR = dirG;
run('scripts/indexer.mjs', [], { dir: dirG });
// age every open item past the aging threshold, then force digest
const agingFile = path.join(dirG, 'index.json');
const agingIdx = JSON.parse(fs.readFileSync(agingFile, 'utf8'));
const OLD = 20 * 24 * 60 * 60 * 1000;
for (const it of agingIdx.items) if (it.status === 'open') it.timestamp = Date.now() - OLD;
fs.writeFileSync(agingFile, JSON.stringify(agingIdx));
const agingDigest = JSON.parse(
  run('hooks/session-start.mjs', [], { dir: dirG, input: '{}\n', extra: { ADHD_FORCE_DIGEST: '1' } }).stdout
).hookSpecificOutput.additionalContext;
check('aging items flagged in digest', /aging, \d+ (days|weeks) ago/.test(agingDigest));

// --- cleanup ---
fs.rmSync(projDir, { recursive: true, force: true });
fs.rmSync(dirA, { recursive: true, force: true });
fs.rmSync(dirB, { recursive: true, force: true });
fs.rmSync(dirC, { recursive: true, force: true });
fs.rmSync(dirD, { recursive: true, force: true });
fs.rmSync(dirE, { recursive: true, force: true });
fs.rmSync(dirF, { recursive: true, force: true });
fs.rmSync(dirG, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL TESTS PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
