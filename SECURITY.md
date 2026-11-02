# Security

`handoff-anywhere` stores progress inside the project's `.agent/` directory and never sends it anywhere.

## What is stored

- Tool name, project-relative path, command (max 300 chars), status, truncated error summary (max 200 chars).
- The `HANDOFF.md` file written by the agent.
- No tool output, file contents, prompts, model replies, or environment variables.

Common token shapes are redacted, and sensitive paths (`.env*`, keys, `.ssh/`, `.aws/`, credentials files, …) are skipped before an event is built.

## Residual risk

`.agent/` can still contain project names, file paths, and error text. If that is sensitive:

- Add `.agent/` to the project's or your global gitignore.
- Disable the project with `.agent/OFF` or `handoff-anywhere off`.
- Delete `.agent/` when handing the machine or project to someone else.

A redaction pattern can miss an unusual secret format. Do not run the tool on projects where any local file path or command line is itself classified.

## Reporting

Open a private security advisory on the GitHub repository, or contact the maintainers listed there. Do not paste real tokens or proprietary paths into a public issue.

Include the version, harness (OpenCode or DSH), and a minimal reproduction with fake data.
