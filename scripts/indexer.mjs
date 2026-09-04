#!/usr/bin/env node
// Transcript indexer for the claude-adhd plugin.
// Scans Claude Code session transcripts (~/.claude/projects/**/*.jsonl),
// extracts candidate "open threads" (things said but never finished),
// and merges them into ~/.claude/adhd/index.json.
//
// Usage: node indexer.mjs [--force]
//   --force  re-parse sessions even if mtime unchanged
//
// Env overrides (for tests): ADHD_DIR, ADHD_PROJECTS_DIR.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  loadIndex,
  saveIndex,
  itemId,
  projectsDir,
} from './lib/store.mjs';

const MAX_FILE_BYTES = 1024 * 1024; // skip huge transcripts
const MAX_SUMMARY_LEN = 200;
const PENDING_REPLY_FRESH_MS = 30 * 60 * 1000; // ignore sessions touched this recently

export const TASK_PATTERNS = [
  /\bi(?:'ll| will| gonna| need to| have to| should| want to)\b[^.!?]{3,120}\b(later|tomorrow|next time|soon|eventually)\b/i,
  /\bremind me\b/i,
  /\bdon'?t let me forget\b/i,
  /\bi'?ll get (back|around) to\b/i,
  /\badd (it|this) to (my|the) (todo|list)\b/i,
  /\bnext step\b/i,
  /\bTODO\b/i,
  /\btodo:?\s/i,
  /\bwe should (do|try|build|add|fix|refactor|test)\b/i,
  /\blet'?s (do|try|build|add|fix|refactor|test)\b/i,
  /\bidea:?\s/i,
  /\bwhat if we\b/i,
  /\bone thing (we| i) (still|also) (need|should)\b/i,
];

const COMPLETION_PATTERNS = [
  /\b(finished|done|shipped|fixed|resolved|implemented|completed|migrated|deployed)\b/i,
  /\bworks? now\b/i,
  /\ball (tests? )?pass(ing|ed)?\b/i,
];

const SKIP_PREFIXES = ['<', '[{', '{'];

// Extract plain text of a user message; returns '' for non-text content.
export function userText(entry) {
  if (entry.type !== 'user' || !entry.message) return '';
  const msg = entry.message;
  if (msg.role !== 'user') return '';
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ');
  }
  return '';
}

export function assistantHadToolUse(entry) {
  if (entry.type !== 'assistant' || !entry.message) return false;
  const content = entry.message.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && (b.type === 'tool_use' || b.type === 'tool_result'));
}

function cleanSummary(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_LEN);
}

export function looksLikeCommand(text) {
  return SKIP_PREFIXES.some((p) => text.startsWith(p));
}

// Plain text of an assistant message (text blocks only, no tool use).
export function assistantText(entry) {
  if (entry.type !== 'assistant' || !entry.message) return '';
  const content = entry.message.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

// A session ends with Claude asking the user something and the user never
// answering — a thread that dies awaiting a reply.
export function extractPendingReply(lines) {
  let last = null; // last meaningful message: {role: 'user'|'assistant', text}
  for (const entry of lines) {
    const u = userText(entry).trim();
    if (u && !looksLikeCommand(u)) { last = { role: 'user', text: u }; continue; }
    const a = assistantText(entry);
    if (a) last = { role: 'assistant', text: a };
  }
  if (!last || last.role !== 'assistant') return null;
  if (!/\?/.test(last.text)) return null;
  if (last.text.length < 15 || last.text.length > 600) return null;
  return { summary: cleanSummary(last.text) };
}

export function extractCandidates(lines) {
  const candidates = [];
  const msgs = [];

  for (const entry of lines) {
    const text = userText(entry).trim();
    if (!text) {
      msgs.push({ kind: 'other', toolUse: assistantHadToolUse(entry) });
      continue;
    }
    msgs.push({ kind: 'user', text, toolUse: false, ts: entry.timestamp });
  }

  const n = msgs.length;
  for (let i = 0; i < n; i++) {
    const m = msgs[i];
    if (m.kind !== 'user' || looksLikeCommand(m.text)) continue;
    if (m.text.length < 12 || m.text.length > 600) continue;

    const matched = TASK_PATTERNS.some((re) => re.test(m.text));

    // Unanswered question: user asks a question and the session ends (or
    // the next two exchanges have no tool use) without a question mark
    // resolution from the user.
    let question = false;
    if (!matched && /\?/.test(m.text)) {
      const rest = msgs.slice(i + 1, i + 3);
      const noWork = rest.every((r) => !r.toolUse);
      question = noWork || i === n - 1;
    }

    if (!matched && !question) continue;

    // Deduplicate near-identical consecutive messages.
    const prev = candidates[candidates.length - 1];
    const summary = cleanSummary(m.text);
    if (prev && prev.summary === summary) continue;

    candidates.push({
      summary,
      question,
      ts: m.ts ? new Date(m.ts).getTime() : Date.now(),
    });
  }
  return candidates;
}

function contentWords(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

// Check newer sessions' user messages for completion phrases overlapping
// the item's terms — coarse done-detection; the /remind-me skill lets the
// model correct false positives/negatives.
function detectCompletions(items, sessionsText, idx) {
  for (const item of items) {
    if (item.status !== 'open') continue;
    const terms = contentWords(item.summary);
    if (terms.size === 0) continue;
    for (const [sessionKey, info] of Object.entries(sessionsText)) {
      if ((info.ts || 0) <= (item.sessionTs || item.timestamp || 0)) continue;
      if (sessionKey === item.sessionKey) continue;
      for (const text of info.texts) {
        if (!COMPLETION_PATTERNS.some((re) => re.test(text))) continue;
        const words = contentWords(text);
        let overlap = 0;
        for (const t of terms) if (words.has(t)) overlap++;
        if (overlap >= Math.min(3, Math.ceil(terms.size * 0.25))) {
          item.status = 'done';
          item.statusChangedAt = Date.now();
          item.statusSource = 'auto';
          break;
        }
      }
      if (item.status !== 'open') break;
    }
  }
}

function findTranscripts(config, force) {
  const root = projectsDir();
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full);
          if (st.size <= MAX_FILE_BYTES) files.push({ full, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* ignore unreadable */
        }
      }
    }
  };
  walk(root);
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, config.maxSessionsIndexed);
}

