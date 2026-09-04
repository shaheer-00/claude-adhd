---
description: Start or manage a timed focus session with drift redirection
argument-hint: [minutes] [task]
---

Invoke the `remind-me` skill and follow its **Focus mode** section.

No argument: run `node "$CLAUDE_PLUGIN_ROOT/scripts/focus.mjs" status` and report state, offering to start one.
With minutes and/or a task label: run `focus.mjs start <minutes> <label>`, confirm in one line when it ends, and what the hook will do (redirect drift, wrap-up at the end). During the session, keep the user on their task.
