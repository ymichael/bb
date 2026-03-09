import { describe, expect, it } from "vitest";
import { resolveEnvironmentAgentConnectionTarget } from "../environment-agent-target.js";

describe("resolveEnvironmentAgentConnectionTarget", () => {
  it("returns the default target when no environment agent base URL is configured", () => {
    const defaultTarget = {
      transport: "http" as const,
      baseUrl: "http://127.0.0.1:4010",
    };

    expect(
      resolveEnvironmentAgentConnectionTarget({
        runtimeEnv: {},
        defaultTarget,
      }),
    ).toEqual(defaultTarget);
  });

  it("returns an http target when an external environment agent base URL is configured", () => {
    expect(
      resolveEnvironmentAgentConnectionTarget({
        runtimeEnv: {
          BEANBAG_ENVIRONMENT_AGENT_BASE_URL: "http://127.0.0.1:4312/",
          BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: "secret-token",
        },
        defaultTarget: {
          transport: "http",
          baseUrl: "http://127.0.0.1:4010",
          daemonConnection: {
            threadId: "thread-1",
          },
          providerLaunch: {
            command: "docker",
            args: ["exec", "-i", "beanbag-thread-thread-1"],
          },
        },
      }),
    ).toEqual({
      transport: "http",
      baseUrl: "http://127.0.0.1:4312",
      headers: {
        authorization: "Bearer secret-token",
      },
      daemonConnection: {
        threadId: "thread-1",
      },
      providerLaunch: {
        command: "docker",
        args: ["exec", "-i", "beanbag-thread-thread-1"],
      },
    });
  });
});
