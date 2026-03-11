import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveEnvironmentAgentServiceOptions,
  startEnvironmentAgentService,
} from "./service.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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
      logging: {
        filePath: expect.stringContaining(
          "/.beanbag/environment-agent-logs/project-1/docker-thread-1.log",
        ),
        verbose: false,
      },
      session: {
        pollIntervalMs: 250,
        commandBatchLimit: 50,
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

  it("enables verbose logging from env", () => {
    const resolved = resolveEnvironmentAgentServiceOptions({
      cli: {
        httpPort: "4123",
      },
      env: {
        BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN: "secret-token",
        BEANBAG_ENVIRONMENT_AGENT_VERBOSE_LOGS: "1",
      },
    });

    expect(resolved.logging.verbose).toBe(true);
  });

  it("starts session supervision when daemon config is present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/environment-agent/session/open")) {
        return new Response(
          JSON.stringify({
            protocol: "beanbag.env-agent.v1",
            type: "session_welcome",
            messageId: "msg-open",
            sessionId: "sess-1",
            sentAt: 1_000,
            payload: {
              leaseTtlMs: 30_000,
              heartbeatIntervalMs: 10_000,
              selectedTransport: "http-long-poll",
              protocolVersion: 1,
              channels: [],
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/environment-agent/session/heartbeat")) {
        return new Response(null, { status: 204 });
      }
      if (url.includes("/environment-agent/session/commands")) {
        return new Response(
          JSON.stringify({
            protocol: "beanbag.env-agent.v1",
            type: "command_batch",
            messageId: "msg-cmd",
            sessionId: "sess-1",
            sentAt: 1_100,
            payload: { commands: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/environment-agent/session/events")) {
        return new Response(
          JSON.stringify({
            protocol: "beanbag.env-agent.v1",
            type: "event_ack",
            messageId: "msg-ack",
            sessionId: "sess-1",
            sentAt: 1_200,
            payload: {
              channels: [
                {
                  channelId: "thread-1",
                  ackedThrough: { generation: 1, sequence: 1 },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const started = await startEnvironmentAgentService({
      runtime: {
        threadId: "thread-1",
        projectId: "project-1",
        environmentId: "local",
        daemonConnection: {
          daemonUrl: "http://127.0.0.1:9000/api/v1",
          authToken: "secret-token",
          threadId: "thread-1",
          projectId: "project-1",
          environmentId: "local",
        },
      },
      server: {
        host: "127.0.0.1",
        port: 0,
        bearerToken: "secret-token",
      },
      logging: {
        filePath: "/tmp/beanbag-environment-agent-service-test.log",
        verbose: false,
      },
      session: {
        pollIntervalMs: 10_000,
        commandBatchLimit: 10,
      },
    });

    expect(started.sessionSupervisor).toBeDefined();
    expect(fetchSpy.mock.calls).toContainEqual([
      "http://127.0.0.1:9000/api/v1/threads/thread-1/environment-agent/session/open",
      expect.objectContaining({ method: "POST" }),
    ]);

    await started.sessionSupervisor?.close();
    await started.runtime.shutdown();
    await started.server.close();
  });
});
