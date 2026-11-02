import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendDebug,
  appendEvent,
  buildCard,
  cleanSeen,
  ensureState,
  isAutoStateAllowed,
  isSensitivePath,
  nowIso,
  parseHandoff,
  readJournalTail,
  redact,
  resolveProject,
  rotateIfNeeded,
} from "../src/core.mjs";

function withProject(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-anywhere-"));
  const paths = resolveProject(root, { force: true });
  ensureState(paths);
  try {
    return run({ root, paths });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeHandoff(paths, { updated = "2026-11-02T14:00:00+08:00", status = "in-progress", next = "Fix the refresh assertion" } = {}) {
  fs.writeFileSync(
    paths.handoffPath,
    `# Handoff

Updated: ${updated}
Session: opencode/abc123
Status: ${status}

## Goal
Finish the token refresh fix.

## Done
- Added refresh branch.

## In Progress
- Token refresh test fails.

## Next
1. ${next}
2. Run the auth suite.

## Decisions
- Refresh in place; no rotation.

## Blockers / Dead Ends
(none)

## Files
- src/auth.ts — refresh branch

## Do Not Touch
- config/prod.json
`,
    "utf8",
  );
}

test("nowIso uses a local offset", () => {
  assert.match(nowIso(new Date("2026-11-02T06:03:00Z")), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test("redact masks common token shapes and leaves prose alone", () => {
  const raw = [
    "key sk-abcdefghijklmnop1234 end",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer abcdefghijk12345",
    "api_key=supersecret",
    "password: hunter2",
  ].join("\n");
  const clean = redact(raw);
  assert.ok(!clean.includes("sk-abcdefghijklmnop1234"));
  assert.ok(!clean.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(!clean.includes("abcdefghijk12345"));
  assert.ok(!clean.includes("supersecret"));
  assert.ok(!clean.includes("hunter2"));
  assert.equal(redact("the token refresh test fails"), "the token refresh test fails");
});

test("sensitive paths are recognized", () => {
  for (const file of [".env", "config/.env.local", "certs/server.pem", "id_rsa", ".ssh/config", "credentials.json", "app.key"]) {
    assert.equal(isSensitivePath(file), true, file);
  }
  for (const file of ["src/auth.ts", "docs/environment.md", "src/tokenizer.ts"]) {
    assert.equal(isSensitivePath(file), false, file);
  }
});

test("auto state is blocked at home, temp, and drive roots", () => {
  const home = path.join(os.tmpdir(), "fake-home");
  const tmp = path.join(os.tmpdir(), "fake-tmp");
  assert.equal(isAutoStateAllowed(home, { home, tmp }), false);
  assert.equal(isAutoStateAllowed(path.join(home, "proj"), { home, tmp }), true);
  assert.equal(isAutoStateAllowed(tmp, { home, tmp }), false);
  assert.equal(isAutoStateAllowed(path.join(tmp, "proj"), { home, tmp }), false);
  assert.equal(isAutoStateAllowed(path.parse(process.cwd()).root, { home, tmp }), false);
  assert.equal(resolveProject(home, { home, tmp }), null);
  assert.ok(resolveProject(home, { home, tmp, force: true }));
});

test("appendEvent writes relative paths and normalizes the session", () =>
  withProject(({ paths }) => {
    assert.equal(appendEvent(paths, { agent: "opencode", session: "abc", type: "tool", tool: "edit", path: "src/auth.ts" }), true);
    assert.equal(appendEvent(paths, { agent: "opencode", session: "abc", type: "tool", tool: "bash", cmd: "npm test", status: "failed", err: "2 tests failed" }), true);
    const lines = fs.readFileSync(paths.journalPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.session, "opencode:abc");
    assert.equal(first.path, "src/auth.ts");
    const second = JSON.parse(lines[1]);
    assert.equal(second.status, "failed");
    assert.equal(second.cmd, "npm test");
  }));

test("OFF disables writes", () =>
  withProject(({ paths }) => {
    fs.writeFileSync(paths.offPath, "");
    assert.equal(appendEvent(paths, { agent: "opencode", session: "abc", type: "tool", tool: "edit", path: "a.ts" }), false);
    assert.equal(fs.existsSync(paths.journalPath), false);
  }));

test("sensitive paths are not journaled", () =>
  withProject(({ paths }) => {
    assert.equal(appendEvent(paths, { agent: "opencode", session: "abc", type: "tool", tool: "read", path: ".env" }), false);
    assert.equal(appendEvent(paths, { agent: "opencode", session: "abc", type: "tool", tool: "read", path: "src/a.ts" }), true);
    assert.equal(readJournalTail(paths).length, 1);
  }));

test("callID dedupes repeated hook payloads", () =>
  withProject(({ paths }) => {
    const event = { agent: "dsh", session: "s1", type: "tool", tool: "edit", path: "a.ts", callID: "call-1" };
    assert.equal(appendEvent(paths, event), true);
    assert.equal(appendEvent(paths, event), false);
    assert.equal(readJournalTail(paths).length, 1);
  }));

test("journal tail drops a partial first line and skips malformed lines", () =>
  withProject(({ paths }) => {
    const lines = [];
    for (let index = 0; index < 50; index += 1) {
      lines.push(JSON.stringify({ ts: nowIso(), session: "opencode:x", agent: "opencode", type: "tool", tool: "read", path: `f${index}.ts` }));
    }
    lines.splice(25, 0, "{not json");
    fs.writeFileSync(paths.journalPath, `${lines.join("\n")}\n`);
    const tail = readJournalTail(paths, 600);
    assert.ok(tail.length > 0);
    assert.ok(tail.length < 50);
    assert.ok(tail.every((event) => event.tool === "read"));
  }));

test("journal and handoff tolerate a UTF-8 BOM", () =>
  withProject(({ paths }) => {
    fs.writeFileSync(
      paths.journalPath,
      `\uFEFF${JSON.stringify({ ts: nowIso(), session: "opencode:x", agent: "opencode", type: "tool", tool: "read", path: "a.ts" })}\n`,
    );
    assert.equal(readJournalTail(paths).length, 1);
    fs.writeFileSync(paths.handoffPath, "\uFEFF# Handoff\n\nUpdated: 2026-11-02T14:00:00+08:00\n\n## Goal\nFinish it.\n");
    assert.equal(parseHandoff(fs.readFileSync(paths.handoffPath, "utf8")).goal, "Finish it.");
  }));

test("rotation keeps at most `keep` archives", () =>
  withProject(({ paths }) => {
    fs.writeFileSync(paths.journalPath, "x".repeat(100));
    assert.equal(rotateIfNeeded(paths, { maxBytes: 10, keep: 2 }), true);
    assert.equal(fs.existsSync(paths.journalPath), false);
    assert.equal(fs.existsSync(`${paths.journalPath}.1`), true);
    fs.writeFileSync(paths.journalPath, "y".repeat(100));
    rotateIfNeeded(paths, { maxBytes: 10, keep: 2 });
    assert.equal(fs.existsSync(`${paths.journalPath}.1`), true);
    assert.equal(fs.existsSync(`${paths.journalPath}.2`), true);
    assert.equal(fs.existsSync(`${paths.journalPath}.3`), false);
    fs.writeFileSync(paths.journalPath, "z".repeat(100));
    rotateIfNeeded(paths, { maxBytes: 10, keep: 2 });
    assert.equal(fs.existsSync(`${paths.journalPath}.2`), true);
    assert.equal(fs.existsSync(`${paths.journalPath}.3`), false);
  }));

test("parseHandoff extracts metadata and the first next action", () => {
  const parsed = parseHandoff(`# Handoff

Updated: 2026-11-02T14:00:00+08:00
Session: opencode/abc
Status: blocked

## Goal
Finish the fix.

## Next
1. Fix the assertion
2. Run tests

## Files
- src/a.ts — changed
`);
  assert.equal(parsed.updated, "2026-11-02T14:00:00+08:00");
  assert.equal(parsed.status, "blocked");
  assert.equal(parsed.goal, "Finish the fix.");
  assert.equal(parsed.next, "Fix the assertion");
});

test("buildCard returns null with no state", () =>
  withProject(({ paths }) => {
    assert.equal(buildCard(paths), null);
  }));

test("buildCard describes an interrupted task and its last failure", () =>
  withProject(({ paths }) => {
    writeHandoff(paths);
    appendEvent(paths, {
      agent: "opencode",
      session: "abc123",
      type: "tool",
      tool: "bash",
      cmd: "npm test",
      status: "failed",
      err: "2 tests failed: token refresh",
      ts: "2026-11-02T14:02:00+08:00",
    });
    const card = buildCard(paths, { now: Date.parse("2026-11-02T17:00:00+08:00") });
    assert.match(card, /interrupted/);
    assert.match(card, /Goal: Finish the token refresh fix\./);
    assert.match(card, /bash `npm test` \(failed: 2 tests failed: token refresh\)/);
    assert.match(card, /Next: Fix the refresh assertion/);
    assert.match(card, /HANDOFF\.md is older than the journal/);
    assert.ok(card.split("\n").length <= 12);
  }));

test("buildCard says idle when the last event is idle", () =>
  withProject(({ paths }) => {
    writeHandoff(paths);
    appendEvent(paths, { agent: "opencode", session: "abc123", type: "tool", tool: "edit", path: "src/auth.ts", ts: "2026-11-02T14:01:00+08:00" });
    appendEvent(paths, { agent: "opencode", session: "abc123", type: "idle", ts: "2026-11-02T14:02:00+08:00" });
    const card = buildCard(paths, { now: Date.parse("2026-11-02T14:10:00+08:00") });
    assert.match(card, /idle/);
    assert.doesNotMatch(card, /interrupted/);
  }));

test("buildCard works from the journal alone", () =>
  withProject(({ paths }) => {
    appendEvent(paths, { agent: "dsh", session: "s1", type: "tool", tool: "edit", path: "src/a.ts", ts: "2026-11-02T14:01:00+08:00" });
    const card = buildCard(paths, { now: Date.parse("2026-11-02T14:10:00+08:00") });
    assert.match(card, /No HANDOFF\.md/);
    assert.match(card, /edit src\/a\.ts/);
    assert.match(card, /Details: \.agent\/journal\.jsonl/);
  }));

test("buildCard flags a blocked handoff", () =>
  withProject(({ paths }) => {
    writeHandoff(paths, { status: "blocked" });
    appendEvent(paths, { agent: "opencode", session: "abc123", type: "idle" });
    const card = buildCard(paths);
    assert.match(card, /Status: blocked/);
  }));

test("cleanSeen removes old markers only", () =>
  withProject(({ paths }) => {
    const oldFile = path.join(paths.seenDir, "old");
    const newFile = path.join(paths.seenDir, "new");
    fs.writeFileSync(oldFile, "");
    fs.writeFileSync(newFile, "");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, old, old);
    assert.equal(cleanSeen(paths), 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(newFile), true);
  }));

test("appendDebug truncates the message and never throws", () =>
  withProject(({ paths }) => {
    assert.equal(appendDebug(paths, "x".repeat(500)), true);
    const lines = fs.readFileSync(paths.debugPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].length < 260);
  }));
