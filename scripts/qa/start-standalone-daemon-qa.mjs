#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const workspaceRoot = resolve(__dirname, "..", "..");

function parseArgs(argv) {
  const options = {
    projectName: "qa-standalone",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--project-name":
        options.projectName = argv[index + 1] ?? options.projectName;
        index += 1;
        break;
      default:
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}

async function allocatePort(host = "127.0.0.1") {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPort(new Error("Failed to allocate port")));
        return;
      }
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/system/health`);
      if (response.ok) return;
    } catch {
      // Daemon still starting.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  throw new Error(`Timed out waiting for daemon health at ${baseUrl}`);
}

async function createProject(baseUrl, projectName, projectRoot) {
  const response = await fetch(`${baseUrl}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: projectName,
      rootPath: projectRoot,
    }),
  });
  if (!response.ok) {
    throw new Error(`Project create failed: ${await response.text()}`);
  }
  return response.json();
}

async function main() {
  const { projectName } = parseArgs(process.argv.slice(2));
  const tmpRoot = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "beanbag-qa-")),
  );
  const projectRoot = join(tmpRoot, "project");
  const beanbagRoot = join(tmpRoot, "beanbag-root");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(beanbagRoot, { recursive: true });

  await writeFile(join(projectRoot, "alpha.txt"), "alpha\n", "utf8");
  await writeFile(join(projectRoot, "beta.md"), "# beta\n", "utf8");

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Beanbag Test",
    GIT_AUTHOR_EMAIL: "beanbag-test@example.com",
    GIT_COMMITTER_NAME: "Beanbag Test",
    GIT_COMMITTER_EMAIL: "beanbag-test@example.com",
  };
  await import("node:child_process").then(({ execFileSync }) => {
    execFileSync("git", ["init", "-b", "main"], { cwd: projectRoot, env: gitEnv });
    execFileSync("git", ["add", "."], { cwd: projectRoot, env: gitEnv });
    execFileSync("git", ["commit", "-m", "init"], { cwd: projectRoot, env: gitEnv });
  });

  const port = await allocatePort();
  const daemonUrl = `http://127.0.0.1:${port}`;
  const daemonChild = spawn(
    process.execPath,
    [resolve(workspaceRoot, "apps", "daemon", "dist", "index.js"), "--port", String(port)],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        BEANBAG_ROOT: beanbagRoot,
      },
      detached: true,
      stdio: "ignore",
    },
  );
  daemonChild.unref();

  await waitForHealth(daemonUrl);
  const project = await createProject(daemonUrl, projectName, projectRoot);

  console.log(JSON.stringify({
    tmpRoot,
    projectRoot,
    beanbagRoot,
    port,
    daemonUrl,
    daemonPid: daemonChild.pid,
    daemonLogPath: join(beanbagRoot, "logs", "daemon.log"),
    projectId: project.id,
  }, null, 2));
}

await main();
