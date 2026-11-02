import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER_START = "<!-- handoff-anywhere:begin -->";
const MARKER_END = "<!-- handoff-anywhere:end -->";

const AGENTS_SNIPPET = `${MARKER_START}
## handoff-anywhere
- When continuing work, read \`.agent/HANDOFF.md\` (Goal / Next) if it exists. A resume card may be injected automatically.
- When a user-requested task is finished, or before a long or risky step, update \`.agent/HANDOFF.md\` with the \`handoff-anywhere\` skill in checkpoint mode (max 80 lines).
- Never write secrets, full diffs, or full logs into \`.agent/\`.
${MARKER_END}
`;

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyDir(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function readJson(file) {
  if (!fs.existsSync(file)) return { config: {}, exists: false };
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  try {
    return { config: JSON.parse(text), exists: true };
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`);
  }
}

function registerPlugin(config) {
  const key = Array.isArray(config.plugins) ? "plugins" : "plugin";
  const list = Array.isArray(config[key]) ? config[key] : [];
  if (list.includes("handoff-anywhere")) return false;
  config[key] = [...list, "handoff-anywhere"];
  return true;
}

function appendSnippet(file) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current.includes(MARKER_START)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prefix = current.trim() ? `${current.trimEnd()}\n\n` : "";
  fs.writeFileSync(file, `${prefix}${AGENTS_SNIPPET}`, "utf8");
  return true;
}

function writeDshHooks(dshDir) {
  const hookPath = path.join(dshDir, "hook.mjs").replace(/\\/g, "/");
  const command = `"${process.execPath.replace(/\\/g, "/")}" "${hookPath}"`;
  const hooks = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
      PostToolUse: [{ hooks: [{ type: "command", command }] }],
      Stop: [{ hooks: [{ type: "command", command }] }],
    },
  };
  fs.writeFileSync(path.join(dshDir, "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
}

/**
 * Install handoff-anywhere into the user's harness config.
 * Every write is idempotent; the OpenCode config is backed up before editing.
 */
export function install({ home = os.homedir(), packageRoot = PACKAGE_ROOT, local = false } = {}) {
  const actions = [];
  const opencodeRoot = path.join(home, ".config", "opencode");
  const configFile = path.join(opencodeRoot, "opencode.json");
  const skillSource = path.join(packageRoot, "skills", "handoff-anywhere");
  const commandSource = path.join(packageRoot, "commands");
  const dshDir = path.join(home, ".handoff-anywhere", "dsh");

  copyDir(skillSource, path.join(opencodeRoot, "skills", "handoff-anywhere"));
  actions.push("copied skill to ~/.config/opencode/skills/handoff-anywhere");

  for (const name of ["checkpoint.md", "resume.md"]) {
    copyFile(path.join(commandSource, name), path.join(opencodeRoot, "command", name));
  }
  actions.push("copied /checkpoint and /resume commands");

  if (local) {
    const pluginRoot = path.join(opencodeRoot, "plugin", "handoff-anywhere");
    copyFile(
      path.join(packageRoot, "adapters", "opencode", "index.mjs"),
      path.join(pluginRoot, "adapters", "opencode", "index.mjs"),
    );
    copyFile(path.join(packageRoot, "src", "core.mjs"), path.join(pluginRoot, "src", "core.mjs"));
    fs.mkdirSync(path.join(opencodeRoot, "plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(opencodeRoot, "plugin", "handoff-anywhere.js"),
      'export { HandoffAnywhere as default } from "./handoff-anywhere/adapters/opencode/index.mjs";\n',
      "utf8",
    );
    actions.push("installed local OpenCode plugin (no npm publish needed)");
  } else {
    try {
      const { config, exists } = readJson(configFile);
      if (registerPlugin(config)) {
        if (exists) fs.copyFileSync(configFile, `${configFile}.bak`);
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        actions.push(`registered plugin in ${configFile}`);
      } else {
        actions.push("OpenCode plugin already registered");
      }
    } catch (error) {
      actions.push(`skipped OpenCode config: ${error.message}`);
    }
  }

  if (appendSnippet(path.join(opencodeRoot, "AGENTS.md"))) {
    actions.push("appended rules to ~/.config/opencode/AGENTS.md");
  }

  fs.mkdirSync(dshDir, { recursive: true });
  copyFile(path.join(packageRoot, "adapters", "dsh", "hook.mjs"), path.join(dshDir, "hook.mjs"));
  copyFile(path.join(packageRoot, "src", "core.mjs"), path.join(dshDir, "core.mjs"));
  writeDshHooks(dshDir);
  copyDir(skillSource, path.join(home, ".dsh", "skills", "handoff-anywhere"));
  if (appendSnippet(path.join(home, ".dsh", "AGENTS.md"))) {
    actions.push("appended rules to ~/.dsh/AGENTS.md");
  }
  actions.push("installed DSH hook files and skill");

  const dshProfile = [
    "- name: '@deepseek-ai/dsh-hooks-claude-code'",
    "  config:",
    `    configPath: ${path.join(dshDir, "hooks.json").replace(/\\/g, "/")}`,
    "    projectDir: .",
  ].join("\n");

  return { actions, dshProfile };
}
