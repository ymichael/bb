import { describe, expect, it } from "vitest";
import { resolveEnvironmentDaemonConnectionTarget } from "../environment-daemon-target.js";

describe("resolveEnvironmentDaemonConnectionTarget", () => {
  it("returns the default target when no environment agent base URL is configured", () => {
    const defaultTarget = {
      transport: "http" as const,
      baseUrl: "http://127.0.0.1:4010",
    };

    expect(
      resolveEnvironmentDaemonConnectionTarget({
        runtimeEnv: {},
        defaultTarget,
      }),
    ).toEqual(defaultTarget);
  });

  it("returns an http target when an external environment agent base URL is configured", () => {
    expect(
      resolveEnvironmentDaemonConnectionTarget({
        runtimeEnv: {
          BB_ENV_DAEMON_BASE_URL: "http://127.0.0.1:4312/",
          BB_ENV_DAEMON_AUTH_TOKEN: "secret-token",
        },
        defaultTarget: {
          transport: "http",
          baseUrl: "http://127.0.0.1:4010",
          serverConnection: {
            threadId: "thread-1",
          },
          providerLaunch: {
            command: "docker",
            args: ["exec", "-i", "bb-thread-thread-1"],
          },
        },
      }),
    ).toEqual({
      transport: "http",
      baseUrl: "http://127.0.0.1:4312",
      headers: {
        authorization: "Bearer secret-token",
      },
      serverConnection: {
        threadId: "thread-1",
      },
      providerLaunch: {
        command: "docker",
        args: ["exec", "-i", "bb-thread-thread-1"],
      },
    });
  });
});
