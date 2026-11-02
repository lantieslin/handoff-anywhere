---
name: handoff-anywhere
description: Save or resume cross-agent project progress in .agent/HANDOFF.md and .agent/journal.jsonl. Use when the user says checkpoint, handoff, save progress, hand off, resume, continue, pick up where we left off, or asks what was in progress after a rate limit, context reset, or agent switch.
license: MIT
---

# handoff-anywhere

Project progress lives in two files inside the project:

- `.agent/HANDOFF.md` — semantic state, written by you at task boundaries, max 80 lines.
- `.agent/journal.jsonl` — append-only machine log, written by the harness. Never edit it.

Pick one mode: `checkpoint`, `resume`, or `status`.

## checkpoint

Use when a user-requested task is finished, before a long or risky operation, or when the user asks to save progress.

1. Read `.agent/journal.jsonl` tail only if you need the recent actions (last ~10 lines). Do not read the whole file.
2. Read the existing `.agent/HANDOFF.md` if present.
3. Rewrite `.agent/HANDOFF.md` with exactly these sections, in this order:

```markdown
# Handoff

Updated: <ISO-8601 with offset>
Session: <agent>/<session id if known>
Status: in-progress | done | blocked

## Goal
One or two sentences: what this project must achieve.

## Done
- Results only, no diffs.

## In Progress
- What is being worked on and where it is stuck.

## Next
1. The next concrete action, executable as written.
2. The one after that.

## Decisions
- What was decided and why. Do not restate code.

## Blockers / Dead Ends
- Failed approaches and error summaries.

## Files
- path/to/file — what changed

## Do Not Touch
- Files or settings that must not be changed.
```

Rules:

- Keep it at or below 80 lines. Delete stale detail; keep conclusions.
- Never paste full diffs, logs, transcripts, or file contents. Reference paths and commands.
- Never write secrets, tokens, passwords, or personal data.
- Use paths relative to the project root. Use the user's language for prose; keep section names in English.
- If a section has nothing, keep the heading and write `(none)` so the next agent knows it was considered.
- Journal is the source of truth for what happened; HANDOFF is the source of truth for intent and next steps.

Output after saving: one line confirming the file was updated, plus the first item under `Next`.

## resume

Use when the user says continue, resume, pick up, or after a rate limit or agent switch.

1. Read the resume card if it was injected. Otherwise read `.agent/HANDOFF.md` and the last ~10 lines of `.agent/journal.jsonl`.
2. If HANDOFF and journal disagree, trust the journal for what happened and HANDOFF for intent. State the conflict explicitly.
3. Verify only the paths listed under `Files` still exist, using the read/list tools. Do not scan the codebase.
4. Output exactly this shape, then stop and ask before changing files:

```
Situation: <one or two lines>
Last action: <tool + path/command + result>
Interrupted: yes | no | unknown
Next step: <one concrete action>
Questions: <only if the next step is ambiguous; otherwise omit>
```

5. If there is no state at all, say `No handoff state found.` and ask what to work on. Do not invent progress.
6. Do not re-run expensive commands until the user confirms.

## status

Use when the user asks for progress without continuing.

- Output the resume card, plus `Status` and the first `Next` item from HANDOFF.
- Do not read other files.

## Boundaries

- Do not call this skill on every turn. Checkpoint at task boundaries only.
- Do not create `.agent/` yourself unless the harness has not done it; the plugin normally creates it.
- Do not modify `.agent/journal.jsonl`.
- Do not copy this file's contents into HANDOFF.md.
