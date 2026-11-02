#!/usr/bin/env node
import fs from "node:fs";

import { buildCard, ensureState, resolveProject } from "../src/core.mjs";
import { install } from "../src/install.mjs";

const command = process.argv[2] ?? "status";

if (command === "install") {
  const result = install({ local: process.argv.includes("--local") });
  for (const action of result.actions) console.log(`- ${action}`);
  console.log("\nPaste this into your DSH profile's plugin list:\n");
  console.log(result.dshProfile);
  process.exit(0);
}

const paths = resolveProject(process.cwd());

if (!paths) {
  console.error("handoff-anywhere: refusing to create .agent in this directory (home or temp).");
  process.exit(1);
}

switch (command) {
  case "status": {
    ensureState(paths);
    console.log(buildCard(paths) ?? "No handoff state found.");
    break;
  }
  case "init": {
    ensureState(paths);
    console.log(`handoff-anywhere: state directory ready at ${paths.agentDir}`);
    break;
  }
  case "off": {
    ensureState(paths);
    fs.writeFileSync(paths.offPath, "", "utf8");
    console.log("handoff-anywhere: disabled for this project");
    break;
  }
  case "on": {
    fs.rmSync(paths.offPath, { force: true });
    console.log("handoff-anywhere: enabled for this project");
    break;
  }
  default:
    console.log("usage: handoff-anywhere [status|init|off|on|install]");
    process.exitCode = 2;
}
