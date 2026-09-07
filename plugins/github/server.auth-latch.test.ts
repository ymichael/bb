import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

let binDir: string;
let offlineFlag: string;
let noTokenFlag: string;
let badSecondaryFlag: string;
let apiDownFlag: string;
let slowStatusFlag: string;
let callLog: string;
const originalPath = process.env.PATH;

function ghCalls(): string[] {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .filter((line: string) => line.length > 0);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "bb-1758-gh-"));
  offlineFlag = join(binDir, "gh-offline");
  noTokenFlag = join(binDir, "gh-no-token");
  badSecondaryFlag = join(binDir, "gh-bad-secondary");
  apiDownFlag = join(binDir, "gh-api-down");
  slowStatusFlag = join(binDir, "gh-slow-status");
  callLog = join(binDir, "gh-calls.log");
  writeFileSync(
    join(binDir, "gh"),
    `#!/usr/bin/env bash
echo "$*" >> "${callLog}"
case "$1 $2" in
  "--version ") echo "gh version 2.96.0 (fake)"; exit 0;;
  "auth token")
    if [ -e "${noTokenFlag}" ]; then echo "no oauth token found for github.com" >&2; exit 1; fi
    echo "gho_fake_token_is_configured_locally"; exit 0;;
  "auth status")
    [ -e "${slowStatusFlag}" ] && sleep 0.3
    if [ -e "${noTokenFlag}" ]; then
      echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1
    fi
    if [ -e "${offlineFlag}" ]; then
      echo "github.com" >&2
      echo "  X Failed to log in to github.com account someone (keyring)" >&2
      echo "  - The token in keyring is invalid." >&2
      exit 1
    fi
    if [ -e "${badSecondaryFlag}" ]; then
      case " $* " in *" --active "*) ;; *)
        echo "github.com" >&2
        echo "  X Failed to log in to github.com account other (keyring)" >&2
        echo "  - The token in keyring is invalid." >&2
        exit 1;;
      esac
    fi
    echo "github.com"; echo "  ✓ Logged in to github.com account someone (keyring)"; exit 0;;
  "issue list"|"pr list")
    if [ -e "${apiDownFlag}" ]; then echo "error connecting to api.github.com" >&2; exit 1; fi
    echo "[]"; exit 0;;
  *) echo "[]"; exit 0;;
esac
`,
  );
  chmodSync(join(binDir, "gh"), 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

async function loadWithSyncServiceOnce(
  options: { settings?: Record<string, string> } = {},
) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "github",
    settings: options.settings,
  });
  await plugin(bb);
  const callsBeforeService = ghCalls().length;
  const { controller, done } = harness.runService("sync");
  await vi.waitFor(
    () => {
      expect(ghCalls().length).toBeGreaterThan(callsBeforeService);
    },
    { timeout: 4_000 },
  );
  controller.abort();
  await done;
  return { bb, harness };
}

describe("github plugin gh auth probe (#1758)", () => {
  it("re-probes gh after a transient auth-status failure instead of latching", async () => {
    writeFileSync(offlineFlag, "");
    const { harness } = await loadWithSyncServiceOnce();
    const before = (await harness.callRpc("status")) as {
      ghOk: boolean;
      ghState: string;
    };
    expect(before.ghOk).toBe(false);
    expect(before.ghState).toBe("unavailable");
    const callsWhileOffline = ghCalls().length;

    rmSync(offlineFlag);

    const after = (await harness.callRpc("status")) as {
      ghOk: boolean;
      ghState: string;
      ghError: string | null;
    };
    expect(ghCalls().length).toBeGreaterThan(callsWhileOffline);
    expect(after.ghOk).toBe(true);
    expect(after.ghState).toBe("ready");
  });

  it('does not report needs-configuration ("run gh auth login") for a transient probe failure', async () => {
    writeFileSync(offlineFlag, "");
    const { harness } = await loadWithSyncServiceOnce();
    expect(harness.needsConfigurationMessages).toEqual([]);
  });

  it("still reports needs-configuration when gh has no credentials at all", async () => {
    writeFileSync(noTokenFlag, "");
    const { harness } = await loadWithSyncServiceOnce();
    expect(harness.needsConfigurationMessages.length).toBeGreaterThan(0);
    expect(harness.needsConfigurationMessages[0]).toContain("gh auth login");
    const status = (await harness.callRpc("status")) as { ghState: string };
    expect(status.ghState).toBe("needs_configuration");
  });

  it("control: with gh working from the start the plugin never reports needs-configuration", async () => {
    const { harness } = await loadWithSyncServiceOnce();
    expect(harness.needsConfigurationMessages).toEqual([]);
    const status = (await harness.callRpc("status")) as { ghOk: boolean };
    expect(status.ghOk).toBe(true);
  });

  it("probes only the active github.com account, so a broken secondary account does not block sync", async () => {
    writeFileSync(badSecondaryFlag, "");
    const { harness } = await loadWithSyncServiceOnce();
    expect(harness.needsConfigurationMessages).toEqual([]);
    const status = (await harness.callRpc("status")) as { ghState: string };
    expect(status.ghState).toBe("ready");
    const statusCalls = ghCalls().filter((call) =>
      call.startsWith("auth status"),
    );
    expect(statusCalls.length).toBeGreaterThan(0);
    for (const call of statusCalls) {
      expect(call).toContain("--hostname github.com");
      expect(call).toContain("--active");
    }
    const tokenCalls = ghCalls().filter((call) =>
      call.startsWith("auth token"),
    );
    for (const call of tokenCalls) {
      expect(call).toContain("--hostname github.com");
    }
  });

  it("shares one in-flight probe between concurrent status calls", async () => {
    writeFileSync(offlineFlag, "");
    const { harness } = await loadWithSyncServiceOnce();
    rmSync(offlineFlag);
    writeFileSync(slowStatusFlag, "");
    const callsBefore = ghCalls().length;
    const [a, b] = (await Promise.all([
      harness.callRpc("status"),
      harness.callRpc("status"),
    ])) as Array<{ ghState: string }>;
    expect(a.ghState).toBe("ready");
    expect(b.ghState).toBe("ready");
    const probes = ghCalls()
      .slice(callsBefore)
      .filter((call) => call.startsWith("auth status"));
    expect(probes).toHaveLength(1);
  });

  it("stops promptly when aborted during an all-repos failure and keeps the old sync time", async () => {
    writeFileSync(apiDownFlag, "");
    writeFileSync(slowStatusFlag, "");
    const { bb, harness } = await loadWithSyncServiceOnce({
      settings: { extraRepos: "acme/one acme/two" },
    });
    rmSync(slowStatusFlag);
    expect(harness.needsConfigurationMessages).toEqual([]);
    expect(await bb.storage.kv.get("sync-cursor")).toBeUndefined();
    expect(harness.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringMatching(/all 2 repo/),
        }),
      ]),
    );

    rmSync(apiDownFlag);
    const result = (await harness.callRpc("refresh")) as { repos: number };
    expect(result.repos).toBe(2);
    expect(await bb.storage.kv.get("sync-cursor")).toBeDefined();
  }, 20_000);
});
