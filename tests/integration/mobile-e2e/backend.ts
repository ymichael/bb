import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PendingInteraction } from "@bb/domain";
import { createIntegrationHarness } from "../helpers/harness.js";
import type { IntegrationHarness } from "../helpers/harness.js";
import {
  createProjectFixture,
  createReadyHostThread,
} from "../helpers/fixtures.js";
import {
  listThreadInteractions,
  resolveThreadInteraction,
  sendTextMessage,
} from "../helpers/api.js";
import { waitForThreadStatus } from "../helpers/assertions.js";

const DEFAULT_PORT = 41999;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readStaticDir(): string | undefined {
  if (process.env.BB_MOBILE_E2E_SERVE_APP !== "1") return undefined;
  const dist = resolve(repoRoot, "apps/app/dist");
  if (!existsSync(resolve(dist, "index.html"))) {
    throw new Error(
      `BB_MOBILE_E2E_SERVE_APP=1 but ${dist}/index.html is missing. Run: pnpm exec turbo run build --filter=@bb/app`,
    );
  }
  return dist;
}

function readPort(): number {
  const raw = process.env.BB_MOBILE_E2E_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid BB_MOBILE_E2E_PORT: ${raw}`);
  }
  return parsed;
}

function readBindHost(): "127.0.0.1" | "0.0.0.0" {
  const raw = process.env.BB_MOBILE_E2E_BIND_HOST;
  if (raw === undefined || raw === "127.0.0.1") return "127.0.0.1";
  if (raw === "0.0.0.0") return "0.0.0.0";
  throw new Error(`Invalid BB_MOBILE_E2E_BIND_HOST: ${raw}`);
}

function listLanIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

function warnWildcardBind(port: number): void {
  const lanUrls = listLanIpv4Addresses().map(
    (address) => `http://${address}:${port}`,
  );
  process.stderr.write(
    [
      "mobile-e2e backend: SECURITY WARNING: binding on 0.0.0.0. The harness",
      "server is unauthenticated and runs a real host daemon that permits",
      "command execution (terminal sessions) and file reads as your user.",
      "Use BB_MOBILE_E2E_BIND_HOST=0.0.0.0 only behind a trusted network",
      "boundary and stop the backend when you are done.",
    ].join(" ") +
      "\n" +
      (lanUrls.length > 0
        ? `mobile-e2e backend: point the phone at ${lanUrls.join(" or ")}\n`
        : ""),
  );
}

const TURN_TIMEOUT_MS = 15_000;
const INTERACTION_POLL_INTERVAL_MS = 100;

async function waitForPendingInteraction(
  harness: IntegrationHarness,
  threadId: string,
  timeoutMs = TURN_TIMEOUT_MS,
): Promise<PendingInteraction> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const interactions = await listThreadInteractions(harness.api, threadId);
    const pending = interactions.find(
      (interaction) => interaction.status === "pending",
    );
    if (pending) return pending;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for a pending interaction on thread ${threadId}`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, INTERACTION_POLL_INTERVAL_MS),
    );
  }
}

async function runTurn(
  harness: IntegrationHarness,
  threadId: string,
  text: string,
): Promise<void> {
  await sendTextMessage(harness.api, threadId, { text });
  await waitForThreadStatus(harness.api, threadId, "idle", TURN_TIMEOUT_MS);
}

const LONG_MARKDOWN_MESSAGE = [
  "# Release checklist overview",
  "",
  "This message exercises the markdown renderer end to end. It is long on",
  "purpose so the timeline has to scroll, and it mixes every block type the",
  "mobile renderer supports.",
  "",
  "## Goals",
  "",
  "- Ship the native timeline with parity for common rows.",
  "- Keep the delta merge cheap while a turn streams.",
  "- Verify paging, the unread divider, and the table of contents.",
  "",
  "## Steps",
  "",
  "1. Build the dev client once.",
  "2. Start Metro against the harness backend.",
  "3. Run the Maestro flows.",
  "",
  "## Commands",
  "",
  "```bash",
  "pnpm exec turbo run typecheck lint test --filter=@bb/mobile",
  "cd apps/mobile && pnpm e2e:ios",
  "xcrun simctl io booted screenshot /tmp/timeline.png",
  "```",
  "",
  "## Rows covered",
  "",
  "| Row kind | Source | Notes |",
  "| --- | --- | --- |",
  "| conversation | user + assistant | markdown bodies |",
  "| command | tool-call token | tool call with args |",
  "| approval | approval token | allowed once |",
  "| question | question token | left pending |",
  "",
  "## Reference",
  "",
  "See the [bb docs](https://docs.getbb.app) for the server contract and the",
  "plan in `plans/bb-mobile-expo.md` for the phase breakdown.",
  "",
  "## Notes",
  "",
  "Paragraph one of the notes section. It has enough words to wrap on a",
  "phone so line breaking inside paragraphs gets exercised as well.",
  "",
  "Paragraph two mentions `inline code`, **bold text**, and _emphasis_ so",
  "the inline renderers get a look too.",
  "",
  "> A blockquote with a single line of advice: keep the rows flat.",
  "",
  "### Sub-heading one",
  "",
  "- nested list level one",
  "  - nested list level two",
  "  - another level-two item",
  "- back to level one",
  "",
  "### Sub-heading two",
  "",
  "Final paragraph. If you can read this on the device, the long message",
  "scrolled into view correctly.",
  "",
  "Trailing line one.",
  "Trailing line two.",
  "Trailing line three.",
  "Trailing line four.",
].join("\n");

