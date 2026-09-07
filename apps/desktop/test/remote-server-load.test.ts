import { describe, expect, it, vi } from "vitest";
import {
  describeServerUrl,
  loadRemoteServerPage,
  type LoadRemoteServerPageArgs,
} from "../src/remote-server-load.js";

type StartupErrorView = Parameters<
  LoadRemoteServerPageArgs["loadStartupError"]
>[0];

interface TestHarness extends LoadRemoteServerPageArgs {
  shownErrors: StartupErrorView[];
  warnings: string[];
}

function createElectronLoadError(url: string): Error {
  const error = new Error(`ERR_CONNECTION_REFUSED (-102) loading '${url}/'`);
  error.stack =
    `Error: ERR_CONNECTION_REFUSED (-102) loading '${url}/'\n` +
    "    at rejectAndCleanup (node:electron/js2c/browser_init:2:89743)\n" +
    "    at WebContents.finishListener (node:electron/js2c/browser_init:2:89905)\n" +
    "    at WebContents.emit (node:events:509:28)";
  return error;
}

function createHarness(
  overrides: Partial<LoadRemoteServerPageArgs> = {},
): TestHarness {
  const serverUrl =
    overrides.serverUrl ?? "http://bb-host.tailnet.ts.net:38886";
  const shownErrors: StartupErrorView[] = [];
  const warnings: string[] = [];
  return {
    isCurrent: () => true,
    loadStartupError: async (view) => {
      shownErrors.push(view);
    },
    loadUrl: vi.fn(async () => {
      throw createElectronLoadError(serverUrl);
    }),
    logWarning: (message) => {
      warnings.push(message);
    },
    serverUrl,
    shownErrors,
    warnings,
    ...overrides,
  };
}

describe("loadRemoteServerPage", () => {
  it("turns an unreachable host into a named error view with the way out", async () => {
    const harness = createHarness();

    await expect(loadRemoteServerPage(harness)).resolves.toBe(false);

    expect(harness.shownErrors).toHaveLength(1);
    const view = harness.shownErrors[0];
    expect(view?.title).toBe("Could not reach this bb server");
    expect(view?.details).toContain("http://bb-host.tailnet.ts.net:38886");
    expect(view?.details).toContain("Window ▸ Server");
    expect(view?.details).toContain("This Mac");
    expect(view?.details).not.toContain("rejectAndCleanup");
    expect(view?.details).not.toContain("node:electron");

    expect(harness.warnings).toHaveLength(1);
    expect(harness.warnings[0]).toContain("ERR_CONNECTION_REFUSED (-102)");
  });

  it("keeps credentials and query tokens off the screen and out of the log", async () => {
    const harness = createHarness({
      serverUrl: "https://user:hunter2@bb.example.com:8443/?token=s3cret",
    });

    await expect(loadRemoteServerPage(harness)).resolves.toBe(false);

    const details = harness.shownErrors[0]?.details ?? "";
    expect(details).toContain("https://bb.example.com:8443");
    expect(details).not.toContain("hunter2");
    expect(details).not.toContain("s3cret");
    const logged = harness.warnings[0] ?? "";
    expect(logged).toContain("https://bb.example.com:8443");
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("s3cret");
  });

  it("shows nothing for a load the user already superseded", async () => {
    const harness = createHarness({ isCurrent: () => false });

    await expect(loadRemoteServerPage(harness)).resolves.toBe(false);

    expect(harness.shownErrors).toHaveLength(0);
    expect(harness.warnings).toHaveLength(0);
  });

  it("reports a successful load without touching the error view", async () => {
    const harness = createHarness({ loadUrl: vi.fn(async () => {}) });

    await expect(loadRemoteServerPage(harness)).resolves.toBe(true);

    expect(harness.shownErrors).toHaveLength(0);
    expect(harness.warnings).toHaveLength(0);
  });
});

describe("describeServerUrl", () => {
  it("names only the origin", () => {
    expect(
      describeServerUrl("http://user:pw@host.ts.net:38886/app?token=x#y"),
    ).toBe("the bb server at http://host.ts.net:38886");
  });

  it("falls back to a generic label for an unparseable URL", () => {
    expect(describeServerUrl("not a url")).toBe("the saved bb server");
  });
});
