import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readJournalTail, resolveProject } from "../src/core.mjs";

const HOOK = path.join(process.cwd(), "adapters", "dsh", "hook.mjs");

async function withProject(run) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-dsh-"));
  try {
    return await run({ root, paths: resolveProject(root, { force: true }) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runHook(payload) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
}

function handoff(root) {
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "HANDOFF.md"),
    `# Handoff

Updated: 2026-11-02T14:00:00+08:00
Session: dsh/s1
Status: in-progress

## Goal
Finish the token refresh fix.

## Next
1. Fix the refresh assertion
`,
    "utf8",
  );
}

test("PostToolUse journals the tool and its failure", () =>
  withProject(({ root, paths }) => {
    const result = runHook({
      session_id: "s1",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { exit_code: 1, stderr: "boom" },
    });
    assert.equal(result.status, 0);
    const last = readJournalTail(paths).at(-1);
    assert.equal(last.tool, "Bash");
    assert.equal(last.cmd, "npm test");
    assert.equal(last.status, "failed");
    assert.equal(last.err, "boom");
  }));

test("PostToolUse treats an error-shaped string response as failure", () =>
  withProject(({ root, paths }) => {
    runHook({
      session_id: "s1",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "Error: command failed with exit code 1",
    });
    const last = readJournalTail(paths).at(-1);
    assert.equal(last.status, "failed");
    assert.match(last.err, /Error: command failed/);
  }));

test("PostToolUse skips .agent and SessionStart records a marker", () =>
  withProject(({ root, paths }) => {
    const before = readJournalTail(paths).length;
    runHook({
      session_id: "s1",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(root, ".agent/HANDOFF.md") },
      tool_response: {},
    });
    assert.equal(readJournalTail(paths).length, before);

    runHook({ session_id: "s1", cwd: root, hook_event_name: "SessionStart" });
    assert.equal(readJournalTail(paths).at(-1).type, "session_start");
  }));

test("UserPromptSubmit injects the card once", () =>
  withProject(({ root }) => {
    handoff(root);
    const first = runHook({
      session_id: "s1",
      cwd: root,
      hook_event_name: "UserPromptSubmit",
      prompt: "continue",
    });
    assert.equal(first.status, 0);
    const parsed = JSON.parse(first.stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Finish the token refresh fix/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /handoff-anywhere/);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");

    const second = runHook({
      session_id: "s1",
      cwd: root,
      hook_event_name: "UserPromptSubmit",
      prompt: "continue again",
    });
    assert.equal(second.status, 0);
    assert.equal(second.stdout.trim(), "");
  }));

test("Stop records idle", () =>
  withProject(({ root, paths }) => {
    runHook({ session_id: "s1", cwd: root, hook_event_name: "Stop" });
    assert.equal(readJournalTail(paths).at(-1).type, "idle");
  }));

test("malformed input exits cleanly", () =>
  withProject(({ root }) => {
    const result = runHook("{not json");
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.trim(), "");
  }));
