import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readJournalTail, resolveProject } from "../src/core.mjs";
import { install } from "../src/install.mjs";

const PACKAGE_ROOT = process.cwd();

function withHome(run) {
  const home = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-install-"));
  try {
    return run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function configPath(home) {
  return path.join(home, ".config", "opencode", "opencode.json");
}

test("installs skill, commands, config entry, and DSH files", () =>
  withHome((home) => {
    fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
    fs.writeFileSync(configPath(home), JSON.stringify({ plugins: ["existing-plugin"] }), "utf8");

    const result = install({ home, packageRoot: PACKAGE_ROOT });
    assert.ok(result.actions.length > 0);

    const config = JSON.parse(fs.readFileSync(configPath(home), "utf8"));
    assert.deepEqual(config.plugins, ["existing-plugin", "handoff-anywhere"]);
    assert.equal(config.plugin, undefined);

    assert.ok(fs.existsSync(path.join(home, ".config", "opencode", "skills", "handoff-anywhere", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(home, ".config", "opencode", "command", "checkpoint.md")));
    assert.ok(fs.existsSync(path.join(home, ".config", "opencode", "command", "resume.md")));

    const agents = fs.readFileSync(path.join(home, ".config", "opencode", "AGENTS.md"), "utf8");
    assert.equal(agents.split("<!-- handoff-anywhere:begin -->").length, 2);

    const dshDir = path.join(home, ".handoff-anywhere", "dsh");
    assert.ok(fs.existsSync(path.join(dshDir, "hook.mjs")));
    assert.ok(fs.existsSync(path.join(dshDir, "core.mjs")));
    const hooks = JSON.parse(fs.readFileSync(path.join(dshDir, "hooks.json"), "utf8"));
    assert.ok(hooks.hooks.PostToolUse);
    assert.match(JSON.stringify(hooks), /hook\.mjs/);

    assert.ok(fs.existsSync(path.join(home, ".dsh", "skills", "handoff-anywhere", "SKILL.md")));
    assert.match(result.dshProfile, /configPath:/);
  }));

test("is idempotent", () =>
  withHome((home) => {
    install({ home, packageRoot: PACKAGE_ROOT });
    install({ home, packageRoot: PACKAGE_ROOT });

    const config = JSON.parse(fs.readFileSync(configPath(home), "utf8"));
    assert.equal(config.plugin.filter((entry) => entry === "handoff-anywhere").length, 1);
    const agents = fs.readFileSync(path.join(home, ".config", "opencode", "AGENTS.md"), "utf8");
    assert.equal(agents.split("<!-- handoff-anywhere:begin -->").length, 2);
  }));

test("creates a plugin array when no config exists", () =>
  withHome((home) => {
    install({ home, packageRoot: PACKAGE_ROOT });
    const config = JSON.parse(fs.readFileSync(configPath(home), "utf8"));
    assert.deepEqual(config.plugin, ["handoff-anywhere"]);
  }));

test("leaves an unparsable config untouched", () =>
  withHome((home) => {
    fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
    fs.writeFileSync(configPath(home), "{broken", "utf8");
    const result = install({ home, packageRoot: PACKAGE_ROOT });
    assert.equal(fs.readFileSync(configPath(home), "utf8"), "{broken");
    assert.ok(result.actions.some((action) => action.startsWith("skipped OpenCode config")));
  }));

test("installed DSH hook runs against a project", () =>
  withHome((home) => {
    install({ home, packageRoot: PACKAGE_ROOT });
    const project = path.join(home, "project");
    fs.mkdirSync(path.join(project, ".agent"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".agent", "HANDOFF.md"),
      "# Handoff\n\nUpdated: 2026-11-02T14:00:00+08:00\n\n## Goal\nShip it.\n\n## Next\n1. Test it.\n",
      "utf8",
    );

    const hook = path.join(home, ".handoff-anywhere", "dsh", "hook.mjs");
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        session_id: "s1",
        cwd: project,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: { exit_code: 0 },
      }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const journal = readJournalTail(resolveProject(project, { force: true }));
    assert.equal(journal.at(-1).tool, "Bash");
    assert.equal(journal.at(-1).status, "ok");
  }));

test("local install copies the plugin and skips the npm config entry", () =>
  withHome((home) => {
    const result = install({ home, packageRoot: PACKAGE_ROOT, local: true });
    assert.ok(result.actions.some((action) => action.includes("local OpenCode plugin")));

    const pluginDir = path.join(home, ".config", "opencode", "plugin");
    assert.ok(fs.existsSync(path.join(pluginDir, "handoff-anywhere.js")));
    assert.ok(fs.existsSync(path.join(pluginDir, "handoff-anywhere", "adapters", "opencode", "index.mjs")));
    assert.ok(fs.existsSync(path.join(pluginDir, "handoff-anywhere", "src", "core.mjs")));
    assert.equal(fs.existsSync(configPath(home)), false);

    const shim = fs.readFileSync(path.join(pluginDir, "handoff-anywhere.js"), "utf8");
    assert.match(shim, /\.\/handoff-anywhere\/adapters\/opencode\/index\.mjs/);
  }));

test("CLI install works when launched from the home directory", () =>
  withHome((home) => {
    const cli = path.join(PACKAGE_ROOT, "bin", "handoff-anywhere.mjs");
    const result = spawnSync(process.execPath, [cli, "install"], {
      cwd: home,
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /configPath:/);
    assert.ok(fs.existsSync(configPath(home)));
  }));
