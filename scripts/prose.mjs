#!/usr/bin/env node
// Prose-mode extraction harness for the claude-adhd plugin.
//
// Ports the transcript heuristics to documentation: extracts future-intent
// phrases from a repo's markdown files, then checks the git log for commits
// that look like they landed each intent. This is an evaluation harness,
// not part of the live plugin — it measures extraction recall and
// done-detection against hand-labeled ground truth (see README).
//
// Usage: node prose.mjs <repo-path> [--json]
//
// What ports from the transcript indexer and what doesn't:
//   ports:    TODO/FIXME, "next step", "we should X", "idea:", "what if we",
//             plus the term-overlap done-detector (later sessions -> commits)
//   replaced: first-person deferral ("I'll X later", "remind me") — prose
//             doesn't talk like that; instead: eventually/someday/planned/
//             deferred/unchecked checkboxes/"future work"
//   dropped:  the "question" and "pending-reply" origins — conversational
//             structure with no markdown analog

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SUMMARY_LEN = 200;
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', '.astro', '.vercel', '_inspect', '.claude',
]);

export const PROSE_TASK_PATTERNS = [
  /\bTODO\b/,
  /\bFIXME\b/,
  /\btodo:?\s/i,
  /^\s*[-*]\s+\[ \]/, // unchecked markdown checkbox
  /\bnext steps?\b/i,
  /\bwe should (do|try|build|add|fix|refactor|test|move|use|switch|support|write|make|handle|extend)\b/i,
  /\bidea:?\s/i,
  /\bwhat if we\b/i,
  /\beventually\b/i,
  /\bsomeday\b/i,
  /\bfuture (work|improvements?|enhancements?|ideas?)\b/i,
  /\bplanned\b/i,
  /\bpost-MVP\b/i,
  /\bdefer(red)?\b/i,
  /\bskipp(ing|ed) (this|it|that) for now\b/i,
  /\bcome back to\b/i,
  /\bstill (need|want) to\b/i,
  /\bleft to (do|build|implement|write)\b/i,
  /\bshould also\b/i,
  /\bnot yet\b/i,
  /\bcoming (in|with|soon)\b/i,
  /\bTBD\b/,
  /\blater\b/i,
  /\boutstanding\b/i,
  /\bblocked on\b/i,
];

// Headings whose whole section is future intent. This is the prose analog
// of the pending-reply origin: a structural signal (section placement)
// rather than a lexical one, because documentation states intent through
// where it puts things, not through how it phrases them.
export const HEADING_SCOPE =
  /\b(open items|roadmap|to dos?|todos?|next steps?|deferred|blocked|placeholders?|before you launch|launch checklist|coming soon|future work|still to do)\b/i;

// Same shape as the indexer's completion verbs, widened for commit
// messages: transcripts say "fixed", commits say "fix:".
export const COMMIT_COMPLETION =
  /^(feat|fix|refactor|perf|test|docs)(\([^)]*\))?:|\b(fix|fixes|fixed|add|adds|added|implement|implements|implemented|build|builds|built|create|creates|created|make|makes|made|migrate|migrated|ship|ships|shipped|deploy|deploys|deployed|resolve|resolves|resolved|finish|finishes|finished|complete|completes|completed|support|supports|supported|introduce|introduces|introduced|write|writes|wrote|written|extend|extends|extended|enable|enables|enabled|update|updates|updated|upgrade|upgraded|widen|widened)\b/i;

function cleanSummary(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_LEN);
}

// Split markdown text into (line, sentence, heading) prose units, skipping
// fenced code blocks. Hard-wrapped lines are joined into paragraphs before
// sentence-splitting, so a sentence broken across lines stays one unit.
// Each unit carries the nearest preceding heading, so scoped sections
// (Open Items, Roadmap, ...) can be extracted structurally.
export function proseUnits(text) {
  const units = [];
  let inFence = false;
  let heading = '';
  const lines = text.split('\n');
  let para = []; // hard-wrapped paragraph accumulator
  let paraLine = 0;
  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join(' ');
    for (const s of joined.split(/(?<=[.!?])\s+/)) {
      const t = s.trim();
      if (t) units.push({ line: paraLine, text: t, heading });
    }
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      heading = h[2].trim();
      units.push({ line: i + 1, text: heading, heading: null });
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      continue;
    }
    // List items and table rows stand alone; prose accumulates.
    if (/^\s*([-*+]|\d+[.)])\s/.test(line) || trimmed.startsWith('|')) {
      flushPara();
      units.push({ line: i + 1, text: trimmed, heading });
      continue;
    }
    if (!para.length) paraLine = i + 1;
    para.push(trimmed);
  }
  flushPara();
  return units;
}

