import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const JOURNAL_MAX_BYTES = 1024 * 1024;
const JOURNAL_KEEP = 3;
const TAIL_BYTES = 8 * 1024;
const SEEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SENSITIVE_BASENAMES = [/^\.env($|\.)/i, /^id_(rsa|ed25519|ecdsa)/i, /^credentials/i];
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);
const SENSITIVE_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".azure", ".kube"]);

const REDACTIONS = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-***"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer ***"],
  [
    /\b(api[_-]?key|token|secret|password|passwd|pwd)\b(\s*[:=]\s*)["']?[^\s"',;]{4,}/gi,
    "$1$2***",
  ],
];

/** Local ISO-8601 timestamp with offset, e.g. 2026-11-02T14:03:00+08:00. */
export function nowIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19);
  return `${local}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

export function redact(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

export function truncate(text, max) {
  if (typeof text !== "string") return undefined;
  const value = text.trim();
  if (!value) return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function isSensitivePath(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) return true;
  const base = segments.at(-1) ?? "";
  if (SENSITIVE_BASENAMES.some((pattern) => pattern.test(base))) return true;
  return SENSITIVE_EXTENSIONS.has(path.extname(base));
}

/** True when a tool touched the handoff state itself; those calls are not journaled. */
export function isStatePath(root, filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return false;
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const relative = path.relative(root, resolved).replace(/\\/g, "/");
  return relative === ".agent" || relative.startsWith(".agent/");
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Home root, temp dirs, and drive roots are not projects. */
export function isAutoStateAllowed(cwd, { home = os.homedir(), tmp = os.tmpdir() } = {}) {
  const resolved = path.resolve(cwd);
  if (resolved === path.parse(resolved).root) return false;
  if (resolved === path.resolve(home)) return false;
  if (isInside(resolved, tmp)) return false;
  return true;
}

/**
 * Resolve the .agent directory for a project.
 * Returns null when cwd should not receive automatic state (pass force to override).
 */
export function resolveProject(cwd = process.cwd(), { force = false, home, tmp } = {}) {
  const root = path.resolve(cwd);
  if (!force && !isAutoStateAllowed(root, { home, tmp })) return null;
  const agentDir = path.join(root, ".agent");
  return {
    root,
    agentDir,
    handoffPath: path.join(agentDir, "HANDOFF.md"),
    journalPath: path.join(agentDir, "journal.jsonl"),
    offPath: path.join(agentDir, "OFF"),
    seenDir: path.join(agentDir, ".seen"),
    debugPath: path.join(agentDir, ".debug.log"),
  };
}

export function ensureState(paths) {
  try {
    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.mkdirSync(paths.seenDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function isDisabled(paths) {
  return fs.existsSync(paths.offPath);
}

function normalizeProjectPath(root, filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return undefined;
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  return path.relative(root, resolved).replace(/\\/g, "/");
}

function buildEvent(paths, input) {
  const agent = truncate(String(input.agent ?? "unknown"), 32) ?? "unknown";
  const sessionID = truncate(String(input.session ?? "unknown"), 120) ?? "unknown";
  const type = truncate(String(input.type ?? "tool"), 32) ?? "tool";
  const projectPath = normalizeProjectPath(paths.root, input.path);
  if (projectPath && isSensitivePath(projectPath)) return null;

  const event = {
    ts: input.ts ?? nowIso(),
    session: sessionID.includes(":") ? sessionID : `${agent}:${sessionID}`,
    agent,
    type,
  };
  if (input.tool) event.tool = truncate(String(input.tool), 80);
  if (projectPath) event.path = truncate(projectPath, 500);
  if (input.cmd) event.cmd = truncate(redact(String(input.cmd)), 300);
  if (input.status === "ok" || input.status === "failed") event.status = input.status;
  if (input.err) event.err = truncate(redact(String(input.err)), 200);
  if (input.callID) event.callID = truncate(String(input.callID), 120);
  return event;
}

/** Append one event. Returns false when disabled, deduped, sensitive, or on I/O error. */
export function appendEvent(paths, input) {
  if (!paths || isDisabled(paths)) return false;
  if (!ensureState(paths)) return false;

  const event = buildEvent(paths, input);
  if (!event) return false;
  if (event.callID && readJournalTail(paths).some((e) => e.callID === event.callID)) return false;

  try {
    fs.appendFileSync(paths.journalPath, `${JSON.stringify(event)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Parse the last `maxBytes` of the journal. A partial first line is dropped. */
export function readJournalTail(paths, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    const stats = fs.statSync(paths.journalPath);
    if (stats.size === 0) return [];
    const start = Math.max(0, stats.size - maxBytes);
    fd = fs.openSync(paths.journalPath, "r");
    const buffer = Buffer.alloc(stats.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const events = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") events.push(parsed);
      } catch {
        // ignore malformed lines
      }
    }
    return events;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/** Move journal.jsonl to .1, .1 to .2, drop anything past `keep`. */
export function rotateIfNeeded(paths, { maxBytes = JOURNAL_MAX_BYTES, keep = JOURNAL_KEEP } = {}) {
  try {
    if (fs.statSync(paths.journalPath).size <= maxBytes) return false;
    for (let index = keep; index >= 1; index -= 1) {
      const target = `${paths.journalPath}.${index}`;
      const source = index === 1 ? paths.journalPath : `${paths.journalPath}.${index - 1}`;
      if (!fs.existsSync(source)) continue;
      if (index === keep && fs.existsSync(target)) fs.rmSync(target, { force: true });
      fs.renameSync(source, target);
    }
    return true;
  } catch {
    return false;
  }
}

export function cleanSeen(paths, { maxAgeMs = SEEN_MAX_AGE_MS, now = Date.now() } = {}) {
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(paths.seenDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(paths.seenDir, entry.name);
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    }
  } catch {
    // ignore
  }
  return removed;
}

