# handoff-anywhere

Cross-agent project progress that survives rate limits, context resets, and agent switches.

Your agent hits a rate limit mid-task. You open the same project in another harness. Normally the new agent starts blind: it rereads files, re-asks what you wanted, and repeats work. `handoff-anywhere` leaves two small files in the project so any agent can pick up in one read.

- **No git required.** Target projects stay untouched.
- **No extra LLM calls.** The journal is written by the harness, not the model.
- **No daemon, MCP server, database, or cloud.** Just files.
- **Two harnesses first:** [OpenCode](https://opencode.ai) (native plugin) and [DeepSeek Harness / DSH](https://github.com/deepseek-ai/deepseek-harness) (Claude Code-style hooks).

[繁體中文說明](README.zh-TW.md) · [DSH setup details](adapters/dsh/README.md)

---

## Why

An agent keeps its plan in context. When that context disappears — rate limit, crash, compaction, switching from OpenCode to DSH — the plan disappears with it. The next agent sees the files but not the intent: what was tried, what failed, and what should happen next.

`handoff-anywhere` separates the two kinds of state:

| File | Written by | Holds | Cost |
|---|---|---|---|
| `.agent/journal.jsonl` | harness (plugin/hook) | what happened, one line per tool call | ~0, no model call |
| `.agent/HANDOFF.md` | agent, at task boundaries | goal, decisions, next step | one small write |

On the next session, a resume card (≤ 12 lines) is injected automatically. Full details stay on disk and are read only when needed.

## How it works

```text
target project/
  .agent/
    HANDOFF.md       # agent-written intent, max 80 lines
    journal.jsonl    # harness-written, append-only
    OFF              # optional: disable this project
    .seen/           # internal: one-shot card injection markers
```

Journal event:

```json
{"ts":"2026-11-02T14:01:40+08:00","session":"opencode:abc123","agent":"opencode","type":"tool","tool":"bash","cmd":"npm test","status":"failed","err":"2 tests failed: token refresh"}
```

Resume card:

```text
[handoff-anywhere] Last session 2026-11-02 14:02 (3h ago, opencode, interrupted)
Goal: Finish the token refresh fix.
Last: bash `npm test` (failed: 2 tests failed: token refresh)
Next: Fix the refresh assertion in test/auth.test.ts
Note: HANDOFF.md is older than the journal; trust the journal tail for details.
Details: .agent/HANDOFF.md
```

`interrupted` means the last recorded event was not a normal idle/stop, which is exactly what a rate-limit kill looks like.

## Install

Node >= 20.

### From a clone (works before the npm release)

```bash
git clone <this-repo> handoff-anywhere
cd handoff-anywhere
node bin/handoff-anywhere.mjs install --local
```

`--local` copies the plugin into `~/.config/opencode/plugin/`, so no npm publish is needed.

### From npm (after the package is published)

```bash
npx handoff-anywhere install
```

Either command is idempotent and only touches the paths listed below. It backs up `opencode.json` before editing it.

| Path | What |
|---|---|
| `~/.config/opencode/skills/handoff-anywhere/` | the skill |
| `~/.config/opencode/command/` | `/checkpoint`, `/resume` |
| `~/.config/opencode/opencode.json` | plugin entry (npm install only) |
| `~/.config/opencode/plugin/` | local plugin copy (`--local` only) |
| `~/.config/opencode/AGENTS.md` | a marked rules block |
| `~/.handoff-anywhere/dsh/` | `hook.mjs`, `core.mjs`, `hooks.json` |
| `~/.dsh/skills/handoff-anywhere/` | the skill |
| `~/.dsh/AGENTS.md` | a marked rules block |

The installer prints the DSH profile snippet but does not edit your DSH profile.

### DSH profile

Add the printed snippet to the plugin list in your DSH profile:

```yaml
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: C:/Users/<you>/.handoff-anywhere/dsh/hooks.json
    projectDir: .
```

Restart DSH afterwards: the bridge reads `configPath` once at process start.

See [adapters/dsh/README.md](adapters/dsh/README.md) for hook payload details and limitations.

## Daily use

- **Normal sessions:** nothing. The plugin/hook writes the journal.
- **Task finished:** the agent updates `.agent/HANDOFF.md` (AGENTS.md rule + skill).
- **Rate limit or switch agents:** open the project in the other harness. The card appears on the first prompt.
- **Manual:** `/checkpoint`, `/resume`, or `npx handoff-anywhere status`.
- **Disable one project:** `npx handoff-anywhere off` (creates `.agent/OFF`, stops all writes). `on` removes it.

Auto-setup is skipped in the home directory, temp directories, and drive roots. Existing projects do not need to be git repositories.

## Privacy

- Tool output, file contents, prompts, and model replies are never written.
- Only the tool name, project-relative path, command (truncated to 300 chars), status, and a truncated error summary are journaled.
- Sensitive paths are skipped entirely: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/`, `.aws/`, `credentials*`, and similar.
- Common token shapes (`sk-…`, `ghp_…`, `github_pat_…`, `AKIA…`, `Bearer …`, `api_key=…`) are redacted.
- Everything stays on this machine, inside the project.

`.agent/` can contain project names and error text. Add it to your global gitignore if a target project is versioned.

## Limits

- Same machine only. No sync, no multi-user coordination.
- Two harnesses are supported. Other adapters are welcome but not promised.
- DSH support depends on the experimental `@deepseek-ai/dsh-hooks-claude-code` bridge. If it breaks, the skill and AGENTS.md rules still work manually.
- The plugin uses `experimental.chat.system.transform` and `experimental.session.compacting`; if OpenCode changes them, card injection degrades but journaling keeps working.
- Multiple sessions on one project share a journal; events carry a session field, but `HANDOFF.md` is last-writer-wins.
- No uninstall command. Remove the files listed above and the `handoff-anywhere` plugin entry.

## Development

```bash
npm test          # node --test, no dependencies
npm pack --dry-run
```

Layout:

```text
src/core.mjs              shared journal, card, redaction, path guards
src/install.mjs           installer
adapters/opencode/        OpenCode plugin
adapters/dsh/             DSH hook + docs
skills/handoff-anywhere/  agent-facing skill
commands/                 /checkpoint and /resume
test/                     unit + acceptance tests
```

## License

MIT. See [LICENSE](LICENSE).