// Extract future-intent candidates from markdown text.
// Returns [{ summary, line, pattern }] in document order.
export function extractProseCandidates(text) {
  const out = [];
  for (const u of proseUnits(text)) {
    if (u.text.length < 10 || u.text.length > 600) continue;
    if (/^\s*[-*+]\s+\[x\]/i.test(u.text)) continue; // checked = done, not open
    let pattern = PROSE_TASK_PATTERNS.find((re) => re.test(u.text));
    // No lexical hit: a list item or plain sentence under a scoped heading
    // ("Open Items", "Before you launch", ...) is intent by placement.
    // Table rows are excluded — a checklist table is one intent, not
    // seventeen candidates.
    if (!pattern && u.heading && HEADING_SCOPE.test(u.heading)) {
      // Checked boxes are done, not open. Table rows excluded — a
      // checklist table is one intent, not seventeen candidates.
      if (!u.text.startsWith('|') && !/^\s*[-*+]\s+\[x\]/i.test(u.text)) {
        pattern = `scope:${u.heading.slice(0, 40)}`;
      }
    }
    if (!pattern) continue;
    const summary = cleanSummary(u.text);
    if (summary.length < 10) continue;
    const prev = out[out.length - 1];
    if (prev && prev.summary === summary) continue; // dedupe repeats
    out.push({ summary, line: u.line, pattern: String(pattern) });
  }
  return out;
}

export function contentWords(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

// Best-matching commit for an intent phrase: a completion verb in the
// subject plus term overlap, same threshold as the indexer's
// detectCompletions. Returns the commit or null.
export function bestCommit(summary, commits) {
  const terms = contentWords(summary);
  if (terms.size === 0) return null;
  let best = null;
  let bestOverlap = 0;
  for (const c of commits) {
    if (!COMMIT_COMPLETION.test(c.subject)) continue;
    const words = contentWords(c.subject);
    let overlap = 0;
    for (const t of terms) if (words.has(t)) overlap++;
    const need = Math.min(3, Math.ceil(terms.size * 0.25));
    if (overlap >= need && overlap > bestOverlap) {
      best = c;
      bestOverlap = overlap;
    }
  }
  return best;
}

function findMarkdown(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && !e.name.startsWith('.github')) {
        if (e.isDirectory()) continue; // .git etc. (but allow .github)
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        try {
          const st = fs.statSync(full);
          if (st.size <= MAX_FILE_BYTES) files.push(full);
        } catch {
          /* ignore unreadable */
        }
      }
    }
  };
  walk(root);
  return files;
}

function gitLog(root) {
  try {
    const out = execFileSync(
      'git',
      ['log', '--date=short', '--pretty=format:%H%x09%ad%x09%s'],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, date, subject] = l.split('\t');
        return { hash, date, subject };
      });
  } catch {
    return []; // not a repo, or git missing — report without commit matching
  }
}

export function runProse(repoPath) {
  const files = findMarkdown(repoPath);
  const commits = gitLog(repoPath);
  const items = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const cand of extractProseCandidates(text)) {
      const match = bestCommit(cand.summary, commits);
      items.push({
        file: path.relative(repoPath, f).replace(/\\/g, '/'),
        line: cand.line,
        summary: cand.summary,
        commit: match ? { hash: match.hash.slice(0, 7), date: match.date, subject: match.subject } : null,
      });
    }
  }
  const matched = items.filter((i) => i.commit).length;
  return {
    repo: repoPath,
    filesScanned: files.length,
    commitsScanned: commits.length,
    candidates: items.length,
    matchedCommit: matched,
    noCommitMatch: items.length - matched,
    items,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const repo = args.find((a) => !a.startsWith('-'));
  if (!repo) {
    console.error('Usage: node prose.mjs <repo-path> [--json]');
    process.exit(1);
  }
  const asJson = args.includes('--json');
  const report = runProse(path.resolve(repo));
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Prose extraction: ${report.repo}`);
    console.log(`Files scanned: ${report.filesScanned} | commits: ${report.commitsScanned}`);
    console.log(`Future-intent candidates: ${report.candidates} (${report.matchedCommit} matched a commit, ${report.noCommitMatch} no match)`);
    for (const i of report.items) {
      const where = `${i.file}:${i.line}`;
      const commit = i.commit
        ? `${i.commit.hash} ${i.commit.date} "${i.commit.subject}"`
        : '(no commit match)';
      console.log(`  [${where}] ${i.summary}\n      -> ${commit}`);
    }
  }
}
