# DSH adapter

`handoff-anywhere` supports [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through the experimental [`@deepseek-ai/dsh-hooks-claude-code`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/experimental/hooks-claude-code) bridge. No native Cordis plugin is required.

## What gets installed

```text
~/.handoff-anywhere/dsh/
  hook.mjs       # reads one JSON payload from stdin
  core.mjs       # copy of src/core.mjs, so the hook has no package dependency
  hooks.json     # hook registration for the bridge

~/.dsh/skills/handoff-anywhere/SKILL.md
~/.dsh/AGENTS.md   # marked rules block (appended once)
```

## Profile

`handoff-anywhere install` prints the snippet; paste it into the plugin list in your DSH profile:

```yaml
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: C:/Users/<you>/.handoff-anywhere/dsh/hooks.json
    projectDir: .
```

Use forward slashes in `configPath`, even on Windows.

**Restart DSH after installing or changing `hooks.json`.** The bridge reads `configPath` once at process start; editing the file does not affect a running process.

## Hook mapping

| Hook | What the hook does | Output |
|---|---|---|
| `SessionStart` | Creates `.agent/`, rotates a > 1 MB journal, cleans old `.seen` markers, appends `session_start` | none |
| `UserPromptSubmit` | On the first prompt of a session, injects the resume card | `hookSpecificOutput.additionalContext` |
| `PostToolUse` | Appends one `tool` event: tool name, path, command, status, error summary | none |
| `Stop` | Appends `idle`; never blocks or forces another turn | none |

`UserPromptSubmit` is used for card injection instead of `SessionStart` because the bridge runs `SessionStart` detached and it may arrive after the first prompt.

Every path exits 0. Malformed JSON, missing fields, a missing project, and I/O errors are swallowed (and logged to `.agent/.debug.log`), so a broken hook never blocks the agent.

## Payload notes

The hook matches Claude Code's command-hook payload shape:

```json
{
  "session_id": "abc",
  "cwd": "D:/work/my-project",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "tool_response": "…",
  "tool_use_id": "toolu_01…"
}
```

- `cwd` decides the project root. If it is missing, `process.cwd()` is used.
- `tool_response` from this bridge is a **string**, not an object, so exit codes are unavailable. The hook treats a response as failed when it starts with `Error`/`Failed`/`Failure`, contains `exit code N` / `exit status N` (N ≥ 1), or contains a line starting with `FAIL`. This is a heuristic; an unusual tool that returns failure text differently may be recorded as `ok`/unknown.
- `tool_use_id` dedupes repeated deliveries.
- The bridge logs but ignores `updatedInput`; this adapter never returns it.

## Manual test

From a project directory:

```bash
node -e "process.stdout.write(JSON.stringify({session_id:'t',cwd:process.cwd(),hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'echo hi'},tool_response:{exit_code:0}}))" | node ~/.handoff-anywhere/dsh/hook.mjs
```

Then check `.agent/journal.jsonl`.

To verify card injection:

```bash
node -e "process.stdout.write(JSON.stringify({session_id:'t2',cwd:process.cwd(),hook_event_name:'UserPromptSubmit',prompt:'continue'}))" | node ~/.handoff-anywhere/dsh/hook.mjs
```

It prints one JSON object on the first call and nothing on the next call in the same session.

## Limitations

- The bridge is **experimental** and may change with DSH. If it stops working, the skill and `~/.dsh/AGENTS.md` rules remain usable manually; journaling stops until the bridge is fixed.
- `SessionStart` is detached, so its `session_start` event may be written slightly after the first prompt.
- Only `PostToolUse` is used. There is no pre-tool event, so a tool that is interrupted mid-call (including by a rate limit) has no journal line. The previous line is still there, which is enough to show where work stopped.
- No MCP, no network, no model calls.
- Do not point `configPath` at the repo's `adapters/dsh/hooks.json`; the installer generates absolute paths in `~/.handoff-anywhere/dsh/hooks.json`.

## Disable or remove

- One project: create `.agent/OFF` (or run `handoff-anywhere off`). Every hook becomes a no-op.
- Globally: remove the plugin entry from your DSH profile, then delete `~/.handoff-anywhere/dsh/`, `~/.dsh/skills/handoff-anywhere/`, and the marked block in `~/.dsh/AGENTS.md`.
