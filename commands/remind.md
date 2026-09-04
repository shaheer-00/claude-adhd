---
description: Set or manage custom reminders that surface in Claude Code while you work
argument-hint: <message> [at <time> | every session|day | random]
---

Invoke the `remind-me` skill and follow its **Reminders** section.

With no argument: list active reminders and offer to change or remove any.
With a message: record a reminder. Determine the trigger from the user's wording — a time ("tomorrow 3pm", "in 2 hours"), recurring ("every session", "every day"), or occasional ("occasionally", "surprise me") — and pass it as the right flag to `remind.mjs add`.
