---
name: remind-me
description: Surface unfinished or forgotten tasks, ideas, and open questions from the user's past Claude Code sessions, and manage custom reminders. Use when the user says "remind me", "what did I forget", "what's unfinished", "what was I working on", "did I leave anything open", "set a reminder", "remind me to", or invokes /remind-me or /remind. Especially useful for users with ADHD.
---

# Remind me — forgotten open threads

Show the user things they said in past sessions that never got finished, ranked by age and likely relevance.

## Steps

1. **Refresh the index** (fast, local only):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/mark.mjs" reindex
   ```

   If `$CLAUDE_PLUGIN_ROOT` is not set, find `scripts/mark.mjs` next to this skill file's parent directories (the plugin root).

2. **List open items**:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/mark.mjs" list
   ```

   Returns `{ "items": [...] }` with `{ id, summary, sessionPath, timestamp, origin }`.

3. **Filter and rank.** Drop items that are clearly resolved or trivial from the current context. Rank the rest: older and more substantive first. The extraction is heuristic — use judgment; false positives are fine to silently drop.

4. **Present** as a short numbered list, each with age and source:

   > **Things you left open:**
   > 1. "I'll add tests to the auth module later" — 6 days ago
   > 2. "what if we tried caching the search results?" — 2 weeks ago
   >
   > Want to pick any of these up now, mark something done, or dismiss it?

5. **Act on the user's choice** (they can say "1", "the auth thing", "mark 2 done", "dismiss the search one"):

   - **Resume**: read the origin session transcript (`sessionPath` is a `.jsonl` file — read the lines around the item's timestamp) to reconstruct context, then continue that thread.
   - **Mark done**: `node "$CLAUDE_PLUGIN_ROOT/scripts/mark.mjs" done <id>`
   - **Dismiss forever**: `node "$CLAUDE_PLUGIN_ROOT/scripts/mark.mjs" dismiss <id>`

## Tone

No pressure, no guilt, no lecturing. The user forgot these things — that's the point. One line per item, offer choices, then act. Never scold ("you really should finish X"). Never show more than ~8 items at once.

## Reminders (custom messages)

If the user's request is about setting or managing reminders (not past threads), use `scripts/remind.mjs` instead of the indexer:

- **Set**: `node "$CLAUDE_PLUGIN_ROOT/scripts/remind.mjs" add "<message>" --at <ISO datetime> | --in <e.g. 2h, 30m, 1d> | --every session|day | --random [--project <name>]`
  - Compute the actual date/time from natural language ("tomorrow 3pm" → tomorrow's ISO datetime at 15:00 local).
- **List**: `node "$CLAUDE_PLUGIN_ROOT/scripts/remind.mjs" list` (add `--all` to include handled ones)
- **Handled**: `node "$CLAUDE_PLUGIN_ROOT/scripts/remind.mjs" done <id>`
- **Delete**: `node "$CLAUDE_PLUGIN_ROOT/scripts/remind.mjs" delete <id>`

Reminders surface automatically in the conversation via the plugin's hook when due. Confirm to the user in one line what was set and when it will appear — no extra detail.

## Notes

- The index lives in `~/.claude/adhd/index.json`. All data stays local; scripts make no network calls.
- If the list is empty, say so plainly: nothing open right now.
- If the user asks to see even resolved items, pass `--all` to `list`.