async function main(): Promise<void> {
  const bindHost = readBindHost();
  const serverPort = readPort();
  if (bindHost === "0.0.0.0") warnWildcardBind(serverPort);
  const harness = await createIntegrationHarness({
    bindHost,
    serverPort,
    staticDir: readStaticDir(),
  });

  const shutdown = async (signal: string) => {
    process.stderr.write(`mobile-e2e backend: ${signal}, shutting down\n`);
    await harness.cleanup();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const project = await createProjectFixture(harness, {
    name: "Mobile E2E Project",
  });

  const completed = await createReadyHostThread(harness, {
    projectId: project.id,
    title: "Completed thread",
    workspace: { type: "unmanaged", path: null },
  });
  await sendTextMessage(harness.api, completed.thread.id, {
    text: "Hello from the seed",
  });
  await waitForThreadStatus(harness.api, completed.thread.id, "idle", 15_000);

  const idle = await createReadyHostThread(harness, {
    projectId: project.id,
    title: "Idle thread",
    workspace: { type: "unmanaged", path: null },
  });

  const rich = await createReadyHostThread(harness, {
    projectId: project.id,
    title: "Rich thread",
    workspace: { type: "unmanaged", path: null },
  });
  const richId = rich.thread.id;
  await runTurn(harness, richId, "Hello rich thread, first message");
  await runTurn(harness, richId, "delay:300 second message");
  await runTurn(harness, richId, "call_tool:my_test_tool");
  await sendTextMessage(harness.api, richId, {
    text: "approve:command echo hi",
  });
  const approval = await waitForPendingInteraction(harness, richId);
  await resolveThreadInteraction({
    api: harness.api,
    threadId: richId,
    interactionId: approval.id,
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
  await waitForThreadStatus(harness.api, richId, "idle", TURN_TIMEOUT_MS);
  await runTurn(harness, richId, LONG_MARKDOWN_MESSAGE);
  await sendTextMessage(harness.api, richId, { text: "ask_user" });
  await waitForPendingInteraction(harness, richId);
  const unreadResponse = await harness.api.threads[":id"].unread.$post({
    param: { id: richId },
  });
  if (unreadResponse.status !== 200) {
    throw new Error(
      `mark rich thread unread failed: ${unreadResponse.status} ${await unreadResponse.text()}`,
    );
  }

  const rowsThreadResponse = await harness.api.threads.$post({
    json: {
      environment: { type: "reuse", environmentId: completed.environment.id },
      input: [
        {
          type: "text",
          text: "Worker finished: all checks pass.\nThe summary is in the next message.",
          mentions: [],
        },
      ],
      origin: "app",
      model: "fake-model",
      parentThreadId: idle.thread.id,
      projectId: project.id,
      providerId: "fake",
      title: "Rows thread",
      startedOnBehalfOf: { initiator: "agent", senderThreadId: idle.thread.id },
      originKind: "fork",
    },
  });
  if (rowsThreadResponse.status !== 201) {
    throw new Error(
      `create rows thread failed: ${rowsThreadResponse.status} ${await rowsThreadResponse.text()}`,
    );
  }
  const rowsThread = (await rowsThreadResponse.json()) as { id: string };
  await waitForThreadStatus(
    harness.api,
    rowsThread.id,
    "idle",
    TURN_TIMEOUT_MS,
  );
  await runTurn(harness, rowsThread.id, "Thanks, proceed.");

  const details = {
    hostId: harness.hostId,
    projectId: project.id,
    serverUrl: harness.serverUrl,
    threads: {
      completed: completed.thread.id,
      idle: idle.thread.id,
      rich: richId,
      rows: rowsThread.id,
    },
  };
  process.stdout.write(`${JSON.stringify(details)}\n`);
  process.stderr.write(
    `mobile-e2e backend ready at ${harness.serverUrl} (Ctrl-C to stop)\n`,
  );

  await new Promise<never>(() => {});
}

main().catch((error) => {
  process.stderr.write(`mobile-e2e backend failed: ${String(error)}\n`);
  process.exit(1);
});
