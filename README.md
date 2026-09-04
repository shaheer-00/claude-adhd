# Claude ADHD

A Claude Code plugin for ADHD brains. It remembers the things you said but never finished — tasks, ideas, half-asked questions from past sessions — and brings them back gently:

- **Session digest** — when you start a session, it quietly surfaces the 1–3 most stale open threads.
- **Random nudges** — when your chat drifts into brainstorming or boredom, it occasionally drops a one-line "btw, you left this open" — never pushy, never more than twice per session.
- **Live capture** — when you commit to a task mid-chat, Claude silently records it, and marks it done when finished. No more "wait, what did we decide yesterday?"
- **Dashboard** — a local web page (auto-started on session start) with projects, stats, graphs, and mark done/dismiss/resume buttons.
- **`/remind-me`** — on demand: "what did I forget?" gets you a ranked list of open threads, and you can resume one, mark it done, or dismiss it forever.

## Install

```bash
/plugin marketplace add <github-owner>/claude-adhd
/plugin install claude-adhd@claude-adhd
```

Requires Claude Code and Node.js. Nothing else — no dependencies, no API keys.

## How it works

```
~/.claude/projects/**/*.jsonl   (your session transcripts, read-only)
        │
        ▼
  local indexer (pure Node, heuristics)
        │
        ▼
~/.claude/adhd/index.json       (open threads with cooldown state)
        │
        ▼
  hooks → context injection → Claude decides when/how to surface them
```

Two layers, deliberately: **cheap scripts for recall, the model for judgment.** The scripts only extract candidates and enforce anti-nag rules (3-day per-item cooldown, max 2 nudges per session). Claude reads the live conversation and only speaks up when it actually fits.

## Dashboard

Start a session (or run `node scripts/server.mjs`) and open **http://127.0.0.1:37987**:

- projects list, current project, finished-vs-open stats
- 14-day completion/added graphs (inline SVG, no CDN)
- mark items done / dismissed / reopen, add new ones

Bound to `127.0.0.1` only. No network exposure, no telemetry. If you use [claude-mem](https://github.com/thedotmack/claude-mem), its per-project open threads are merged into the dashboard automatically (read-only).

## Configuration

Optional `~/.claude/adhd/config.json`:

```json
{
  "reminderProbability": 0.1,
  "cooldownDays": 3,
  "maxNudgesPerSession": 2,
  "digestOnStart": true,
  "maxSessionsIndexed": 50,
  "maxItemAgeDays": 90,
  "dashboardPort": 37987
}
```

Set `"dashboard": false` to never auto-start the server, or `"capture": false` to disable live task capture.

## Privacy

Everything stays on your machine. The scripts read your local Claude Code transcripts and write a local index. The dashboard binds to localhost only. Zero telemetry. claude-mem integration, if present, is read-only.

## Commands

- `/remind-me [topic]` — list forgotten open threads, optionally filtered by topic
- Or just say "remind me", "what did I forget?", "what's unfinished?" — the skill triggers on those too.

## Tips

- "mark 2 done", "dismiss the auth one" — manage items in plain language.
- If nudges feel too chatty, lower `reminderProbability`; if the digest is noise, set `digestOnStart: false` and rely on `/remind-me`.
- Auto done-detection is heuristic (it looks for completion phrasing in later sessions). `/remind-me` lets you correct it — if something shows up that's actually finished, say "mark it done".

## Development

```bash
node fixtures/run-tests.mjs            # full test suite (fixture transcripts, throwaway dirs)
node scripts/indexer.mjs               # scan transcripts → index
node scripts/mark.mjs list             # see what's open
node scripts/server.mjs                # dashboard (http://127.0.0.1:37987)
```