/** Keep a tiny diagnostic trail without ever writing payloads. */
export function appendDebug(paths, message) {
  try {
    ensureState(paths);
    const line = `${nowIso()} ${String(message).slice(0, 200)}\n`;
    fs.appendFileSync(paths.debugPath, line, "utf8");
    const lines = fs.readFileSync(paths.debugPath, "utf8").split("\n");
    if (lines.length > 101) {
      fs.writeFileSync(paths.debugPath, `${lines.slice(-100).join("\n")}`, "utf8");
    }
    return true;
  } catch {
    return false;
  }
}

/** Minimal HANDOFF.md parser: metadata lines plus `## Section` blocks. */
export function parseHandoff(text) {
  const result = { sections: {} };
  if (typeof text !== "string" || !text.trim()) return result;
  text = text.replace(/^\uFEFF/, "");
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      current = heading[1].trim().toLowerCase();
      result.sections[current] = [];
      continue;
    }
    if (current) {
      result.sections[current].push(line);
      continue;
    }
    const meta = line.match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/);
    if (meta) result[meta[1].trim().toLowerCase()] = meta[2].trim();
  }

  const firstLine = (name) =>
    (result.sections[name] ?? []).map((line) => line.trim()).find(Boolean) ?? null;
  result.goal = firstLine("goal");
  result.next = (result.sections.next ?? [])
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
  if (result.next) result.next = result.next.replace(/^(\d+[.)]|[-*])\s+/, "");
  result.status = result.status ?? null;
  result.updated = result.updated ?? null;
  result.session = result.session ?? null;
  return result;
}

function parseTime(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function relativeTime(time, now) {
  if (time === null) return "unknown time";
  const diff = Math.max(0, now - time);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(time).toISOString().slice(0, 10);
}

function displayTime(value) {
  const time = parseTime(value);
  if (time === null) return "unknown";
  const date = new Date(time);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function describeTool(event) {
  if (!event) return null;
  const tool = event.tool ?? "tool";
  const target = event.path ? ` ${event.path}` : event.cmd ? ` \`${event.cmd}\`` : "";
  const failed = event.status === "failed" ? ` (failed${event.err ? `: ${event.err}` : ""})` : "";
  return `${tool}${target}${failed}`;
}

/** Last action, plus the last file touched when the last action was a command. */
function describeLast(tail) {
  const lastTool = [...tail].reverse().find((event) => event.type === "tool");
  if (!lastTool) return null;
  if (lastTool.path) return describeTool(lastTool);
  const lastPath = [...tail]
    .reverse()
    .find((event) => event.type === "tool" && event.path);
  return lastPath ? `${describeTool(lastPath)} -> ${describeTool(lastTool)}` : describeTool(lastTool);
}

/**
 * Build the <=12 line resume card. Returns null when there is nothing to resume.
 */
export function buildCard(paths, { now = Date.now() } = {}) {
  let handoff = null;
  try {
    handoff = parseHandoff(fs.readFileSync(paths.handoffPath, "utf8"));
  } catch {
    handoff = null;
  }

  const tail = readJournalTail(paths);
  const last = tail.at(-1) ?? null;
  const lastTool = [...tail].reverse().find((event) => event.type === "tool") ?? null;
  if (!handoff && !last) return null;

  const interrupted = last ? last.type !== "idle" : false;
  const state = last ? (interrupted ? "interrupted" : "idle") : "no activity";
  const updatedTime = parseTime(handoff?.updated) ?? parseTime(last?.ts);
  const agent = last?.agent ?? handoff?.session?.split(/[/:]/)[0] ?? "unknown";
  const lines = [];

  if (handoff) {
    lines.push(
      `[handoff-anywhere] Last session ${displayTime(last?.ts ?? handoff.updated)} (${relativeTime(
        parseTime(last?.ts) ?? updatedTime,
        now,
      )}, ${agent}, ${state})`,
    );
  } else {
    lines.push(
      `[handoff-anywhere] No HANDOFF.md; last activity ${displayTime(last.ts)} (${relativeTime(
        parseTime(last.ts),
        now,
      )}, ${agent}, ${state})`,
    );
  }

  lines.push(`Goal: ${truncate(handoff?.goal, 200) ?? "(not recorded)"}`);
  lines.push(`Last: ${describeLast(tail) ?? "(none)"}`);
  lines.push(
    `Next: ${
      truncate(handoff?.next, 240) ??
      (lastTool ? "Read .agent/journal.jsonl and continue the last action." : "No recorded next step.")
    }`,
  );

  const lastTime = parseTime(last?.ts);
  const handoffTime = parseTime(handoff?.updated);
  if (handoff && lastTime !== null && handoffTime !== null && lastTime > handoffTime + 60_000) {
    lines.push("Note: HANDOFF.md is older than the journal; trust the journal tail for details.");
  }
  if (handoff?.status === "blocked") lines.push("Status: blocked — read Blockers in HANDOFF.md.");
  lines.push(`Details: ${handoff ? ".agent/HANDOFF.md" : ".agent/journal.jsonl"}`);

  return lines.slice(0, 12).join("\n");
}
