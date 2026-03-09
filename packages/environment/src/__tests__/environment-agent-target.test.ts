import { describe, expect, it } from "vitest";
import { resolveEnvironmentAgentConnectionTarget } from "../environment-agent-target.js";

describe("resolveEnvironmentAgentConnectionTarget", () => {
  it("returns the default target when no environment agent base URL is configured", () => {
    const defaultTarget = {
      transport: "command-stdio" as const,
      command: "bb",
      args: ["environment-agent"],
      cwd: "/repo",
      env: {},
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
          transport: "command-stdio",
          command: "bb",
          args: ["environment-agent"],
          cwd: "/repo",
          env: {},
          daemonConnection: {
            threadId: "thread-1",
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
    });
  });
});
