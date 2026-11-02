import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { HandoffAnywhere } from "../adapters/opencode/index.mjs";
import { readJournalTail, resolveProject } from "../src/core.mjs";

async function withProject(run) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-opencode-"));
  try {
    return await run({ root, paths: resolveProject(root, { force: true }) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeHandoff(root) {
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "HANDOFF.md"),
    `# Handoff

Updated: 2026-11-02T14:00:00+08:00
Session: opencode/s1
Status: in-progress

## Goal
Finish the token refresh fix.

## Next
1. Fix the refresh assertion
`,
    "utf8",
  );
}

test("records session, tools, failure, and idle", () =>
  withProject(async ({ root, paths }) => {
    const hooks = await HandoffAnywhere({ directory: root });
    assert.ok(hooks.event);

    await hooks.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } });
    await hooks["tool.execute.after"](
      { tool: "edit", sessionID: "s1", callID: "c1", args: { filePath: path.join(root, "src/a.ts") } },
      { metadata: {} },
    );
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: "s1", callID: "c2", args: { command: "npm test" } },
      { metadata: { exitCode: 1, stderr: "boom" } },
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });

    const events = readJournalTail(paths);
    assert.deepEqual(events.map((event) => event.type), ["session_start", "tool", "tool", "idle"]);
    assert.equal(events[1].path, "src/a.ts");
    assert.equal(events[2].status, "failed");
    assert.equal(events[2].cmd, "npm test");
  }));

test("does not journal writes to .agent", () =>
  withProject(async ({ root, paths }) => {
    const hooks = await HandoffAnywhere({ directory: root });
    await hooks["tool.execute.after"](
      { tool: "edit", sessionID: "s1", callID: "c1", args: { filePath: path.join(root, ".agent/HANDOFF.md") } },
      { metadata: {} },
    );
    assert.equal(readJournalTail(paths).length, 0);
  }));

test("records session errors", () =>
  withProject(async ({ root, paths }) => {
    const hooks = await HandoffAnywhere({ directory: root });
    await hooks.event({
      event: { type: "session.error", properties: { sessionID: "s1", error: { message: "rate limit exceeded" } } },
    });
    const last = readJournalTail(paths).at(-1);
    assert.equal(last.type, "error");
    assert.equal(last.status, "failed");
    assert.match(last.err, /rate limit/);
  }));

test("injects the resume card once per session", () =>
  withProject(async ({ root }) => {
    writeHandoff(root);
    const hooks = await HandoffAnywhere({ directory: root });

    const first = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, first);
    assert.equal(first.system.length, 2);
    assert.match(first.system[1], /handoff-anywhere/);
    assert.match(first.system[1], /Finish the token refresh fix/);

    const second = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, second);
    assert.equal(second.system.length, 1);
  }));

test("adds state context during compaction", () =>
  withProject(async ({ root }) => {
    writeHandoff(root);
    const hooks = await HandoffAnywhere({ directory: root });
    const output = { context: [] };
    await hooks["experimental.session.compacting"]({ sessionID: "s1" }, output);
    assert.match(output.context[0], /handoff-anywhere state/);
    assert.match(output.context[0], /\.agent\/HANDOFF\.md/);
  }));

test("OFF disables journaling and card injection", () =>
  withProject(async ({ root, paths }) => {
    writeHandoff(root);
    fs.writeFileSync(paths.offPath, "");
    const hooks = await HandoffAnywhere({ directory: root });
    await hooks["tool.execute.after"](
      { tool: "edit", sessionID: "s1", callID: "c1", args: { filePath: "src/a.ts" } },
      { metadata: {} },
    );
    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, output);
    assert.equal(readJournalTail(paths).length, 0);
    assert.equal(output.system.length, 0);
  }));
