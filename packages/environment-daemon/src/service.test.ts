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
        BB_THREAD_PROVIDER_ID: "codex",
        BB_ROOT: "/tmp/bb-root",
        BB_DAEMON_URL: "http://127.0.0.1:9000",
        BB_ENV_DAEMON_AUTH_TOKEN: "secret-token",
      },
    });

    expect(resolved).toEqual({
      runtime: {
        threadId: "thread-1",
        projectId: "project-1",
        environmentId: "docker",
        providerId: "codex",
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
          "/tmp/bb-root/environment-agent-logs/project-1/docker-thread-1.log",
        ),
      },
      control: {
        endpoint: undefined,
      },
      session: {
        pollIntervalMs: 250,
        commandBatchLimit: 50,
        capabilities: {
          commands: [
            "provider.ensure",
            "thread.start",
            "thread.resume",
            "thread.stop",
            "turn.run",
            "thread.rename",
            "provider.list_models",
            "provider.list_catalog",
            "workspace.status",
            "workspace.diff",
          ],
          features: ["worker_metadata", "provider_metadata"],
        },
        worker: {
          name: "environment-daemon",
          version: "0.0.1",
        },
        providers: [
          {
            providerId: "codex",
            adapterVersion: "0.0.1",
          },
        ],
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
    ).toThrow(/BB_ENV_DAEMON_AUTH_TOKEN/);
  });

  it("rejects invalid http port", () => {
    expect(() =>
      resolveEnvironmentAgentServiceOptions({
        cli: {
          httpPort: "NaN",
        },
        env: {
          BB_ENV_DAEMON_AUTH_TOKEN: "secret-token",
        },
      }),
    ).toThrow(/Invalid --http-port/);
  });

  it("captures provider runtime version when the provider reports one", () => {
    const resolved = resolveEnvironmentAgentServiceOptions({
      cli: {
        providerCommand: "node",
        httpPort: "4123",
      },
      env: {
        BB_THREAD_ID: "thread-1",
        BB_PROJECT_ID: "project-1",
        BB_THREAD_PROVIDER_ID: "codex",
        BB_ENV_DAEMON_AUTH_TOKEN: "secret-token",
      },
    });

    expect(resolved.session.providers).toEqual([
      {
        providerId: "codex",
        adapterVersion: "0.0.1",
        runtimeVersion: expect.stringMatching(/^v\d+\./),
      },
    ]);
    expect(resolved.session.capabilities.features).toContain(
      "provider_runtime_version",
    );
  });

  it("starts session supervision when daemon config is present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/env-daemon/session/open")) {
        return new Response(
          JSON.stringify({
            protocol: "bb.env-daemon.v1",
            type: "session_welcome",
            messageId: "msg-open",
            sessionId: "sess-1",
            sentAt: 1_000,
            payload: {
              leaseTtlMs: 30_000,
              heartbeatIntervalMs: 10_000,
              protocolVersion: 1,
              channels: [],
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/env-daemon/session/commands")) {
        return new Response(
          JSON.stringify({
            protocol: "bb.env-daemon.v1",
            type: "command_batch",
            messageId: "msg-cmd",
            sessionId: "sess-1",
            sentAt: 1_100,
            payload: { commands: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/env-daemon/session/messages")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { type?: string };
        if (body.type === "event_batch") {
          return new Response(
            JSON.stringify({
              protocol: "bb.env-daemon.v1",
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
        return new Response(null, { status: 204 });
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
        filePath: "/tmp/bb-environment-daemon-service-test.log",
      },
      control: {
        endpoint: undefined,
      },
      session: {
        pollIntervalMs: 10_000,
        commandBatchLimit: 10,
        capabilities: {
          commands: [
            "provider.ensure",
            "thread.start",
            "thread.resume",
            "thread.stop",
            "turn.run",
            "thread.rename",
            "workspace.status",
            "workspace.diff",
          ],
          features: ["worker_metadata"],
        },
        worker: {
          name: "environment-daemon",
          version: "0.0.1",
        },
      },
    });

    expect(started.sessionSupervisor).toBeDefined();
    expect(fetchSpy.mock.calls).toContainEqual([
      "http://127.0.0.1:9000/api/v1/threads/thread-1/env-daemon/session/open",
      expect.objectContaining({ method: "POST" }),
    ]);

    await started.close();
  });

  it("returns tool-call responses from session-backed provider requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/env-daemon/session/open")) {
        return new Response(
          JSON.stringify({
            protocol: "bb.env-daemon.v1",
            type: "session_welcome",
            messageId: "msg-open",
            sessionId: "sess-1",
            sentAt: 1_000,
            payload: {
              leaseTtlMs: 30_000,
              heartbeatIntervalMs: 10_000,
              protocolVersion: 1,
              channels: [],
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/env-daemon/session/messages")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          type?: string;
        };
        if (body.type === "provider_request") {
          return new Response(
            JSON.stringify({
              protocol: "bb.env-daemon.v1",
              type: "provider_response",
              messageId: "msg-provider-response",
              sessionId: "sess-1",
              sentAt: 1_200,
              payload: {
                requestId: 62,
                ok: true,
                toolCallResponse: {
                  success: true,
                  contentItems: [{ type: "inputText", text: "ok" }],
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(null, { status: 204 });
      }
      if (url.includes("/env-daemon/session/commands")) {
        return new Response(
          JSON.stringify({
            protocol: "bb.env-daemon.v1",
            type: "command_batch",
            messageId: "msg-cmd",
            sessionId: "sess-1",
            sentAt: 1_100,
            payload: { commands: [] },
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
        providerId: "codex",
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
        filePath: "/tmp/bb-environment-daemon-service-test.log",
      },
      control: {
        endpoint: undefined,
      },
      session: {
        pollIntervalMs: 10_000,
        commandBatchLimit: 10,
        capabilities: {
          commands: [
            "provider.ensure",
            "thread.start",
            "thread.resume",
            "thread.stop",
            "turn.run",
            "thread.rename",
            "workspace.status",
            "workspace.diff",
          ],
          features: ["worker_metadata"],
        },
        worker: {
          name: "environment-daemon",
          version: "0.0.1",
        },
      },
    });

    const onProviderRequest = (
      started.runtime as unknown as {
        opts: {
          onProviderRequest?: (request: {
            requestId: string | number;
            method: string;
            params?: unknown;
            providerId?: string;
            normalizedMethod?: string;
          }) => Promise<unknown>;
        };
      }
    ).opts.onProviderRequest;

    await expect(
      onProviderRequest?.({
        requestId: 62,
        method: "item/tool/call",
        providerId: "codex",
        normalizedMethod: "item/tool/call",
      }),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "ok" }],
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:9000/api/v1/threads/thread-1/env-daemon/session/messages",
      expect.objectContaining({ method: "POST" }),
    );

    await started.close();
  });
});
