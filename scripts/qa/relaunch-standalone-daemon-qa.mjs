#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const workspaceRoot = resolve(__dirname, "..", "..");
const defaultDaemonEntry = resolve(workspaceRoot, "apps", "daemon", "dist", "index.js");

function parseArgs(argv) {
  const options = {
    port: null,
    bbRoot: null,
    nodePath: process.execPath,
    daemonEntry: defaultDaemonEntry,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--port":
        options.port = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--bb-root":
        options.bbRoot = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--node-path":
        options.nodePath = argv[index + 1] ?? options.nodePath;
        index += 1;
        break;
      case "--daemon-entry":
        options.daemonEntry = argv[index + 1] ?? options.daemonEntry;
        index += 1;
        break;
      default:
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!options.port) {
    throw new Error("Missing required argument: --port");
  }
  if (!options.bbRoot) {
    throw new Error("Missing required argument: --bb-root");
  }

  return options;
}

async function main() {
  const { port, bbRoot, nodePath, daemonEntry } = parseArgs(process.argv.slice(2));
  const runtimeSummary = execFileSync(
    nodePath,
    ["-p", "JSON.stringify({ version: process.version, abi: process.versions.modules })"],
    { encoding: "utf8" },
  );
  const { version, abi } = JSON.parse(runtimeSummary);

  console.error(
    `Relaunching standalone daemon with ${nodePath} (node ${version}, abi ${abi})`,
  );
  console.error(`BB_ROOT=${bbRoot}`);
  console.error(`Daemon entry=${daemonEntry}`);

  const daemonChild = spawn(nodePath, [daemonEntry, "--port", String(port)], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      BB_ROOT: bbRoot,
    },
    stdio: "inherit",
  });

  daemonChild.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

await main();
