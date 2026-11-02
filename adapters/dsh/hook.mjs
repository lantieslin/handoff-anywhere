#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  appendDebug,
  appendEvent,
  buildCard,
  cleanSeen,
  ensureState,
  isDisabled,
  isStatePath,
  resolveProject,
  rotateIfNeeded,
} from "./core.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
}

function looksLikeError(text) {
  const value = text.trim();
  return (
    /^(error|failed|failure)\b/i.test(value) ||
    /\bexit (code|status)\s+[1-9]/i.test(value) ||
    /^FAIL\b/m.test(value)
  );
}

function statusOf(response) {
  if (typeof response === "string") return looksLikeError(response) ? "failed" : undefined;
  if (!response || typeof response !== "object") return undefined;
  const exit = response.exit_code ?? response.exitCode;
  if (typeof exit === "number") return exit === 0 ? "ok" : "failed";
  if (response.is_error === true || response.error) return "failed";
  return undefined;
}

function errorOf(response) {
  if (typeof response === "string") return looksLikeError(response) ? response : undefined;
  if (!response || typeof response !== "object") return undefined;
  const error = response.stderr ?? response.error;
  if (!error) return undefined;
  if (typeof error === "string") return error;
  return error.message ?? String(error);
}

function toolPathOf(input) {
  if (!input || typeof input !== "object") return undefined;
  return input.file_path ?? input.filePath ?? input.path ?? input.file ?? input.filename;
}

function toolCommandOf(input) {
  if (!input || typeof input !== "object") return undefined;
  return input.command ?? input.cmd;
}

function seenMarker(paths, sessionID) {
  return path.join(paths.seenDir, Buffer.from(String(sessionID)).toString("base64url"));
}

function handle(payload, paths) {
  const sessionID = payload.session_id ?? "unknown";
  switch (payload.hook_event_name) {
    case "SessionStart": {
      ensureState(paths);
      rotateIfNeeded(paths);
      cleanSeen(paths);
      appendEvent(paths, { agent: "dsh", session: sessionID, type: "session_start" });
      return;
    }
    case "UserPromptSubmit": {
      const marker = seenMarker(paths, sessionID);
      if (fs.existsSync(marker)) return;
      const card = buildCard(paths);
      if (!card) return;
      ensureState(paths);
      fs.writeFileSync(marker, "", "utf8");
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: card },
        }),
      );
      return;
    }
    case "PostToolUse": {
      const input = payload.tool_input ?? {};
      const filePath = toolPathOf(input);
      if (isStatePath(paths.root, filePath)) return;
      appendEvent(paths, {
        agent: "dsh",
        session: sessionID,
        type: "tool",
        tool: payload.tool_name,
        path: filePath,
        cmd: toolCommandOf(input),
        status: statusOf(payload.tool_response),
        err: errorOf(payload.tool_response),
        callID: payload.tool_use_id,
      });
      return;
    }
    case "Stop": {
      appendEvent(paths, { agent: "dsh", session: sessionID, type: "idle" });
      return;
    }
    default:
      return;
  }
}

let payload;
try {
  payload = JSON.parse(await readStdin());
} catch {
  process.exit(0);
}

const paths = resolveProject(payload?.cwd ?? process.cwd());
if (paths && !isDisabled(paths)) {
  try {
    handle(payload, paths);
  } catch (error) {
    appendDebug(paths, `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`);
  }
}
process.exitCode = 0;
