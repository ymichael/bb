import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateOpenAIResponsesText } from "../openai-responses-model.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const ORIGINAL_BB_INFERENCE_MODEL = process.env.BB_INFERENCE_MODEL;

interface FetchCall {
  endpoint: string;
  headers: Headers;
  body: Record<string, unknown>;
}

async function writeAuthJson(homePath: string, payload: Record<string, unknown>): Promise<void> {
  const codexDir = join(homePath, ".codex");
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "auth.json"), JSON.stringify(payload), "utf8");
}

function mockResponsesSuccessFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "resp_123",
        output_text: "fix(commit): improve auth handling",
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockResponsesNestedOutputFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "resp_nested",
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "fix " },
              { type: "output_text", output_text: "bug" },
            ],
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockSseResponsesSuccessFetch(): ReturnType<typeof vi.fn> {
  const sseBody = [
    "event: response.created",
    'data: {"type":"response.created","response":{"id":"resp_stream"}}',
    "",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"fix"}',
    "",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":" bug"}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"id":"resp_stream","output":[{"type":"message","content":[{"type":"output_text","text":"fix bug"}]}]}}',
    "",
  ].join("\n");
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(sseBody, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function extractFetchCall(fetchMock: ReturnType<typeof vi.fn>): FetchCall {
  const [endpoint, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
  const requestBody =
    typeof requestInit.body === "string" ? (JSON.parse(requestInit.body) as unknown) : {};
  return {
    endpoint,
    headers: new Headers(requestInit.headers),
    body:
      requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)
        ? (requestBody as Record<string, unknown>)
        : {},
  };
}

describe("generateOpenAIResponsesText auth handling", () => {
  let tempHomePath = "";

  beforeEach(async () => {
    tempHomePath = await mkdtemp(join(tmpdir(), "bb-openai-responses-"));
    process.env.HOME = tempHomePath;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.BB_INFERENCE_MODEL;
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;

    if (ORIGINAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;

    if (ORIGINAL_OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = ORIGINAL_OPENAI_BASE_URL;

    if (ORIGINAL_BB_INFERENCE_MODEL === undefined) delete process.env.BB_INFERENCE_MODEL;
    else process.env.BB_INFERENCE_MODEL = ORIGINAL_BB_INFERENCE_MODEL;

    if (tempHomePath) {
      await rm(tempHomePath, { recursive: true, force: true });
      tempHomePath = "";
    }
  });

  it("uses api.openai.com when API key auth is configured", async () => {
    await writeAuthJson(tempHomePath, {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: "chatgpt-token",
        account_id: "org_abc123",
      },
    });
    process.env.OPENAI_API_KEY = "sk-test-123";
    const fetchMock = mockResponsesSuccessFetch();

    await generateOpenAIResponsesText({
      prompt: "Suggest a commit message.",
      maxOutputTokens: 120,
      temperature: 0,
    });

    const call = extractFetchCall(fetchMock);
    expect(call.endpoint).toBe("https://api.openai.com/v1/responses");
    expect(call.headers.get("authorization")).toBe("Bearer sk-test-123");
    expect(call.headers.get("chatgpt-account-id")).toBeNull();
    expect(call.body.instructions).toBeTypeOf("string");
    expect(call.body.max_output_tokens).toBe(120);
    expect(call.body.temperature).toBe(0);
    expect(call.body.stream).toBeUndefined();
  });

  it("uses ChatGPT endpoint and account header in chatgpt auth mode", async () => {
    await writeAuthJson(tempHomePath, {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: "chatgpt-token",
        account_id: "org_abc123",
      },
    });
    const fetchMock = mockSseResponsesSuccessFetch();

    const result = await generateOpenAIResponsesText({
      prompt: "Suggest a commit message.",
      maxOutputTokens: 120,
      temperature: 0,
    });

    const call = extractFetchCall(fetchMock);
    expect(call.endpoint).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(call.headers.get("authorization")).toBe("Bearer chatgpt-token");
    expect(call.headers.get("chatgpt-account-id")).toBe("org_abc123");
    expect(call.body.instructions).toBeTypeOf("string");
    expect(call.body.stream).toBe(true);
    expect(call.body.max_output_tokens).toBeUndefined();
    expect(call.body.temperature).toBeUndefined();
    expect(result.text).toBe("fix bug");
    expect(result.responseId).toBe("resp_stream");
  });

  it("throws a clear error when no auth is available", async () => {
    await expect(
      generateOpenAIResponsesText({ prompt: "Suggest a commit message." }),
    ).rejects.toThrow("OpenAI auth is missing");
  });

  it("extracts text from structured JSON response output", async () => {
    process.env.OPENAI_API_KEY = "sk-test-123";
    mockResponsesNestedOutputFetch();

    await expect(
      generateOpenAIResponsesText({ prompt: "Suggest a commit message." }),
    ).resolves.toMatchObject({
      text: "fixbug",
      responseId: "resp_nested",
    });
  });
});