export function parseSession(full) {
  const lines = [];
  const raw = fs.readFileSync(full, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      lines.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }
  return lines;
}

export function runIndex(force = false) {
  const config = loadConfig();
  const idx = loadIndex();
  const transcripts = findTranscripts(config, force);

  let parsed = 0;
  let added = 0;
  const sessionsText = {}; // sessionKey -> {ts, texts}

  for (const t of transcripts) {
    const key = t.full;
    const known = idx.sessions[key];
    if (!force && known && known.mtime === t.mtime) {
      // Still collect texts for completion detection.
      collectTexts(sessionsText, key, known.texts || [], known.ts || t.mtime);
      continue;
    }
    parsed++;
    const lines = parseSession(t.full);
    const sessionTs = lines
      .map((l) => l.timestamp)
      .filter(Boolean)
      .map((s) => new Date(s).getTime())
      .pop() || t.mtime;
    const texts = lines.map(userText).filter((s) => s && !looksLikeCommand(s));
    collectTexts(sessionsText, key, texts, sessionTs);
    idx.sessions[key] = { mtime: t.mtime, ts: sessionTs, texts: texts.slice(-200) };

    for (const cand of extractCandidates(lines)) {
      const id = itemId(cand.summary, key);
      if (idx.items.some((it) => it.id === id)) continue;
      idx.items.push({
        id,
        summary: cand.summary,
        sessionPath: key,
        sessionKey: key,
        sessionTs,
        timestamp: cand.ts,
        status: 'open',
        lastReminded: null,
        origin: cand.question ? 'question' : 'task',
      });
      added++;
    }

    // Pending reply: session ended on an unanswered Claude question.
    // Skip fresh sessions — the user may just be mid-conversation.
    if (Date.now() - t.mtime > PENDING_REPLY_FRESH_MS) {
      const pending = extractPendingReply(lines);
      if (pending) {
        const pid = itemId(`reply::${pending.summary}`, key);
        if (!idx.items.some((it) => it.id === pid)) {
          idx.items.push({
            id: pid,
            summary: pending.summary,
            sessionPath: key,
            sessionKey: key,
            sessionTs,
            timestamp: sessionTs,
            status: 'open',
            lastReminded: null,
            origin: 'pending-reply',
          });
          added++;
        }
      }
    }
  }

  detectCompletions(idx.items, sessionsText, idx);
  saveIndex(idx);

  return { parsed, added, totalItems: idx.items.length, open: idx.items.filter((i) => i.status === 'open').length };
}

function collectTexts(sessionsText, key, texts, ts) {
  sessionsText[key] = { ts, texts };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const force = process.argv.includes('--force');
  const result = runIndex(force);
  console.log(JSON.stringify(result));
}
