import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonObject, JsonValue } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetChatGptCloudflareCookiesForTests } from "./chatgpt-cloudflare-cookies.js";
import {
  completeCodexInference,
  transcribeCodexVoice,
} from "./codex-chatgpt-client.js";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const tempDirs: string[] = [];

interface WriteCodexAuthArgs {
  homeDir: string;
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  openAiApiKey?: string;
}

interface WriteCodexApiKeyAuthArgs {
  homeDir: string;
  apiKey: string;
}

interface CreateAccessTokenArgs {
  expSeconds: number;
  accountId: string;
}

async function makeTempHome(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-codex-auth-"));
  tempDirs.push(tempDir);
  vi.stubEnv("HOME", tempDir);
  return tempDir;
}

function base64UrlJson(value: JsonValue): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createJwt(payload: JsonObject): string {
  return `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson(payload)}.sig`;
}

async function writeCodexAuth(args: WriteCodexAuthArgs): Promise<string> {
  const authDir = path.join(args.homeDir, ".codex");
  await fs.mkdir(authDir, { recursive: true });
  const authPath = path.join(authDir, "auth.json");
  await fs.writeFile(
    authPath,
    `${JSON.stringify(
      {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: args.openAiApiKey,
        tokens: {
          access_token: args.accessToken,
          refresh_token: args.refreshToken,
          account_id: args.accountId,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return authPath;
}

async function writeCodexApiKeyAuth(
  args: WriteCodexApiKeyAuthArgs,
): Promise<string> {
  const authDir = path.join(args.homeDir, ".codex");
  await fs.mkdir(authDir, { recursive: true });
  const authPath = path.join(authDir, "auth.json");
  await fs.writeFile(
    authPath,
    `${JSON.stringify(
      {
        auth_mode: "apikey",
        OPENAI_API_KEY: args.apiKey,
        tokens: null,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return authPath;
}

function createAccessToken(args: CreateAccessTokenArgs): string {
  return createJwt({
    exp: args.expSeconds,
    "https://api.openai.com/auth": {
      chatgpt_account_id: args.accountId,
    },
  });
}

function setupFetchMock(): FetchMock {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sseResponse(events: JsonValue[]): Response {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`,
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    },
  );
}

function stalledSseResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>(), {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

function requiredFetchCall(fetchMock: FetchMock, index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`Missing fetch call at index ${index}`);
  }
  return call;
}

function headersFromInit(init: RequestInit | undefined): Headers {
  const headers = init?.headers;
  if (!(headers instanceof Headers)) {
    throw new Error("Expected request headers to be a Headers instance");
  }
  return headers;
}

function textBodyFromInit(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected request body to be a string");
  }
  return body;
}

function formDataBodyFromInit(init: RequestInit | undefined): FormData {
  const body = init?.body;
  if (!(body instanceof FormData)) {
    throw new Error("Expected request body to be FormData");
  }
  return body;
}

describe("Codex ChatGPT client", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetChatGptCloudflareCookiesForTests();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((tempDir) => fs.rm(tempDir, { force: true, recursive: true })),
    );
  });

  it("runs structured inference with Codex auth from ~/.codex/auth.json", async () => {
    const homeDir = await makeTempHome();
    const accessToken = createAccessToken({
      accountId: "account-123",
      expSeconds: Math.floor(Date.now() / 1000) + 3600,
    });
    await writeCodexAuth({
      homeDir,
      accessToken,
      refreshToken: "refresh-token",
    });
    const fetchMock = setupFetchMock();
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        {
          type: "response.output_text.delta",
          delta: '{"title":"Short title"}',
        },
      ]),
    );

    const result = await completeCodexInference({
      type: "codex.inference.complete",
      model: "gpt-5.4-mini",
      prompt: "Return a title",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string" },
        },
      },
      timeoutMs: 10000,
    });

    expect(result).toEqual({
      model: "gpt-5.4-mini",
      value: { title: "Short title" },
    });
    const [, init] = requiredFetchCall(fetchMock, 0);
    const headers = headersFromInit(init);
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe("account-123");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    const requestBody = JSON.parse(textBodyFromInit(init));
    expect(requestBody).toMatchObject({
      model: "gpt-5.4-mini",
      instructions:
        "Follow the user prompt and respond with structured JSON that matches the requested schema.",
      stream: true,
      text: {
        format: {
          type: "json_schema",
          name: "result",
          strict: true,
        },
      },
    });
  });

  it("runs structured inference with Codex API key auth from ~/.codex/auth.json", async () => {
    const homeDir = await makeTempHome();
    await writeCodexApiKeyAuth({
      homeDir,
      apiKey: "sk-codex-api-key",
    });
    const fetchMock = setupFetchMock();
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        {
          type: "response.output_text.delta",
          delta: '{"title":"OpenAI title"}',
        },
      ]),
    );

    const result = await completeCodexInference({
      type: "codex.inference.complete",
      model: "gpt-5.4-mini",
      prompt: "Return a title",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string" },
        },
      },
      timeoutMs: 10000,
    });

    expect(result).toEqual({
      model: "gpt-5.4-mini",
      value: { title: "OpenAI title" },
    });
    const [url, init] = requiredFetchCall(fetchMock, 0);
    expect(url).toBe("https://api.openai.com/v1/responses");
    const headers = headersFromInit(init);
    expect(headers.get("authorization")).toBe("Bearer sk-codex-api-key");
    expect(headers.get("chatgpt-account-id")).toBeNull();
    const requestBody = JSON.parse(textBodyFromInit(init));
    expect(requestBody).toMatchObject({
      model: "gpt-5.4-mini",
      instructions:
        "Follow the user prompt and respond with structured JSON that matches the requested schema.",
      stream: true,
      text: {
        format: {
          type: "json_schema",
          name: "result",
          strict: true,
        },
      },
    });
  });

  it("uses Codex auth read-only without refreshing expired-looking access tokens", async () => {
    const homeDir = await makeTempHome();
    const oldAccessToken = createAccessToken({
      accountId: "account-old",
      expSeconds: Math.floor(Date.now() / 1000) - 60,
    });
    const authPath = await writeCodexAuth({
      homeDir,
      accessToken: oldAccessToken,
      refreshToken: "old-refresh-token",
    });
    const originalAuthJson = await fs.readFile(authPath, "utf8");
    const fetchMock = setupFetchMock();
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        {
          type: "response.output_text.delta",
          delta: '{"title":"Fresh"}',
        },
      ]),
    );

    await completeCodexInference({
      type: "codex.inference.complete",
      model: "gpt-5.4-mini",
      prompt: "Return a title",
      outputSchema: { type: "object" },
      timeoutMs: 10000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = requiredFetchCall(fetchMock, 0);
    expect(headersFromInit(init).get("authorization")).toBe(
      `Bearer ${oldAccessToken}`,
    );
    expect(headersFromInit(init).get("chatgpt-account-id")).toBe("account-old");
    const requestBody = JSON.parse(textBodyFromInit(init));
    expect(requestBody.text.format.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [],
    });
    await expect(fs.readFile(authPath, "utf8")).resolves.toBe(originalAuthJson);
  });

  it("rejects oversized Codex SSE responses", async () => {
    const homeDir = await makeTempHome();
    await writeCodexApiKeyAuth({
      homeDir,
      apiKey: "sk-codex-api-key",
    });
    const fetchMock = setupFetchMock();
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        {
          type: "response.output_text.delta",
          delta: "x".repeat(2 * 1024 * 1024),
        },
      ]),
    );

    await expect(
      completeCodexInference({
        type: "codex.inference.complete",
        model: "gpt-5.4-mini",
        prompt: "Return a title",
        outputSchema: { type: "object" },
        timeoutMs: 10000,
      }),
    ).rejects.toMatchObject({
      code: "codex_response_too_large",
    });
  });

  it("times out stalled Codex SSE body reads after headers", async () => {
    const homeDir = await makeTempHome();
    await writeCodexApiKeyAuth({
      homeDir,
      apiKey: "sk-codex-api-key",
    });
    const fetchMock = setupFetchMock();
    fetchMock.mockResolvedValueOnce(stalledSseResponse());

    await expect(
      completeCodexInference({
        type: "codex.inference.complete",
        model: "gpt-5.4-mini",
        prompt: "Return a title",
        outputSchema: { type: "object" },
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: "codex_request_timeout",
    });
  });

  it("caps oversized Codex error response bodies", async () => {
    const homeDir = await makeTempHome();
    await writeCodexApiKeyAuth({
      homeDir,
      apiKey: "sk-codex-api-key",
    });
    const fetchMock = setupFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response("x".repeat(10 * 1024), {
        status: 500,
      }),
    );

    let thrown: Error | null = null;
    try {
      await completeCodexInference({
        type: "codex.inference.complete",
        model: "gpt-5.4-mini",
        prompt: "Return a title",
        outputSchema: { type: "object" },
        timeoutMs: 10000,
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new Error("Expected Error from oversized Codex error response");
      }
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "codex_request_failed",
    });
    expect(thrown?.message.length).toBeLessThan(700);
  });

  it("retries ChatGPT transcription once with allowed Cloudflare cookies", async () => {
    const homeDir = await makeTempHome();
    const accessToken = createAccessToken({
      accountId: "account-123",
      expSeconds: Math.floor(Date.now() / 1000) + 3600,
    });
    await writeCodexAuth({
      homeDir,
      accessToken,
      refreshToken: "refresh-token",
    });
    const fetchMock = setupFetchMock();
    fetchMock
      .mockResolvedValueOnce(
        new Response("challenge", {
          status: 403,
          headers: {
            "cf-mitigated": "challenge",
            "set-cookie": "__cf_bm=cloudflare-cookie; Path=/; Secure; HttpOnly",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "hello world" }), {
          status: 200,
        }),
      );

    const result = await transcribeCodexVoice({
      type: "codex.voice.transcribe",
      model: "gpt-4o-mini-transcribe",
      audioBase64: Buffer.from("audio").toString("base64"),
      mimeType: "audio/webm",
      filename: "prompt.webm",
      prompt: null,
      timeoutMs: 30000,
    });

    expect(result).toEqual({
      model: "gpt-4o-mini-transcribe",
      text: "hello world",
    });
    const [, retryInit] = requiredFetchCall(fetchMock, 1);
    const retryHeaders = headersFromInit(retryInit);
    expect(retryHeaders.get("cookie")).toBe("__cf_bm=cloudflare-cookie");
    expect(retryHeaders.get("authorization")).toBe(`Bearer ${accessToken}`);
  });

  it("transcribes voice with Codex API key auth from ~/.codex/auth.json", async () => {
    const homeDir = await makeTempHome();
    await writeCodexApiKeyAuth({
      homeDir,
      apiKey: "sk-codex-api-key",
    });
    const fetchMock = setupFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "hello openai" }), {
        status: 200,
      }),
    );

    const result = await transcribeCodexVoice({
      type: "codex.voice.transcribe",
      model: "gpt-4o-mini-transcribe",
      audioBase64: Buffer.from("audio").toString("base64"),
      mimeType: "audio/webm",
      filename: "prompt.webm",
      prompt: "context",
      timeoutMs: 30000,
    });

    expect(result).toEqual({
      model: "gpt-4o-mini-transcribe",
      text: "hello openai",
    });
    const [url, init] = requiredFetchCall(fetchMock, 0);
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const headers = headersFromInit(init);
    expect(headers.get("authorization")).toBe("Bearer sk-codex-api-key");
    expect(headers.get("cookie")).toBeNull();
    const body = formDataBodyFromInit(init);
    expect(body.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(body.get("prompt")).toBe("context");
  });

  it("rejects oversized Codex transcription responses", async () => {
    const homeDir = await makeTempHome();
    await writeCodexApiKeyAuth({
      homeDir,
      apiKey: "sk-codex-api-key",
    });
    const fetchMock = setupFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          text: "x".repeat(1024 * 1024),
        }),
        {
          status: 200,
        },
      ),
    );

    await expect(
      transcribeCodexVoice({
        type: "codex.voice.transcribe",
        model: "gpt-4o-mini-transcribe",
        audioBase64: Buffer.from("audio").toString("base64"),
        mimeType: "audio/webm",
        filename: "prompt.webm",
        prompt: null,
        timeoutMs: 30000,
      }),
    ).rejects.toMatchObject({
      code: "codex_response_too_large",
    });
  });
});
