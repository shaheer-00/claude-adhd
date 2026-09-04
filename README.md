# Claude ADHD

A Claude Code plugin for ADHD brains. It remembers the things you said but never finished — tasks, ideas, half-asked questions from past sessions — and brings them back gently:

- **Session digest** — when you start a session, it quietly surfaces the 1–3 most stale open threads.
- **Random nudges** — when your chat drifts into brainstorming or boredom, it occasionally drops a one-line "btw, you left this open" — never pushy, never more than twice per session.
- **Live capture** — when you commit to a task mid-chat, Claude silently records it, and marks it done when finished. No more "wait, what did we decide yesterday?"
- **Custom reminders** — tell Claude "remind me tomorrow at 3pm to check the deploy", "every session remind me to run tests first", or "occasionally remind me to stretch" — they surface naturally in the conversation when due. Also `/remind`.
- **Dashboard** — a local web page (auto-started on session start) with projects, stats, graphs, reminders, and mark done/dismiss/resume buttons.
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

## Reminders

Three kinds, created three ways:

| Kind | Example | When it appears |
|------|---------|-----------------|
| once | "remind me tomorrow 3pm to check the deploy" | at that time, once |
| recurring | "every session remind me to run tests first" / "daily, stand up" | each session / each day |
| random | "occasionally remind me to stretch" | surprise, max once a day |

Create them by just telling Claude ("remind me to X at Y"), with `/remind`, in the dashboard's Reminders panel, or via CLI:

```bash
node scripts/remind.mjs add "check the deploy" --at 2026-09-05T15:00   # once
node scripts/remind.mjs add "stretch" --in 2h                          # once, relative
node scripts/remind.mjs add "run tests first" --every session          # recurring
node scripts/remind.mjs add "drink water" --random                     # occasional
node scripts/remind.mjs list                                           # see what's set
```

Reminders live in `~/.claude/adhd/reminders.json`. Set `"reminders": false` in the config to turn injection off.

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
  "dashboardPort": 37987,
  "randomReminderProbability": 0.15
}
```

Set `"dashboard": false` to never auto-start the server, `"capture": false` to disable live task capture, or `"reminders": false` to disable custom-reminder injection.

## Privacy

Everything stays on your machine. The scripts read your local Claude Code transcripts and write a local index. The dashboard binds to localhost only. Zero telemetry. claude-mem integration, if present, is read-only.

## Commands

- `/remind-me [topic]` — list forgotten open threads, optionally filtered by topic
- `/remind <message> [at <time> | every session|day | random]` — set a custom reminder
- Or just say "remind me", "what did I forget?", "what's unfinished?", "remind me to X at Y" — the skill triggers on those too.

## Tips

- "mark 2 done", "dismiss the auth one" — manage items in plain language.
- If nudges feel too chatty, lower `reminderProbability`; if the digest is noise, set `digestOnStart: false` and rely on `/remind-me`.
- Auto done-detection is heuristic (it looks for completion phrasing in later sessions). `/remind-me` lets you correct it — if something shows up that's actually finished, say "mark it done".

## Development

```bash
node fixtures/run-tests.mjs            # full test suite (fixture transcripts, throwaway dirs)
node scripts/indexer.mjs               # scan transcripts → index
node scripts/mark.mjs list             # see what's open
node scripts/remind.mjs list           # see active reminders
node scripts/server.mjs                # dashboard (http://127.0.0.1:37987)
```
