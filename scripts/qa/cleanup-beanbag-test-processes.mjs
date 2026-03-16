#!/usr/bin/env node

import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE_ROOT = resolve(__dirname, "..", "..");
const KNOWN_TEST_PROCESS_PATTERNS = [
  resolve(WORKSPACE_ROOT, "packages", "environment-agent", "dist", "environment-agent.bundle.mjs"),
  resolve(WORKSPACE_ROOT, "apps", "daemon", "dist", "index.js"),
  resolve(WORKSPACE_ROOT, "scripts", "qa", "run-fake-recovery-suite.mjs"),
  resolve(WORKSPACE_ROOT, "scripts", "qa", "cleanup-beanbag-test-processes.mjs"),
  resolve(WORKSPACE_ROOT, "scripts", "qa", "start-standalone-daemon-qa.mjs"),
  resolve(WORKSPACE_ROOT, "scripts", "qa", "stop-standalone-daemon-qa.mjs"),
  resolve(WORKSPACE_ROOT, "scripts", "qa", "relaunch-standalone-daemon-qa.mjs"),
];

const KNOWN_TMP_PREFIXES = [
  "beanbag-daemon-e2e-",
  "beanbag-standalone-daemon-",
  "beanbag-standalone-blocked-",
  "beanbag-qa-",
  "beanbag-environment-agent",
  "beanbag-test-runs",
];

function parseArgs(argv) {
  const options = {
    pid: null,
    tmpRoot: null,
    beanbagRoot: null,
    cleanupTmpDirs: false,
    quiet: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--pid":
        options.pid = Number.parseInt(argv[index + 1] ?? "", 10);
        index += 1;
        break;
      case "--tmp-root":
        options.tmpRoot = argv[index + 1] ? resolve(argv[index + 1]) : null;
        index += 1;
        break;
      case "--beanbag-root":
        options.beanbagRoot = argv[index + 1] ? resolve(argv[index + 1]) : null;
        index += 1;
        break;
      case "--cleanup-tmp-dirs":
        options.cleanupTmpDirs = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      default:
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (Number.isNaN(options.pid)) {
    throw new Error("Invalid --pid value");
  }

  return options;
}

function listProcesses() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        command: match[3],
      };
    })
    .filter((entry) => entry && Number.isFinite(entry.pid) && Number.isFinite(entry.ppid));
}

function commandMatchesKnownTmpPrefixes(command) {
  return KNOWN_TMP_PREFIXES.some((prefix) => command.includes(prefix));
}

function commandMatchesKnownTestProcess(command) {
  return KNOWN_TEST_PROCESS_PATTERNS.some((pattern) => command.includes(pattern));
}

function collectTargetPids(processes, options) {
  const targets = new Set();
  const byParent = new Map();

  for (const processInfo of processes) {
    const children = byParent.get(processInfo.ppid) ?? [];
    children.push(processInfo.pid);
    byParent.set(processInfo.ppid, children);
  }

  for (const processInfo of processes) {
    if (options.pid !== null && processInfo.pid === options.pid) {
      targets.add(processInfo.pid);
      continue;
    }
    if (options.tmpRoot && processInfo.command.includes(options.tmpRoot)) {
      targets.add(processInfo.pid);
      continue;
    }
    if (options.beanbagRoot && processInfo.command.includes(options.beanbagRoot)) {
      targets.add(processInfo.pid);
      continue;
    }
    if (commandMatchesKnownTestProcess(processInfo.command)) {
      targets.add(processInfo.pid);
      continue;
    }
    if (commandMatchesKnownTmpPrefixes(processInfo.command)) {
      targets.add(processInfo.pid);
    }
  }

  const queue = [...targets];
  while (queue.length > 0) {
    const pid = queue.shift();
    const children = byParent.get(pid) ?? [];
    for (const childPid of children) {
      if (targets.has(childPid)) continue;
      targets.add(childPid);
      queue.push(childPid);
    }
  }

  return [...targets].sort((left, right) => right - left);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function terminatePids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) {
      return;
    }
    await sleep(100);
  }

  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

function cleanupTmpDirs(options) {
  const explicitDirs = [options.tmpRoot, options.beanbagRoot ? resolve(options.beanbagRoot, "..") : null]
    .filter((value) => typeof value === "string");
  for (const dir of explicitDirs) {
    rmSync(dir, { recursive: true, force: true });
  }

  if (!options.cleanupTmpDirs) {
    return;
  }

  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!KNOWN_TMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    rmSync(join(tmpdir(), entry.name), { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const processes = listProcesses();
  const pids = collectTargetPids(processes, options);

  if (pids.length > 0) {
    await terminatePids(pids);
  }
  cleanupTmpDirs(options);

  if (!options.quiet) {
    console.log(JSON.stringify({
      terminatedPidCount: pids.length,
      terminatedPids: pids,
      cleanupTmpDirs: options.cleanupTmpDirs,
      tmpRoot: options.tmpRoot,
      beanbagRoot: options.beanbagRoot,
    }, null, 2));
  }
}

await main();
