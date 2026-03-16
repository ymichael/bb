#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const cleanupScript = resolve(__dirname, "cleanup-bb-test-processes.mjs");

function parseArgs(argv) {
  const options = {
    pid: null,
    tmpRoot: null,
    bbRoot: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--pid":
        options.pid = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--tmp-root":
        options.tmpRoot = argv[index + 1] ? resolve(argv[index + 1]) : null;
        index += 1;
        break;
      case "--bb-root":
        options.bbRoot = argv[index + 1] ? resolve(argv[index + 1]) : null;
        index += 1;
        break;
      default:
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!options.pid && !options.tmpRoot && !options.bbRoot) {
    throw new Error("Pass at least one of --pid, --tmp-root, or --bb-root");
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const args = [cleanupScript];
  if (options.pid) {
    args.push("--pid", options.pid);
  }
  if (options.tmpRoot) {
    args.push("--tmp-root", options.tmpRoot);
  }
  if (options.bbRoot) {
    args.push("--bb-root", options.bbRoot);
  }

  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
  });
  process.exit(result.status ?? 0);
}

await main();
