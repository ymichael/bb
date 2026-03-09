import { describe, expect, it } from "vitest";
import {
  resolveEnvironmentAgentServiceOptions,
} from "./service.js";

describe("environment-agent service config", () => {
  it("maps CLI args and env vars into runtime and server config", () => {
    const resolved = resolveEnvironmentAgentServiceOptions({
      cli: {
        providerCommand: "codex",
        providerArgs: ["app-server"],
        providerLaunchCommand: "docker",
        providerLaunchArgs: ["exec", "-i", "container-1"],
        httpPort: "4123",
        httpHost: "0.0.0.0",
      },
      env: {
        BB_THREAD_ID: "thread-1",
        BB_PROJECT_ID: "project-1",
        BB_ENVIRONMENT_ID: "docker",
        BEANBAG_DAEMON_URL: "http://127.0.0.1:9000",
        BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: "secret-token",
      },
    });

    expect(resolved).toEqual({
      runtime: {
        threadId: "thread-1",
        projectId: "project-1",
        environmentId: "docker",
        daemonConnection: {
          daemonUrl: "http://127.0.0.1:9000",
          authToken: "secret-token",
          threadId: "thread-1",
          projectId: "project-1",
          environmentId: "docker",
        },
        providerCommand: "codex",
        providerArgs: ["app-server"],
        providerLaunchCommand: "docker",
        providerLaunchArgs: ["exec", "-i", "container-1"],
      },
      server: {
        host: "0.0.0.0",
        port: 4123,
        bearerToken: "secret-token",
      },
    });
  });

  it("rejects missing auth token", () => {
    expect(() =>
      resolveEnvironmentAgentServiceOptions({
        cli: {
          httpPort: "4123",
        },
        env: {},
      }),
    ).toThrow(/BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN/);
  });

  it("rejects invalid http port", () => {
    expect(() =>
      resolveEnvironmentAgentServiceOptions({
        cli: {
          httpPort: "NaN",
        },
        env: {
          BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: "secret-token",
        },
      }),
    ).toThrow(/Invalid --http-port/);
  });
});
