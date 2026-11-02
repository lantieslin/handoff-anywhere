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
} from "../../src/core.mjs";

function sessionIDOf(event) {
  const properties = event?.properties ?? {};
  return (
    properties.sessionID ??
    properties.sessionId ??
    properties.info?.id ??
    properties.id ??
    "unknown"
  );
}

function toolPathOf(args) {
  if (!args || typeof args !== "object") return undefined;
  return args.filePath ?? args.file_path ?? args.path ?? args.file ?? args.filename;
}

function toolCommandOf(args) {
  if (!args || typeof args !== "object") return undefined;
  return args.command ?? args.cmd;
}

function toolStatusOf(output) {
  const metadata = output?.metadata ?? {};
  const exit = metadata.exitCode ?? metadata.exit_code;
  if (typeof exit === "number") return exit === 0 ? "ok" : "failed";
  if (metadata.isError === true || metadata.error) return "failed";
  return undefined;
}

function toolErrorOf(output) {
  const metadata = output?.metadata ?? {};
  const error = metadata.stderr ?? metadata.error;
  if (!error) return undefined;
  if (typeof error === "string") return error;
  return error.message ?? String(error);
}

export const HandoffAnywhere = async ({ directory } = {}) => {
  const paths = resolveProject(directory ?? process.cwd());
  if (!paths) return {};

  const injected = new Set();
  const guarded = (handler) => async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      appendDebug(paths, `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`);
    }
  };

  return {
    event: guarded(async ({ event }) => {
      const sessionID = sessionIDOf(event);
      switch (event?.type) {
        case "session.created": {
          if (isDisabled(paths)) return;
          ensureState(paths);
          rotateIfNeeded(paths);
          cleanSeen(paths);
          appendEvent(paths, { agent: "opencode", session: sessionID, type: "session_start" });
          break;
        }
        case "session.idle": {
          appendEvent(paths, { agent: "opencode", session: sessionID, type: "idle" });
          break;
        }
        case "session.error": {
          const error = event.properties?.error;
          const message =
            typeof error === "string"
              ? error
              : (error?.message ?? error?.name ?? String(error ?? "unknown error"));
          appendEvent(paths, {
            agent: "opencode",
            session: sessionID,
            type: "error",
            status: "failed",
            err: message,
          });
          break;
        }
        case "session.deleted": {
          injected.delete(sessionID);
          break;
        }
        default:
          break;
      }
    }),

    "tool.execute.after": guarded(async (input, output) => {
      if (isDisabled(paths)) return;
      const filePath = toolPathOf(input?.args);
      if (isStatePath(paths.root, filePath)) return;
      appendEvent(paths, {
        agent: "opencode",
        session: input?.sessionID ?? "unknown",
        type: "tool",
        tool: input?.tool,
        path: filePath,
        cmd: toolCommandOf(input?.args),
        status: toolStatusOf(output),
        err: toolErrorOf(output),
        callID: input?.callID,
      });
    }),

    "experimental.chat.system.transform": guarded(async (input, output) => {
      const sessionID = input?.sessionID;
      if (!sessionID || injected.has(sessionID) || isDisabled(paths)) return;
      const card = buildCard(paths);
      if (!card) return;
      output.system = output.system ?? [];
      output.system.push(`\n\n${card}`);
      injected.add(sessionID);
    }),

    "experimental.session.compacting": guarded(async (input, output) => {
      if (isDisabled(paths)) return;
      const card = buildCard(paths);
      if (!card) return;
      output.context = output.context ?? [];
      output.context.push(`handoff-anywhere state (preserve):\n${card}\nFull state: .agent/HANDOFF.md`);
    }),
  };
};

export default HandoffAnywhere;
