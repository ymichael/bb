import { afterEach, describe, expect, it, vi } from "vitest";

const NODE_ENTRY_IMPORT_TEST_TIMEOUT_MS = 15_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("@bb/sdk/node entry", () => {
  it(
    "imports and builds explicit SDKs without BB server configuration",
    async () => {
      vi.stubEnv("BB_SERVER_URL", undefined);
      vi.stubEnv("BB_HOST_DAEMON_PORT", undefined);

      const nodeEntry = await import("../src/node.js");
      const sdk = nodeEntry.createNodeBbSdk({ baseUrl: "http://server" });

      expect(typeof sdk.threads.list).toBe("function");
    },
    NODE_ENTRY_IMPORT_TEST_TIMEOUT_MS,
  );
});
