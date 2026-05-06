import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseTurboFingerprint,
  type DevServiceName,
  type RestartTarget,
} from "../src/fingerprint.js";
import {
  createDevEnvStatusApp,
  type DevEnvRuntime,
  type DevEnvStatusDependencies,
} from "../src/status-api.js";

interface TestState {
  currentFingerprints: Record<DevServiceName, string>;
  restartTargets: RestartTarget[];
}

function createRuntime(): DevEnvRuntime {
  return {
    baselineFingerprints: new Map<DevServiceName, string>([
      ["host-daemon", "host-baseline"],
      ["server", "server-baseline"],
    ]),
  };
}

function createState(): TestState {
  return {
    currentFingerprints: {
      "host-daemon": "host-baseline",
      server: "server-changed",
    },
    restartTargets: [],
  };
}

function createDependencies(state: TestState): DevEnvStatusDependencies {
  return {
    computeServiceFingerprint: async (serviceName) =>
      state.currentFingerprints[serviceName],
    runRestartScript: async (target) => {
      state.restartTargets.push(target);
    },
  };
}

function computeExpectedFingerprint(
  fingerprints: Record<DevServiceName, string>,
): string {
  const hash = createHash("sha256");
  for (const serviceName of [
    "server",
    "host-daemon",
  ] satisfies DevServiceName[]) {
    hash.update(serviceName);
    hash.update("\0");
    hash.update(fingerprints[serviceName]);
    hash.update("\0");
  }
  return hash.digest("hex");
}

describe("dev-env status API", () => {
  it("serves health and status with in-memory baseline comparison", async () => {
    const state = createState();
    const runtime = createRuntime();
    const app = createDevEnvStatusApp(runtime, createDependencies(state));

    const healthResponse = await app.request("/health");
    const statusResponse = await app.request("/status");

    expect(await healthResponse.text()).toBe("ok");
    expect(await statusResponse.json()).toEqual({
      fingerprint: computeExpectedFingerprint(state.currentFingerprints),
      services: [
        {
          baselineFingerprint: "server-baseline",
          changed: true,
          fingerprint: "server-changed",
          serviceName: "server",
        },
        {
          baselineFingerprint: "host-baseline",
          changed: false,
          fingerprint: "host-baseline",
          serviceName: "host-daemon",
        },
      ],
      version: 1,
    });
  });

  it("runs the existing restart script and refreshes that target baseline", async () => {
    const state = createState();
    const runtime = createRuntime();
    const app = createDevEnvStatusApp(runtime, createDependencies(state));

    const response = await app.request("/restart", {
      body: JSON.stringify({ target: "server" }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(state.restartTargets).toEqual(["server"]);
    expect(runtime.baselineFingerprints.get("server")).toBe("server-changed");
    const status = (await response.json()) as {
      services: Array<{ serviceName: string; changed: boolean }>;
    };
    expect(
      status.services.find((service) => service.serviceName === "server"),
    ).toMatchObject({
      changed: false,
      serviceName: "server",
    });
  });

  it("upgrades a server restart to both services when the host-daemon build changed", async () => {
    const state = createState();
    state.currentFingerprints["host-daemon"] = "host-changed";
    const runtime = createRuntime();
    const app = createDevEnvStatusApp(runtime, createDependencies(state));

    const response = await app.request("/restart", {
      body: JSON.stringify({ target: "server" }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(state.restartTargets).toEqual(["both"]);
    expect(runtime.baselineFingerprints.get("server")).toBe("server-changed");
    expect(runtime.baselineFingerprints.get("host-daemon")).toBe(
      "host-changed",
    );
  });

  it("refreshes both baselines after a combined restart", async () => {
    const state = createState();
    const runtime = createRuntime();
    const app = createDevEnvStatusApp(runtime, createDependencies(state));

    const response = await app.request("/restart", {
      body: JSON.stringify({ target: "both" }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(state.restartTargets).toEqual(["both"]);
    expect(runtime.baselineFingerprints.get("server")).toBe("server-changed");
    expect(runtime.baselineFingerprints.get("host-daemon")).toBe(
      "host-baseline",
    );
  });

  it("returns a conflict when the restart script fails", async () => {
    const state = createState();
    const runtime = createRuntime();
    const app = createDevEnvStatusApp(runtime, {
      computeServiceFingerprint: async (serviceName) =>
        state.currentFingerprints[serviceName],
      runRestartScript: async () => {
        throw new Error("restart failed");
      },
    });

    const response = await app.request("/restart", {
      body: JSON.stringify({ target: "host-daemon" }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("restart failed");
    expect(runtime.baselineFingerprints.get("host-daemon")).toBe(
      "host-baseline",
    );
  });

  it("returns bad request for invalid restart bodies", async () => {
    const state = createState();
    const runtime = createRuntime();
    const app = createDevEnvStatusApp(runtime, createDependencies(state));

    const invalidTargetResponse = await app.request("/restart", {
      body: JSON.stringify({ target: "nope" }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const malformedJsonResponse = await app.request("/restart", {
      body: "{",
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(invalidTargetResponse.status).toBe(400);
    expect(malformedJsonResponse.status).toBe(400);
    expect(state.restartTargets).toEqual([]);
  });

  it("fails loudly when a service baseline is missing", async () => {
    const state = createState();
    const runtime: DevEnvRuntime = {
      baselineFingerprints: new Map<DevServiceName, string>([
        ["server", "server-baseline"],
      ]),
    };
    const app = createDevEnvStatusApp(runtime, createDependencies(state));

    const response = await app.request("/status");

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(runtime.baselineFingerprints.has("host-daemon")).toBe(false);
  });
});

describe("parseTurboFingerprint", () => {
  it("hashes sorted task hashes from turbo dry-run JSON with surrounding output", () => {
    const rawOutput = [
      "turbo 2.8.3",
      JSON.stringify({
        tasks: [
          {
            hash: "server-hash",
            taskId: "@bb/server#build",
          },
          {
            hash: "domain-hash",
            taskId: "@bb/domain#build",
          },
        ],
      }),
      "done",
    ].join("\n");
    const expected = createHash("sha256")
      .update("@bb/domain#build")
      .update("\0")
      .update("domain-hash")
      .update("\0")
      .update("@bb/server#build")
      .update("\0")
      .update("server-hash")
      .update("\0")
      .digest("hex");

    expect(parseTurboFingerprint(rawOutput)).toBe(expected);
  });
});
