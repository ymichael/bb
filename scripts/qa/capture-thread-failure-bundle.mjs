#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function usage() {
  console.error(
    "Usage: node scripts/qa/capture-thread-failure-bundle.mjs <thread-id> [--scenario <name>] [--out <dir>]",
  );
}

function parseArgs(argv) {
  let threadId;
  let scenario = "manual";
  let outDir;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--scenario":
        scenario = argv[index + 1] ?? scenario;
        index += 1;
        break;
      case "--out":
        outDir = argv[index + 1];
        index += 1;
        break;
      default:
        if (!threadId) {
          threadId = arg;
          break;
        }
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!threadId) {
    usage();
    process.exit(1);
  }
  return { threadId, scenario, outDir };
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Request failed (${response.status}) for ${url}: ${body}`);
  }
  return response.json();
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const { threadId, scenario, outDir } = parseArgs(process.argv.slice(2));
const baseUrl = process.env.BB_DAEMON_URL ?? "http://127.0.0.1:4310";
const bbRoot = process.env.BB_ROOT ?? process.env.BB_ROOT;
const artifactRoot = resolve(
  outDir ?? join(process.cwd(), "qa", "artifacts", `${scenario}-${threadId}-${Date.now()}`),
);

await mkdir(artifactRoot, { recursive: true });

const [thread, threadStatus, threadLog, threadOutput, threadSessions, daemonHealth] =
  await Promise.all([
    readJson(`${baseUrl}/api/v1/threads/${encodeURIComponent(threadId)}`),
    readJson(
      `${baseUrl}/api/v1/threads/${encodeURIComponent(threadId)}`,
    ).then((value) => value),
    readJson(`${baseUrl}/api/v1/threads/${encodeURIComponent(threadId)}/events`),
    readJson(`${baseUrl}/api/v1/threads/${encodeURIComponent(threadId)}/output`).catch(
      (error) => ({ error: String(error) }),
    ),
    readJson(
      `${baseUrl}/api/v1/threads/${encodeURIComponent(threadId)}/environment-agent/sessions`,
    ).catch((error) => ({ error: String(error), threadId, sessions: [] })),
    readJson(`${baseUrl}/api/v1/system/health`).catch((error) => ({ error: String(error) })),
  ]);

await Promise.all([
  writeJson(join(artifactRoot, "metadata.json"), {
    generatedAt: new Date().toISOString(),
    daemonUrl: baseUrl,
    bbRoot: bbRoot ?? null,
    scenario,
    threadId,
  }),
  writeJson(join(artifactRoot, "thread.json"), thread),
  writeJson(join(artifactRoot, "thread-status.json"), threadStatus),
  writeJson(join(artifactRoot, "thread-log.json"), threadLog),
  writeJson(join(artifactRoot, "thread-output.json"), threadOutput),
  writeJson(join(artifactRoot, "thread-sessions.json"), threadSessions),
  writeJson(join(artifactRoot, "daemon-health.json"), daemonHealth),
]);

if (bbRoot) {
  const daemonLogPath = join(bbRoot, "logs", "daemon.log");
  try {
    await cp(daemonLogPath, join(artifactRoot, basename(daemonLogPath)));
  } catch {
    try {
      const missingMessage = await readFile(daemonLogPath, "utf8");
      await writeFile(join(artifactRoot, basename(daemonLogPath)), missingMessage, "utf8");
    } catch {
      // Ignore missing log file.
    }
  }
}

console.log(artifactRoot);
