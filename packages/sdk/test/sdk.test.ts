import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Environment, JsonValue } from "@bb/domain";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";
import { ThreadWaitTimeoutError } from "../src/areas/threads.js";
import type { FetchImplementation } from "../src/response.js";

interface CapturedRequest {
  bodyText: string | undefined;
  method: string;
  url: string;
}

interface QueuedJsonResponse {
  body: JsonValue;
  status?: number;
}

interface FetchQueue {
  fetch: FetchImplementation;
  requests: CapturedRequest[];
}

type EnvironmentOverrides = Partial<Environment>;

function makeEnvironment(overrides: EnvironmentOverrides = {}): Environment {
  return {
    id: "env_test",
    name: null,
    projectId: "proj_test",
    hostId: "host_test",
    path: "/workspace",
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    workspaceProvisionType: "unmanaged",
    baseBranch: null,
    branchName: null,
    defaultBranch: null,
    mergeBaseBranch: null,
    status: "ready",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeTerminalSession(overrides: Record<string, JsonValue> = {}) {
  return {
    id: "term_test",
    threadId: "thr_test",
    environmentId: "env_test",
    hostId: "host_test",
    title: "Terminal 1",
    initialCwd: "/workspace",
    cols: 100,
    rows: 30,
    status: "running",
    exitCode: null,
    closeReason: null,
    createdAt: 1,
    updatedAt: 2,
    lastUserInputAt: null,
    ...overrides,
  };
}

function bodyText(init: RequestInit | undefined): string | undefined {
  return typeof init?.body === "string" ? init.body : undefined;
}

function jsonResponse(args: QueuedJsonResponse): Response {
  const status = args.status ?? 200;
  if (status === 204) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(args.body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetchQueue(
  responses: readonly QueuedJsonResponse[],
): FetchQueue {
  const requests: CapturedRequest[] = [];
  const remaining = [...responses];
  const fetchMock: FetchImplementation = async (input, init) => {
    requests.push({
      bodyText: bodyText(init),
      method: init?.method ?? "GET",
      url: String(input),
    });
    const next = remaining.shift();
    if (!next) {
      throw new Error("No queued SDK test response");
    }
    return jsonResponse(next);
  };
  return { fetch: fetchMock, requests };
}

describe("@bb/sdk", () => {
  it("sends thread pane presentation actions through the typed transport", async () => {
    const queue = createFetchQueue([{ body: { delivered: 3 } }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.threads.paneAction({
        threadId: "thr_test",
        action: "spotlight",
      }),
    ).resolves.toEqual({ delivered: 3 });
    expect(queue.requests).toEqual([
      {
        bodyText: JSON.stringify({ action: "spotlight" }),
        method: "POST",
        url: "http://bb.test/api/v1/threads/thr_test/pane-action",
      },
    ]);
  });

  it("keeps realtime subscriptions distinct under subscribe", () => {
    const queue = createFetchQueue([]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    expect(typeof sdk.subscribe).toBe("function");
    expect("on" in sdk).toBe(false);
  });

  it("maps thread event filters and reverse pagination onto the public query", async () => {
    const queue = createFetchQueue([{ body: [] }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.threads.events.list({
        beforeSeq: "10",
        limit: "2",
        order: "desc",
        threadId: "thr_test",
        types: ["system/error", "turn/completed"],
      }),
    ).resolves.toEqual([]);
    expect(queue.requests).toEqual([
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/threads/thr_test/events?beforeSeq=10&limit=2&order=desc&types=system%2Ferror%2Cturn%2Fcompleted",
      },
    ]);
  });

  it("forwards read abort signals to fetch", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const fetch: FetchImplementation = async (_input, init) => {
      receivedSignal = init?.signal;
      return jsonResponse({ body: [] });
    };
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.threads.list({ signal: controller.signal }),
    ).resolves.toEqual([]);
    expect(receivedSignal).toBe(controller.signal);
  });

  it("maps personal-project list options while forwarding the abort signal", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const queue = createFetchQueue([{ body: [] }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: async (input, init) => {
          receivedSignal = init?.signal;
          return queue.fetch(input, init);
        },
        runtime: "node",
      }),
    });

    await expect(
      sdk.projects.list({ includePersonal: true, signal: controller.signal }),
    ).resolves.toEqual([]);
    expect(receivedSignal).toBe(controller.signal);
    expect(queue.requests[0]?.url).toBe(
      "http://bb.test/api/v1/projects?includePersonal=true",
    );
  });

  it("sends a complete appearance selection through the theme transport", async () => {
    const appearance = {
      themeId: "nord",
      customCss: null,
      faviconColor: "teal" as const,
      resolvedCodeTheme: {
        dark: "nord",
        light: "nord",
        files: {},
      },
    };
    const queue = createFetchQueue([{ body: appearance }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.theme.set({ themeId: "nord", faviconColor: "teal" }),
    ).resolves.toEqual(appearance);
    expect(queue.requests).toEqual([
      {
        bodyText: JSON.stringify({ themeId: "nord", faviconColor: "teal" }),
        method: "PUT",
        url: "http://bb.test/api/v1/settings/appearance",
      },
    ]);
  });

  it("preserves the favicon color for the theme-id shorthand", async () => {
    const current = {
      appearance: {
        themeId: "dracula",
        customCss: null,
        faviconColor: "purple" as const,
        resolvedCodeTheme: {
          dark: "dracula",
          light: "dracula",
          files: {},
        },
      },
    };
    const updated = {
      themeId: "nord",
      customCss: null,
      faviconColor: "purple" as const,
      resolvedCodeTheme: {
        dark: "nord",
        light: "nord",
        files: {},
      },
    };
    const queue = createFetchQueue([{ body: current }, { body: updated }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(sdk.theme.set("nord")).resolves.toEqual(updated);
    expect(queue.requests).toEqual([
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/system/config",
      },
      {
        bodyText: JSON.stringify({ themeId: "nord", faviconColor: "purple" }),
        method: "PUT",
        url: "http://bb.test/api/v1/settings/appearance",
      },
    ]);
  });

  it("uploads client-local binary attachments as authenticated multipart data", async () => {
    const binary = new Uint8Array([0, 255, 1, 128, 42]);
    let forwardedRequest: Request | undefined;
    const authenticatedFetch: FetchImplementation = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", "Bearer client-token");
      forwardedRequest = new Request(input, { ...init, headers });
      return jsonResponse({
        body: {
          type: "localFile",
          path: "payload-uploaded.bin",
          name: "payload.bin",
          mimeType: "application/x-bb-test",
          sizeBytes: binary.byteLength,
        },
        status: 201,
      });
    };
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "https://remote-bb.test/",
        fetch: authenticatedFetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.projects.attachments.upload({
        clientFile: binary,
        filename: "payload.bin",
        mimeType: "application/x-bb-test",
        projectId: "proj_remote",
      }),
    ).resolves.toEqual({
      type: "localFile",
      path: "payload-uploaded.bin",
      name: "payload.bin",
      mimeType: "application/x-bb-test",
      sizeBytes: binary.byteLength,
    });

    expect(forwardedRequest?.url).toBe(
      "https://remote-bb.test/api/v1/projects/proj_remote/attachments",
    );
    expect(forwardedRequest?.method).toBe("POST");
    expect(forwardedRequest?.headers.get("authorization")).toBe(
      "Bearer client-token",
    );
    expect(forwardedRequest?.headers.get("content-type")).toMatch(
      /^multipart\/form-data; boundary=/u,
    );
    const form = await forwardedRequest?.formData();
    const file = form?.get("file");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) {
      throw new Error("Expected multipart attachment file");
    }
    expect(file.name).toBe("payload.bin");
    expect(file.type).toBe("application/x-bb-test");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(binary);
  });

  it("uses File-like attachment metadata and reads server attachment bytes", async () => {
    const requests: string[] = [];
    const responses = [
      jsonResponse({
        body: {
          type: "localImage",
          path: "pixel-uploaded.png",
          name: "pixel.png",
          mimeType: "image/png",
          sizeBytes: 4,
        },
        status: 201,
      }),
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
    ];
    const fetch: FetchImplementation = async (input) => {
      requests.push(String(input));
      const response = responses.shift();
      if (!response) throw new Error("No queued attachment response");
      return response;
    };
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch,
        runtime: "browser",
      }),
    });

    await sdk.projects.attachments.upload({
      clientFile: new File([new Uint8Array([137, 80, 78, 71])], "pixel.png", {
        type: "image/png",
      }),
      projectId: "proj_image",
    });
    await expect(
      sdk.projects.attachments.read({
        path: "pixel-uploaded.png",
        projectId: "proj_image",
      }),
    ).resolves.toEqual({
      bytes: new Uint8Array([137, 80, 78, 71]),
      mimeType: "image/png",
      sizeBytes: 4,
    });
    expect(requests).toEqual([
      "http://bb.test/api/v1/projects/proj_image/attachments",
      "http://bb.test/api/v1/projects/proj_image/attachments/content?path=pixel-uploaded.png",
    ]);
  });

  it("preserves project attachment error envelopes", async () => {
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: async () =>
          jsonResponse({
            body: {
              code: "invalid_request",
              message: "Attachment exceeds 10MB limit",
            },
            status: 400,
          }),
        runtime: "node",
      }),
    });

    await expect(
      sdk.projects.attachments.upload({
        clientFile: new Uint8Array([1]),
        filename: "huge.png",
        mimeType: "image/png",
        projectId: "proj_remote",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "HTTP 400: Attachment exceeds 10MB limit",
      status: 400,
    });
  });

  it("rejects empty voice transcription blobs without making a request", async () => {
    const fetch = async (): Promise<Response> => {
      throw new Error("Voice transcription should not reach the transport");
    };
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.system.transcribeVoice({ file: new Blob([]) }),
    ).rejects.toThrow("Audio file must not be empty");
  });

  it("routes project file APIs and returns portable text/binary DTOs", async () => {
    const requests: CapturedRequest[] = [];
    const responses = [
      jsonResponse({
        body: {
          files: [{ name: "remote.txt", path: "remote.txt" }],
          truncated: false,
        },
      }),
      new Response("remote text", {
        headers: {
          "content-type": "text/plain",
          "x-bb-content-encoding": "utf8",
        },
      }),
      new Response(new Uint8Array([0, 1, 254, 255]), {
        headers: {
          "content-type": "application/octet-stream",
          "x-bb-content-encoding": "base64",
        },
      }),
    ];
    const fetch: FetchImplementation = async (input, init) => {
      requests.push({
        bodyText: bodyText(init),
        method: init?.method ?? "GET",
        url: String(input),
      });
      const response = responses.shift();
      if (!response) throw new Error("No queued project file response");
      return response;
    };
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch,
        runtime: "browser",
      }),
    });

    await expect(
      sdk.projects.files({
        projectId: "proj_remote",
        hostId: "host_remote",
      }),
    ).resolves.toMatchObject({ files: [{ path: "remote.txt" }] });
    await expect(
      sdk.projects.fileContent({
        projectId: "proj_remote",
        environmentId: "env_remote",
        path: "remote.txt",
      }),
    ).resolves.toEqual({
      content: "remote text",
      contentEncoding: "utf8",
      mimeType: "text/plain",
      sizeBytes: 11,
    });
    await expect(
      sdk.projects.fileContent({
        projectId: "proj_remote",
        hostId: "host_remote",
        path: "image.bin",
      }),
    ).resolves.toEqual({
      content: "AAH+/w==",
      contentEncoding: "base64",
      mimeType: "application/octet-stream",
      sizeBytes: 4,
    });

    expect(requests.map((request) => request.url)).toEqual([
      "http://bb.test/api/v1/projects/proj_remote/files?hostId=host_remote",
      "http://bb.test/api/v1/projects/proj_remote/files/content?environmentId=env_remote&path=remote.txt",
      "http://bb.test/api/v1/projects/proj_remote/files/content?hostId=host_remote&path=image.bin",
    ]);
  });

  it("routes provider list and model discovery through portable host selectors", async () => {
    const queue = createFetchQueue([
      { body: [] },
      {
        body: {
          providers: [],
          models: [],
          selectedOnlyModels: [],
          modelLoadError: null,
        },
      },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.providers.list({ capability: "usage", hostId: "host_remote" }),
    ).resolves.toEqual([]);
    await expect(
      sdk.providers.models({
        environmentId: "env_remote",
        providerId: "acp-remote",
      }),
    ).resolves.toMatchObject({ models: [], providers: [] });

    expect(queue.requests).toEqual([
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/system/providers?capability=usage&hostId=host_remote",
      },
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/system/execution-options?environmentId=env_remote&providerId=acp-remote",
      },
    ]);
  });

  it("targets provider usage at an explicit machine", async () => {
    const usage = {
      codex: { status: "unauthenticated" as const },
      "claude-code": { status: "unauthenticated" as const },
      "acp-cursor": { status: "unauthenticated" as const },
    };
    const queue = createFetchQueue([{ body: usage }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.system.usageLimits({
        hostId: "host_remote",
        providerId: "codex",
      }),
    ).resolves.toEqual(usage);
    expect(queue.requests).toEqual([
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/system/usage-limits?hostId=host_remote&providerId=codex",
      },
    ]);
  });

  it("routes onboarding agent status through a reused environment", async () => {
    const states = { providers: [] };
    const queue = createFetchQueue([{ body: states }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.system.providerStates({ environmentId: "env_remote" }),
    ).resolves.toEqual(states);
    expect(queue.requests).toEqual([
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/system/providers/state?environmentId=env_remote",
      },
    ]);
  });

  it("routes thread list calls through the HTTP transport", async () => {
    const queue = createFetchQueue([{ body: [] }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.threads.list({ archived: true, projectId: "proj_123" }),
    ).resolves.toEqual([]);

    expect(queue.requests).toEqual([
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/threads?projectId=proj_123&archived=true",
      },
    ]);
  });

  it("routes bounded thread mention resolution through one HTTP request", async () => {
    const resolved = [
      {
        threadId: "thr_23456789ab",
        projectId: "proj_target",
        label: "Target thread",
      },
    ];
    const queue = createFetchQueue([{ body: resolved }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.threads.resolveMentions({
        threadIds: ["thr_23456789ab", "thr_23456789ab"],
      }),
    ).resolves.toEqual(resolved);
    expect(queue.requests).toEqual([
      {
        bodyText: JSON.stringify({
          threadIds: ["thr_23456789ab", "thr_23456789ab"],
        }),
        method: "POST",
        url: "http://bb.test/api/v1/threads/resolve-mentions",
      },
    ]);
  });

  it("routes canonical terminal calls across every scope and by terminal ID", async () => {
    const session = makeTerminalSession();
    const queue = createFetchQueue([
      { body: { sessions: [session] } },
      { body: { sessions: [session] } },
      { body: { sessions: [session] } },
      { body: session, status: 201 },
      { body: session, status: 201 },
      { body: session, status: 201 },
      { body: session },
      { body: { ...session, title: "Dev server" } },
      { body: { ...session, lastUserInputAt: 3 } },
      { body: { ...session, cols: 120, rows: 40 } },
      { body: { chunks: [], nextSeq: 4, truncated: false } },
      { body: { ...session, status: "exited", closeReason: "user" } },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.terminals.list({
      scope: { kind: "thread", threadId: "thr_remote" },
    });
    await sdk.terminals.list({
      scope: { kind: "environment", environmentId: "env_remote" },
    });
    await sdk.terminals.list({
      scope: {
        kind: "host_path",
        hostId: "host_remote",
        cwd: "/srv/app",
      },
    });
    await sdk.terminals.create({
      cols: 80,
      rows: 24,
      scope: { kind: "thread", threadId: "thr_remote" },
    });
    await sdk.terminals.create({
      cols: 80,
      rows: 24,
      scope: { kind: "environment", environmentId: "env_remote" },
    });
    await sdk.terminals.create({
      cols: 80,
      rows: 24,
      scope: { kind: "host_path", hostId: "host_remote", cwd: null },
    });
    await sdk.terminals.get({ terminalId: "term_remote" });
    await sdk.terminals.rename({
      terminalId: "term_remote",
      title: "Dev server",
    });
    await sdk.terminals.input({
      terminalId: "term_remote",
      dataBase64: "aGk=",
    });
    await sdk.terminals.resize({
      terminalId: "term_remote",
      cols: 120,
      rows: 40,
    });
    await sdk.terminals.output({
      terminalId: "term_remote",
      sinceSeq: 2,
      tailBytes: 1024,
      limitChunks: 10,
    });
    await sdk.terminals.close({
      terminalId: "term_remote",
      mode: "force",
    });

    expect(queue.requests).toEqual([
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/terminals?threadId=thr_remote",
      },
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/terminals?environmentId=env_remote",
      },
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/terminals?hostId=host_remote&cwd=%2Fsrv%2Fapp",
      },
      {
        bodyText: JSON.stringify({
          cols: 80,
          rows: 24,
          target: { kind: "thread", threadId: "thr_remote" },
        }),
        method: "POST",
        url: "http://bb.test/api/v1/terminals",
      },
      {
        bodyText: JSON.stringify({
          cols: 80,
          rows: 24,
          target: { kind: "environment", environmentId: "env_remote" },
        }),
        method: "POST",
        url: "http://bb.test/api/v1/terminals",
      },
      {
        bodyText: JSON.stringify({
          cols: 80,
          rows: 24,
          target: { kind: "host_path", hostId: "host_remote", cwd: null },
        }),
        method: "POST",
        url: "http://bb.test/api/v1/terminals",
      },
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/terminals/term_remote",
      },
      {
        bodyText: JSON.stringify({ title: "Dev server" }),
        method: "PATCH",
        url: "http://bb.test/api/v1/terminals/term_remote",
      },
      {
        bodyText: JSON.stringify({ dataBase64: "aGk=" }),
        method: "POST",
        url: "http://bb.test/api/v1/terminals/term_remote/input",
      },
      {
        bodyText: JSON.stringify({ cols: 120, rows: 40 }),
        method: "POST",
        url: "http://bb.test/api/v1/terminals/term_remote/resize",
      },
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/terminals/term_remote/output?sinceSeq=2&tailBytes=1024&limitChunks=10",
      },
      {
        bodyText: JSON.stringify({ mode: "force", reason: "user" }),
        method: "POST",
        url: "http://bb.test/api/v1/terminals/term_remote/close",
      },
    ]);
  });

  it("restarts a terminal without requiring its scope from the caller", async () => {
    const replacement = makeTerminalSession({ id: "term_new" });
    const queue = createFetchQueue([{ body: replacement, status: 201 }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.terminals.restart({ terminalId: "term_old" }),
    ).resolves.toMatchObject({ id: "term_new" });
    expect(queue.requests).toEqual([
      {
        bodyText: JSON.stringify({}),
        method: "POST",
        url: "http://bb.test/api/v1/terminals/term_old/restart",
      },
    ]);
  });

  it("rejects mixed terminal scope selectors before transport", async () => {
    const queue = createFetchQueue([]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.terminals.list({
        // @ts-expect-error Mixed scopes are rejected by the public contract.
        scope: {
          kind: "thread",
          threadId: "thr_one",
          environmentId: "env_two",
        },
      }),
    ).rejects.toThrow("cannot include environment or host selectors");
    expect(queue.requests).toEqual([]);
  });

  it("normalizes HTTP error responses through the transport", async () => {
    const queue = createFetchQueue([
      {
        body: { message: "Thread not found" },
        status: 404,
      },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(sdk.threads.get({ threadId: "thr_missing" })).rejects.toThrow(
      "HTTP 404: Thread not found",
    );
  });

  it("routes environment pull request calls through the HTTP transport", async () => {
    const response = { outcome: "absent" };
    const queue = createFetchQueue([{ body: response }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.environments.pullRequest({ environmentId: "env_pr" }),
    ).resolves.toEqual(response);

    expect(queue.requests).toEqual([
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/environments/env_pr/pull-request",
      },
    ]);
  });

  it("updates environment metadata through the HTTP transport", async () => {
    const environment = makeEnvironment({
      id: "env_update",
      name: "Review workspace",
      mergeBaseBranch: "release",
    });
    const queue = createFetchQueue([{ body: environment }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.environments.update({
        environmentId: "env_update",
        mergeBaseBranch: "release",
        name: "Review workspace",
      }),
    ).resolves.toEqual(environment);

    expect(queue.requests).toEqual([
      {
        bodyText: JSON.stringify({
          mergeBaseBranch: "release",
          name: "Review workspace",
        }),
        method: "PATCH",
        url: "http://bb.test/api/v1/environments/env_update",
      },
    ]);
  });

  it("rejects empty environment updates before sending a request", async () => {
    const queue = createFetchQueue([]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      // @ts-expect-error Environment update requires at least one update field.
      sdk.environments.update({ environmentId: "env_update" }),
    ).rejects.toThrow("At least one field must be provided");
    expect(queue.requests).toEqual([]);
  });

  it("fills thread spawn defaults before sending a request", async () => {
    const queue = createFetchQueue([{ body: { id: "thr_1" }, status: 201 }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.threads.spawn({
      projectId: "proj_123",
      environment: {
        type: "host",
        hostId: "host_123",
        workspace: { type: "unmanaged", path: null },
      },
      prompt: "Ship it",
    });

    expect(queue.requests[0]?.bodyText).toBe(
      JSON.stringify({
        projectId: "proj_123",
        environment: {
          type: "host",
          hostId: "host_123",
          workspace: { type: "unmanaged", path: null },
        },
        input: [{ type: "text", text: "Ship it", mentions: [] }],
        origin: "sdk",
        startedOnBehalfOf: null,
        originKind: null,
      }),
    );
  });

  it("defaults thread forks to source-environment reuse and preserves an agent-only context seed", async () => {
    const queue = createFetchQueue([{ body: { id: "thr_fork" }, status: 201 }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.threads.fork({
      sourceThreadId: "thr_source",
      agentContextSeed: [
        {
          type: "text",
          text: "Selected reply anchor",
          mentions: [],
          visibility: "agent-only",
        },
      ],
    });

    expect(queue.requests[0]).toMatchObject({
      method: "POST",
      url: "http://bb.test/api/v1/threads/fork",
    });
    expect(JSON.parse(queue.requests[0]?.bodyText ?? "{}")).toEqual({
      sourceThreadId: "thr_source",
      agentContextSeed: [
        {
          type: "text",
          text: "Selected reply anchor",
          mentions: [],
          visibility: "agent-only",
        },
      ],
      origin: "sdk",
      visibility: "visible",
    });
  });

  it("forwards includeHidden list filtering and visibility updates", async () => {
    const queue = createFetchQueue([
      { body: [] },
      { body: { id: "thr_hidden", visibility: "hidden" } },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.threads.list({ includeHidden: true });
    await sdk.threads.update({
      threadId: "thr_hidden",
      visibility: "hidden",
    });

    expect(queue.requests[0]?.url).toBe(
      "http://bb.test/api/v1/threads?includeHidden=true",
    );
    expect(JSON.parse(queue.requests[1]?.bodyText ?? "{}")).toEqual({
      visibility: "hidden",
    });
  });

  it("forwards every public permission mode through thread surfaces", async () => {
    const queue = createFetchQueue([
      { body: { id: "thr_auto" }, status: 201 },
      { body: { ok: true, delivery: "sent" } },
      { body: { id: "qmsg_full" }, status: 201 },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.threads.spawn({
      projectId: "proj_123",
      environment: {
        type: "host",
        hostId: "host_123",
        workspace: { type: "unmanaged", path: null },
      },
      permissionMode: "auto",
      prompt: "Approve for me",
    });
    await sdk.threads.send({
      threadId: "thr_auto",
      input: [{ type: "text", text: "Accept edits", mentions: [] }],
      mode: "start",
      permissionMode: "accept-edits",
    });
    await sdk.threads.queuedMessages.create({
      threadId: "thr_auto",
      input: [{ type: "text", text: "Full access", mentions: [] }],
      permissionMode: "full",
    });

    expect(
      queue.requests.map((request) => JSON.parse(request.bodyText ?? "{}")),
    ).toEqual([
      expect.objectContaining({ permissionMode: "auto" }),
      expect.objectContaining({ permissionMode: "accept-edits" }),
      expect.objectContaining({ permissionMode: "full" }),
    ]);
  });

  it("submits an atomic message edit", async () => {
    const queue = createFetchQueue([
      {
        body: {
          ok: true,
          operationId: "edit-op-1",
          requestSequence: 43,
        },
      },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.threads.editMessage({
        threadId: "thr_edit",
        operationId: "edit-op-1",
        expectedRequestSequence: 41,
        input: [{ type: "text", text: "Replacement", mentions: [] }],
      }),
    ).resolves.toMatchObject({ requestSequence: 43 });

    expect(queue.requests).toEqual([
      {
        bodyText: JSON.stringify({
          operationId: "edit-op-1",
          expectedRequestSequence: 41,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        }),
        method: "POST",
        url: "http://bb.test/api/v1/threads/thr_edit/edit-message",
      },
    ]);
  });

  it("preserves explicit thread spawn origin for CLI callers", async () => {
    const queue = createFetchQueue([{ body: { id: "thr_1" }, status: 201 }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.threads.spawn({
      projectId: "proj_123",
      origin: "cli",
      environment: {
        type: "host",
        hostId: "host_123",
        workspace: { type: "unmanaged", path: null },
      },
      input: [{ type: "text", text: "From CLI", mentions: [] }],
      visibility: "hidden",
    });

    expect(JSON.parse(queue.requests[0]?.bodyText ?? "{}")).toMatchObject({
      origin: "cli",
      visibility: "hidden",
    });
  });

  it("preserves section assignment in thread updates", async () => {
    const queue = createFetchQueue([
      {
        body: {
          id: "thr_section",
          projectId: "proj_123",
          status: "idle",
          title: null,
        },
      },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.threads.update({
      threadId: "thr_section",
      sectionId: "sec_123",
    });

    expect(queue.requests[0]).toEqual({
      bodyText: JSON.stringify({ sectionId: "sec_123" }),
      method: "PATCH",
      url: "http://bb.test/api/v1/threads/thr_section",
    });
  });

  it("sends the queued message version when updating its content", async () => {
    const queue = createFetchQueue([{ body: { id: "qmsg_123" } }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.threads.queuedMessages.update({
      threadId: "thr_123",
      queuedMessageId: "qmsg_123",
      expectedUpdatedAt: 42,
      input: [{ type: "text", text: "Edited", mentions: [] }],
    });

    expect(queue.requests[0]).toEqual({
      bodyText: JSON.stringify({
        expectedUpdatedAt: 42,
        input: [{ type: "text", text: "Edited", mentions: [] }],
      }),
      method: "PATCH",
      url: "http://bb.test/api/v1/threads/thr_123/queued-messages/qmsg_123",
    });
  });

  // The queue list is cross-thread by design: an omitted filter drops out of
  // the query string entirely rather than narrowing on `undefined`.
  it("routes queued-row reads onto the cross-thread queue route and a row's own operations onto its thread", async () => {
    const queue = createFetchQueue([
      { body: [] },
      { body: { ok: true, delivery: "sent" } },
      { body: null, status: 204 },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.threads.queue.list();
    await sdk.threads.queuedMessages.send({
      threadId: "thr_123",
      queuedMessageId: "qm_1",
      mode: "auto",
    });
    await sdk.threads.queuedMessages.delete({
      threadId: "thr_123",
      queuedMessageId: "qm_1",
    });

    expect(
      queue.requests.map((request) => `${request.method} ${request.url}`),
    ).toEqual([
      "GET http://bb.test/api/v1/queued-messages?",
      "POST http://bb.test/api/v1/threads/thr_123/queued-messages/qm_1/send",
      "DELETE http://bb.test/api/v1/threads/thr_123/queued-messages/qm_1",
    ]);
    expect(queue.requests[1].bodyText).toBe(JSON.stringify({ mode: "auto" }));
  });

  it("applies both queue list filters and queues a scheduled send on the queue", async () => {
    const queue = createFetchQueue([
      { body: [] },
      {
        body: {
          ok: true,
          delivery: "queued",
          queuedMessage: {
            id: "qm_1",
            waitingOn: { kind: "time" },
            sendAt: 1750,
          },
        },
      },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.threads.queue.list({
      threadId: "thr_123",
      waitHolder: "plugin:concurrency-limit",
    });
    await expect(
      sdk.threads.send({
        threadId: "thr_123",
        input: [{ type: "text", text: "later", mentions: [] }],
        mode: "auto",
        sendAt: 1750,
      }),
    ).resolves.toEqual({
      ok: true,
      delivery: "queued",
      queuedMessage: {
        id: "qm_1",
        waitingOn: { kind: "time" },
        sendAt: 1750,
      },
    });

    expect(queue.requests[0].url).toBe(
      "http://bb.test/api/v1/queued-messages?threadId=thr_123&waitHolder=plugin%3Aconcurrency-limit",
    );
    expect(queue.requests[1].bodyText).toBe(
      JSON.stringify({
        input: [{ type: "text", text: "later", mentions: [] }],
        mode: "auto",
        sendAt: 1750,
      }),
    );
  });

  // A limiter gate counts on every dispatch, so an omitted filter must drop out
  // of the query string rather than narrow the count on the string "undefined".
  it("counts threads over the grouped count route with only the given filters", async () => {
    const queue = createFetchQueue([
      { body: { total: 4 } },
      {
        body: {
          total: 4,
          groups: [
            { key: "host_a", count: 3 },
            { key: null, count: 1 },
          ],
        },
      },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(sdk.threads.count()).resolves.toEqual({ total: 4 });
    await expect(
      sdk.threads.count({
        status: "active",
        hostId: "host_a",
        providerId: "codex",
        projectId: "proj_123",
        // The root-parent sentinel: "threads with no parent at all".
        parentThreadId: "none",
        groupBy: "host",
      }),
    ).resolves.toEqual({
      total: 4,
      groups: [
        { key: "host_a", count: 3 },
        { key: null, count: 1 },
      ],
    });

    expect(queue.requests[0].url).toBe("http://bb.test/api/v1/threads/count?");
    expect(queue.requests[1].url).toBe(
      "http://bb.test/api/v1/threads/count?status=active&hostId=host_a&providerId=codex&projectId=proj_123&parentThreadId=none&groupBy=host",
    );
  });

  it("lists the running threads over the running route with no query", async () => {
    const rows = [
      { id: "thr_a", hostId: "host_a" },
      // Admitted but not yet placed: counts globally, on no host's pool.
      { id: "thr_b", hostId: null },
    ];
    const queue = createFetchQueue([{ body: rows }]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(sdk.threads.listRunning()).resolves.toEqual(rows);
    // No filters at all: the occupying set is small, and a caller that needs
    // more than "which ids, on which hosts" fetches the threads it named.
    expect(queue.requests[0].url).toBe("http://bb.test/api/v1/threads/running");
  });

  it("exposes thread section mutations", async () => {
    const queue = createFetchQueue([
      {
        body: {
          id: "sec_123",
          name: "Review",
          createdAt: 1,
          updatedAt: 1,
        },
        status: 201,
      },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.threadSections.create({ name: "Review" }),
    ).resolves.toMatchObject({ id: "sec_123", name: "Review" });
    expect(queue.requests[0]).toEqual({
      bodyText: JSON.stringify({ name: "Review" }),
      method: "POST",
      url: "http://bb.test/api/v1/thread-sections",
    });
  });

  it("validates typed plugin RPC results", async () => {
    const queue = createFetchQueue([
      {
        body: {
          ok: true,
          result: { instructions: "Run tests." },
        },
      },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test/",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.plugins.callRpc({
        pluginId: "custom-instructions",
        method: "getInstructions",
        input: null,
        outputSchema: z.object({ instructions: z.string() }),
      }),
    ).resolves.toEqual({ instructions: "Run tests." });
    expect(queue.requests[0]).toEqual({
      bodyText: "null",
      method: "POST",
      url: "http://bb.test/api/v1/plugins/custom-instructions/rpc/getInstructions",
    });
  });

  it("routes every typed plugin administration method through the transport", async () => {
    const plugin = {
      id: "notes",
      source: "npm:@bb/notes@^1",
      rootDir: "/plugins/notes",
      version: "1.2.0",
      provenance: "catalog" as const,
      isOrphanedBuiltin: false,
      catalogEntryId: "notes",
      publisherLabel: "BB Community",
      sourceDisplay: "npm · @bb/notes · tracks compatible",
      updateState: {},
      enabled: true,
      description: "Notes",
      name: "Notes",
      screenshots: [],
      collections: [],
      icon: null,
      iconUrl: null,
      status: "running" as const,
      statusDetail: null,
      handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
      services: [],
      schedules: [],
      cliCommand: null,
      capabilities: [],
      hasSettings: false,
      app: { hasApp: false, bundle: null },
      logoUrl: null,
      logoDarkUrl: null,
      providerIds: [],
      icons: {},
    };
    const catalog = {
      pluginCount: 1,
      includedPluginCount: 1,
      optionalPluginCount: 0,
    };
    const checked = {
      id: "notes",
      outcome: "update-available" as const,
      installed: { version: "1.2.0", display: "1.2.0" },
      candidate: { version: "1.3.0", display: "1.3.0" },
    };
    const queue = createFetchQueue([
      { body: { plugins: [plugin] } },
      { body: { ok: true, plugin } },
      { body: { ok: true, plugin } },
      {
        body: {
          requested: "npm:@bb/notes@^1",
          resolved: "1.2.0",
          engines: { bb: ">=0.9", bbPluginSdk: "^0.2.0" },
          installedAt: 5,
          history: [{ version: "1.2.0", activatedAt: 5 }],
        },
      },
      { body: { results: [checked] } },
      { body: { results: [checked] } },
      {
        body: {
          applied: false,
          from: checked.installed,
          to: checked.candidate,
          outcome: "rolled-back",
          detail: "activation failed; restored 1.2.0",
        },
      },
      { body: { catalog } },
      {
        body: {
          results: [
            {
              entryId: "notes",
              pluginId: "notes",
              displayName: "Notes",
              description: "Notes",
              icon: null,
              iconUrl: null,
              category: "Productivity",
              source: "npm:@bb/notes@^1",
              marketplace: "acme-plugins",
              marketplaceDisplayName: "Acme Plugins",
              publisherKey: "acme-plugins",
              publisherLabel: "Acme Plugins",
              official: false,
              author: { name: "Acme", url: null },
              installed: true,
              compatible: true,
              incompatibleReason: null,
            },
          ],
          collections: [
            {
              id: "featured",
              displayName: "Featured",
              pluginIds: ["notes"],
            },
          ],
        },
      },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test/",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(sdk.plugins.list()).resolves.toEqual({ plugins: [plugin] });
    await expect(
      sdk.plugins.install({ source: "npm:@bb/notes@^1" }),
    ).resolves.toEqual(plugin);
    await expect(
      sdk.plugins.catalog.install({
        entryId: "notes",
      }),
    ).resolves.toEqual(plugin);
    await expect(
      sdk.plugins.getSource({ pluginId: "notes" }),
    ).resolves.toMatchObject({ history: [{ version: "1.2.0" }] });
    await expect(
      sdk.plugins.checkUpdates({ pluginId: "notes" }),
    ).resolves.toEqual([checked]);
    await expect(sdk.plugins.listUpdateResults()).resolves.toEqual([checked]);
    await expect(
      sdk.plugins.applyUpdate({ pluginId: "notes" }),
    ).resolves.toMatchObject({ outcome: "rolled-back", applied: false });
    await expect(sdk.plugins.catalog.status()).resolves.toEqual(catalog);
    await expect(
      sdk.plugins.catalog.search({ query: "notes" }),
    ).resolves.toMatchObject({
      results: [{ entryId: "notes", pluginId: "notes", compatible: true }],
      collections: [
        {
          id: "featured",
          displayName: "Featured",
          pluginIds: ["notes"],
        },
      ],
    });
    expect(queue.requests).toEqual([
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/plugins",
      },
      {
        bodyText: JSON.stringify({
          source: "npm:@bb/notes@^1",
        }),
        method: "POST",
        url: "http://bb.test/api/v1/plugins/install",
      },
      {
        bodyText: JSON.stringify({
          entryId: "notes",
        }),
        method: "POST",
        url: "http://bb.test/api/v1/plugin-catalog/install",
      },
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/plugins/notes/source",
      },
      {
        bodyText: JSON.stringify({ id: "notes" }),
        method: "POST",
        url: "http://bb.test/api/v1/plugins/updates/check",
      },
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/plugins/updates",
      },
      {
        bodyText: "{}",
        method: "POST",
        url: "http://bb.test/api/v1/plugins/notes/update",
      },
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/plugin-catalog",
      },
      {
        bodyText: undefined,
        method: "GET",
        url: "http://bb.test/api/v1/plugin-catalog/search?q=notes",
      },
    ]);
  });

  it("sends a nested-plugin selection and refuses two selectors at once", async () => {
    const plugin = { id: "notes" };
    const queue = createFetchQueue([
      { body: { ok: true, plugin } },
      { body: { ok: true, plugin } },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.plugins
      .install({ source: "git:github.com/acme/repo@main", plugin: "notes" })
      .catch(() => undefined);
    await sdk.plugins
      .install({
        source: "path:/work/repo",
        subdirectory: "plugins/notes",
      })
      .catch(() => undefined);

    expect(queue.requests.map((request) => request.bodyText)).toEqual([
      JSON.stringify({
        source: "git:github.com/acme/repo@main",
        selection: { kind: "entry", name: "notes" },
      }),
      JSON.stringify({
        source: "path:/work/repo",
        selection: { kind: "subdirectory", path: "plugins/notes" },
      }),
    ]);
    await expect(
      sdk.plugins.install({
        source: "path:/work/repo",
        plugin: "notes",
        subdirectory: "plugins/notes",
      }),
    ).rejects.toThrow(/not both/);
  });

  it("surfaces typed plugin update failures as HTTP errors", async () => {
    const queue = createFetchQueue([
      { body: { error: "candidate unavailable" }, status: 422 },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.plugins.applyUpdate({ pluginId: "notes" }),
    ).rejects.toThrow("candidate unavailable");
  });

  it("rejects thread spawn requests with both prompt and input", async () => {
    const queue = createFetchQueue([]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.threads.spawn({
        projectId: "proj_123",
        environment: {
          type: "host",
          hostId: "host_123",
          workspace: { type: "unmanaged", path: null },
        },
        prompt: "Ship it",
        // @ts-expect-error Runtime guard rejects callers that bypass the union.
        input: [{ type: "text", text: "Duplicate", mentions: [] }],
      }),
    ).rejects.toThrow("Provide only one of input or prompt.");
    expect(queue.requests).toEqual([]);
  });

  it("waits for a thread status through the shared SDK loop", async () => {
    const queue = createFetchQueue([
      { body: { id: "thr_wait", status: "active" } },
      { body: { id: "thr_wait", status: "idle" } },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.threads.wait({
        threadId: "thr_wait",
        status: "idle",
        timeoutMs: 1_000,
        pollIntervalMs: 1,
      }),
    ).resolves.toMatchObject({
      matched: true,
      target: { kind: "status", status: "idle" },
      threadId: "thr_wait",
    });

    expect(queue.requests.map((request) => request.url)).toEqual([
      "http://bb.test/api/v1/threads/thr_wait",
      "http://bb.test/api/v1/threads/thr_wait",
    ]);
  });

  it("throws a typed timeout error from thread wait", async () => {
    const queue = createFetchQueue([
      { body: { id: "thr_wait", status: "active" } },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.threads.wait({
        threadId: "thr_wait",
        status: "idle",
        timeoutMs: 0,
        pollIntervalMs: 1,
      }),
    ).rejects.toBeInstanceOf(ThreadWaitTimeoutError);
  });

  it("exposes installed skills and canonical registry installation", async () => {
    const registrySkill = {
      id: "owner/repo/useful-skill",
      source: "owner/repo",
      skillId: "useful-skill",
      name: "Useful skill",
      installs: 12,
      stars: null,
      installUrl: "https://github.com/owner/repo",
      url: "https://www.skills.sh/owner/repo/useful-skill",
      topic: null,
      summary: null,
    };
    const queue = createFetchQueue([
      {
        body: {
          skills: [
            {
              id: `skill_${"a".repeat(64)}`,
              name: "local-skill",
              description: null,
              provider: null,
              scope: "bb-user",
              pluginId: null,
              filePath: "/skills/local-skill/SKILL.md",
              manageable: true,
              registrySkillId: null,
            },
          ],
        },
      },
      {
        body: {
          skills: [registrySkill],
          pagination: { page: 0, perPage: 24, total: 1, hasMore: false },
          ranking: "trending",
        },
      },
      { body: { stars: 27_053 } },
      { body: { ok: true, filePath: "/skills/useful-skill/SKILL.md" } },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.skills.list({ projectId: "proj_123", environmentId: null }),
    ).resolves.toMatchObject({ skills: [{ name: "local-skill" }] });
    await expect(sdk.skills.registry.search()).resolves.toMatchObject({
      skills: [registrySkill],
    });
    await expect(
      sdk.skills.registry.repositoryStars({ source: registrySkill.source }),
    ).resolves.toEqual({ stars: 27_053 });
    await expect(
      sdk.skills.registry.install({
        registrySkillId: registrySkill.id,
      }),
    ).resolves.toEqual({
      ok: true,
      filePath: "/skills/useful-skill/SKILL.md",
    });

    expect(queue.requests).toEqual([
      {
        method: "GET",
        url: "http://bb.test/api/v1/projects/proj_123/skills?environmentId=",
        bodyText: undefined,
      },
      {
        method: "GET",
        url: "http://bb.test/api/v1/skills-registry?page=0&perPage=24",
        bodyText: undefined,
      },
      {
        method: "GET",
        url: "http://bb.test/api/v1/skills-registry/repository-stars?source=owner%2Frepo",
        bodyText: undefined,
      },
      {
        method: "POST",
        url: "http://bb.test/api/v1/skills-registry/install",
        bodyText: JSON.stringify({
          registrySkillId: registrySkill.id,
        }),
      },
    ]);
  });

  it("uses opaque skill identities and compare-and-swap revisions", async () => {
    const skillId = `skill_${"a".repeat(64)}`;
    const revision = "b".repeat(64);
    const queue = createFetchQueue([
      { body: { content: "# Review", revision } },
      { body: { files: ["SKILL.md"], truncated: false } },
      {
        body: {
          filePath: "/skills/review/SKILL.md",
          revision: "c".repeat(64),
        },
      },
      { body: { deletedPath: "/skills/review" } },
    ]);
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch: queue.fetch,
        runtime: "node",
      }),
    });

    await sdk.skills.getContent({
      projectId: "proj_123",
      environmentId: null,
      skillId,
      path: "SKILL.md",
    });
    await sdk.skills.listFiles({
      projectId: "proj_123",
      environmentId: null,
      skillId,
    });
    await sdk.skills.update({
      projectId: "proj_123",
      environmentId: null,
      skillId,
      content: "# Updated",
      revision,
    });
    await sdk.skills.remove({
      projectId: "proj_123",
      environmentId: null,
      skillId,
    });

    expect(queue.requests).toEqual([
      {
        method: "GET",
        url: `http://bb.test/api/v1/projects/proj_123/skills/content?skillId=${skillId}&path=SKILL.md&environmentId=`,
        bodyText: undefined,
      },
      {
        method: "GET",
        url: `http://bb.test/api/v1/projects/proj_123/skills/files?skillId=${skillId}&environmentId=`,
        bodyText: undefined,
      },
      {
        method: "PATCH",
        url: "http://bb.test/api/v1/projects/proj_123/skills/content",
        bodyText: JSON.stringify({
          skillId,
          environmentId: null,
          content: "# Updated",
          revision,
        }),
      },
      {
        method: "DELETE",
        url: "http://bb.test/api/v1/projects/proj_123/skills",
        bodyText: JSON.stringify({ skillId, environmentId: null }),
      },
    ]);
  });
});
