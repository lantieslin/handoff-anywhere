import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { appendEvent, buildCard, ensureState, nowIso, readJournalTail, resolveProject } from "../src/core.mjs";

function withProject(run) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-acceptance-"));
  try {
    return run({ root, paths: resolveProject(root, { force: true }) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeHandoff(paths, { updated = "2026-11-02T14:00:00+08:00", next = "Fix the refresh assertion in test/auth.test.ts" } = {}) {
  ensureState(paths);
  fs.writeFileSync(
    paths.handoffPath,
    `# Handoff

Updated: ${updated}
Session: opencode/abc123
Status: in-progress

## Goal
Finish the token refresh fix.

## Done
- Added the refresh branch.

## In Progress
- The refresh test still fails.

## Next
1. ${next}
2. Run the auth suite.

## Decisions
- Refresh in place; no rotation.

## Blockers / Dead Ends
- Rotating tokens broke the session cookie.

## Files
- src/auth.ts — refresh branch
- test/auth.test.ts — new cases

## Do Not Touch
- config/prod.json
`,
    "utf8",
  );
}

/** 20 tool calls, then the process dies without writing an idle event. */
function simulateInterruption(paths) {
  for (let index = 0; index < 18; index += 1) {
    appendEvent(paths, {
      agent: "opencode",
      session: "abc123",
      type: "tool",
      tool: "edit",
      path: `src/module${index}.ts`,
      status: "ok",
      ts: `2026-11-02T14:00:${String(index).padStart(2, "0")}+08:00`,
    });
  }
  appendEvent(paths, {
    agent: "opencode",
    session: "abc123",
    type: "tool",
    tool: "edit",
    path: "src/auth.ts",
    status: "ok",
    ts: "2026-11-02T14:01:00+08:00",
  });
  appendEvent(paths, {
    agent: "opencode",
    session: "abc123",
    type: "tool",
    tool: "bash",
    cmd: "npm test",
    status: "failed",
    err: "2 tests failed: token refresh",
    ts: "2026-11-02T14:01:30+08:00",
  });
}

test("acceptance: a killed task resumes from the last file, failure, and next step", () =>
  withProject(({ paths }) => {
    writeHandoff(paths);
    simulateInterruption(paths);

    const card = buildCard(paths, { now: Date.parse("2026-11-02T17:00:00+08:00") });
    assert.match(card, /interrupted/);
    assert.match(card, /Goal: Finish the token refresh fix\./);
    assert.match(card, /edit src\/auth\.ts -> bash `npm test` \(failed: 2 tests failed: token refresh\)/);
    assert.match(card, /Next: Fix the refresh assertion in test\/auth\.test\.ts/);
    assert.match(card, /Details: \.agent\/HANDOFF\.md/);
  }));

test("acceptance: resume reads stay inside the token budget", () =>
  withProject(({ paths }) => {
    writeHandoff(paths);
    simulateInterruption(paths);

    const card = buildCard(paths, { now: Date.parse("2026-11-02T17:00:00+08:00") });
    assert.ok(card.length <= 1000, `card is ${card.length} chars (budget 1000 ≈ 250 tokens)`);

    // Full resume = HANDOFF.md (max 80 lines) + the last 10 journal lines.
    const handoffLines = fs.readFileSync(paths.handoffPath, "utf8").trim().split("\n");
    assert.ok(handoffLines.length <= 80);
    const tail = readJournalTail(paths).slice(-10);
    const full = `${fs.readFileSync(paths.handoffPath, "utf8")}\n${tail.map((event) => JSON.stringify(event)).join("\n")}`;
    assert.ok(full.length <= 6000, `full resume is ${full.length} chars (budget 6000 ≈ 1.5k tokens)`);
  }));

test("acceptance: a tool call stays cheap with a 1 MB journal", () =>
  withProject(({ paths }) => {
    ensureState(paths);
    const line = `${JSON.stringify({
      ts: nowIso(),
      session: "opencode:older",
      agent: "opencode",
      type: "tool",
      tool: "edit",
      path: "src/big.ts",
      status: "ok",
      callID: "old",
    })}\n`;
    fs.writeFileSync(paths.journalPath, line.repeat(Math.ceil((1024 * 1024) / line.length)), "utf8");
    assert.ok(fs.statSync(paths.journalPath).size >= 1024 * 1024);

    const started = performance.now();
    const count = 100;
    for (let index = 0; index < count; index += 1) {
      appendEvent(paths, {
        agent: "opencode",
        session: "new",
        type: "tool",
        tool: "edit",
        path: `src/new${index}.ts`,
        status: "ok",
        callID: `new-${index}`,
      });
    }
    const average = (performance.now() - started) / count;
    assert.ok(average < 50, `average append was ${average.toFixed(2)}ms (budget 50ms)`);
    assert.equal(readJournalTail(paths).at(-1).callID, "new-99");
  }));

test("acceptance: works in a project with no git repository", () =>
  withProject(({ root, paths }) => {
    assert.equal(fs.existsSync(path.join(root, ".git")), false);
    writeHandoff(paths);
    appendEvent(paths, { agent: "dsh", session: "s1", type: "tool", tool: "read", path: "src/a.ts" });
    assert.match(buildCard(paths), /src\/a\.ts/);
    assert.equal(fs.existsSync(path.join(root, ".git")), false);
  }));

test("acceptance: OFF stops all journal writes", () =>
  withProject(({ paths }) => {
    appendEvent(paths, { agent: "opencode", session: "s1", type: "tool", tool: "edit", path: "a.ts" });
    const before = fs.statSync(paths.journalPath).size;
    fs.writeFileSync(paths.offPath, "");
    assert.equal(appendEvent(paths, { agent: "opencode", session: "s1", type: "tool", tool: "edit", path: "b.ts" }), false);
    assert.equal(fs.statSync(paths.journalPath).size, before);
  }));

test("acceptance: harness code makes no network or model calls", () => {
  const files = [
    "src/core.mjs",
    "src/install.mjs",
    "adapters/opencode/index.mjs",
    "adapters/dsh/hook.mjs",
    "bin/handoff-anywhere.mjs",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(/, file);
    assert.doesNotMatch(source, /from\s+["']node:(http|https|net|dns|tls)["']/, file);
    assert.doesNotMatch(source, /@opencode-ai\/sdk|openai|anthropic/i, file);
  }
});
