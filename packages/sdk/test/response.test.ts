import { afterEach, describe, it, expect, vi } from "vitest";
import {
  BbHttpError,
  createRequestTimeoutFetch,
  DEFAULT_BB_REQUEST_TIMEOUT_MS,
  readJsonResponse,
  readVoidResponse,
} from "../src/response.js";
import { createNodeTransport } from "../src/node.js";

const REQUEST_TIMEOUT_ERROR_NAME = "BbRequestTimeoutError";
const REQUEST_TIMEOUT_VALIDATION_MESSAGE =
  "BB request timeout must be a non-negative finite number.";

function requestTimeoutMessage(duration: string): string {
  return `BB request timed out after ${duration}.`;
}

const IMMEDIATE_TIMEOUT_MS = 0;
const IMMEDIATE_TIMEOUT_MESSAGE = requestTimeoutMessage("0 seconds");
const SHORT_TIMEOUT_MS = 20;
const SHORT_TIMEOUT_MESSAGE = requestTimeoutMessage("20 ms");

afterEach(() => {
  vi.restoreAllMocks();
});

function mockPendingFetchUntilAbort(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(init.signal.reason);
        return;
      }
      init?.signal?.addEventListener(
        "abort",
        () => {
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  });
}

interface PendingFetchTimeoutExpectation {
  expectedMessage: string;
  timeoutMs: number;
}

async function expectPendingFetchTimeout(
  args: PendingFetchTimeoutExpectation,
): Promise<void> {
  mockPendingFetchUntilAbort();

  const timeoutFetch = createRequestTimeoutFetch({
    timeoutMs: args.timeoutMs,
  });
  const responsePromise = timeoutFetch(
    "http://server/api/v1/threads/thread-1/output",
  );
  const expectation = expect(responsePromise).rejects.toMatchObject({
    message: args.expectedMessage,
    name: REQUEST_TIMEOUT_ERROR_NAME,
  });

  await expectation;
}

interface StalledResponseArgs {
  responseInit?: ResponseInit;
  signal: AbortSignal | null | undefined;
}

function createStalledResponse(args: StalledResponseArgs): Response {
  const body = new ReadableStream({
    start(controller) {
      if (args.signal?.aborted) {
        controller.error(args.signal.reason);
        return;
      }
      args.signal?.addEventListener(
        "abort",
        () => {
          controller.error(
            args.signal?.reason ??
              new DOMException("The operation was aborted.", "AbortError"),
          );
        },
        { once: true },
      );
    },
  });
  return new Response(body, args.responseInit);
}

function createErroredResponse(error: Error): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.error(error);
    },
  });
  return new Response(body);
}

interface CancelableResponseArgs {
  onCancel: (reason: Error) => void;
}

function createCancelableResponse(args: CancelableResponseArgs): Response {
  const body = new ReadableStream<Uint8Array>({
    cancel(reason) {
      args.onCancel(reason);
    },
  });
  return new Response(body);
}

function getBytesReader(response: Response): () => Promise<Uint8Array> {
  const read = Reflect.get(response, "bytes");
  if (typeof read !== "function") {
    throw new Error("Expected Response.bytes to be available");
  }
  return () => read();
}

function createAbortedTimeoutSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort(
    new DOMException("The operation timed out.", "TimeoutError"),
  );
  return controller.signal;
}

interface ImmediateTimeoutSignalArgs {
  timeoutMs: number;
}

function useImmediateTimeoutSignalFor(args: ImmediateTimeoutSignalArgs): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
    if (timeoutMs === args.timeoutMs) {
      return createAbortedTimeoutSignal();
    }
    return new AbortController().signal;
  });
}

function readJson<TBody>(response: Response): Promise<TBody> {
  return readJsonResponse(Promise.resolve(response));
}

describe("readJsonResponse()", () => {
  it("parses successful JSON response", async () => {
    const data = { id: "thread-1", title: "Hello" };
    const response = new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const result = await readJson<typeof data>(response);

    expect(result).toEqual(data);
    expect(result.id).toBe("thread-1");
    expect(result.title).toBe("Hello");
  });

  it("throws on empty response body", async () => {
    const response = new Response("", { status: 200 });

    await expect(readJson<{ id: string }>(response)).rejects.toThrow();
  });

  it("readVoidResponse succeeds for empty response body", async () => {
    const response = new Response("", { status: 200 });

    await expect(
      readVoidResponse(Promise.resolve(response)),
    ).resolves.toBeUndefined();
  });

  it("readVoidResponse succeeds for null body (204 No Content)", async () => {
    const response = new Response(null, { status: 204 });

    await expect(
      readVoidResponse(Promise.resolve(response)),
    ).resolves.toBeUndefined();
  });

  it("readVoidResponse throws for non-ok response", async () => {
    const response = new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    });

    await expect(readVoidResponse(Promise.resolve(response))).rejects.toThrow(
      "HTTP 500: Internal Server Error",
    );
  });

  it("throws BbHttpError carrying status and server code for non-ok response", async () => {
    const response = new Response(
      JSON.stringify({
        code: "thread_not_found",
        message: "Thread thread-1 not found",
        error: "Thread thread-1 not found",
      }),
      {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json" },
      },
    );

    const error = await readJson(response).then(
      () => {
        throw new Error("Expected readJsonResponse to reject");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BbHttpError);
    if (!(error instanceof BbHttpError)) {
      throw new Error("Expected a BbHttpError");
    }
    expect(error.message).toBe("HTTP 404: Thread thread-1 not found");
    expect(error.status).toBe(404);
    expect(error.code).toBe("thread_not_found");
  });

  it("reports a null code when the error body has none", async () => {
    const response = new Response("plain failure", {
      status: 502,
      statusText: "Bad Gateway",
    });

    await expect(readJson(response)).rejects.toMatchObject({
      code: null,
      message: "HTTP 502: plain failure",
      name: "BbHttpError",
      status: 502,
    });
  });

  it("falls back to legacy detail field when canonical message is absent", async () => {
    const response = new Response('{"detail":"Thread not found"}', {
      status: 404,
      statusText: "Not Found",
      headers: { "Content-Type": "application/json" },
    });

    await expect(readJson(response)).rejects.toThrow(
      "HTTP 404: Thread not found",
    );
  });

  it("carries the parsed JSON error body for structured consumers", async () => {
    const response = new Response(
      JSON.stringify({
        code: "environment_not_ready",
        message: "Environment is not ready",
        details: { reason: "provisioning" },
      }),
      {
        status: 409,
        statusText: "Conflict",
        headers: { "Content-Type": "application/json" },
      },
    );

    await expect(readJson(response)).rejects.toMatchObject({
      body: {
        code: "environment_not_ready",
        message: "Environment is not ready",
        details: { reason: "provisioning" },
      },
      code: "environment_not_ready",
      name: "BbHttpError",
    });
  });

  it("falls back to statusText for HTML error bodies", async () => {
    const response = new Response(
      "<!doctype html><html><body>Sign in required</body></html>",
      {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "text/html" },
      },
    );

    await expect(readJson(response)).rejects.toMatchObject({
      body: null,
      message: "HTTP 502: Bad Gateway",
      name: "BbHttpError",
      status: 502,
    });
  });

  it("throws HTTP error with statusText when body is empty", async () => {
    const response = new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    });

    await expect(readJson(response)).rejects.toThrow(
      "HTTP 500: Internal Server Error",
    );
  });

  it("throws connection error with helpful message for ECONNREFUSED", async () => {
    const connError = new TypeError("fetch failed", {
      cause: { code: "ECONNREFUSED" },
    });

    await expect(readJsonResponse(Promise.reject(connError))).rejects.toThrow(
      "Cannot connect to BB server. Ensure it is running and BB_SERVER_URL is correct.",
    );
  });

  it("rethrows other errors as-is", async () => {
    const otherError = new Error("Network timeout");

    await expect(readJsonResponse(Promise.reject(otherError))).rejects.toThrow(
      "Network timeout",
    );
  });

  it("rethrows non-TypeError connection errors", async () => {
    const error = new RangeError("something wrong");

    await expect(readJsonResponse(Promise.reject(error))).rejects.toThrow(
      "something wrong",
    );
    await expect(
      readJsonResponse(Promise.reject(error)),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("createRequestTimeoutFetch()", () => {
  it("times out hung API requests", async () => {
    await expectPendingFetchTimeout({
      timeoutMs: SHORT_TIMEOUT_MS,
      expectedMessage: SHORT_TIMEOUT_MESSAGE,
    });
  });

  it("uses the default timeout when creating the node transport", async () => {
    useImmediateTimeoutSignalFor({
      timeoutMs: DEFAULT_BB_REQUEST_TIMEOUT_MS,
    });
    mockPendingFetchUntilAbort();
    const transport = createNodeTransport({ baseUrl: "http://server" });

    await expect(transport.api.v1.hosts.$get()).rejects.toThrow(
      requestTimeoutMessage("75 seconds"),
    );
  });

  it("times out immediately when configured with zero milliseconds", async () => {
    await expectPendingFetchTimeout({
      timeoutMs: IMMEDIATE_TIMEOUT_MS,
      expectedMessage: IMMEDIATE_TIMEOUT_MESSAGE,
    });
  });

  it("rejects negative timeout values", () => {
    expect(() => createRequestTimeoutFetch({ timeoutMs: -1 })).toThrow(
      REQUEST_TIMEOUT_VALIDATION_MESSAGE,
    );
  });

  it("rejects non-finite timeout values", () => {
    for (const timeoutMs of [Infinity, -Infinity, Number.NaN]) {
      expect(() => createRequestTimeoutFetch({ timeoutMs })).toThrow(
        REQUEST_TIMEOUT_VALIDATION_MESSAGE,
      );
    }
  });

  it("formats plural timeout durations", async () => {
    useImmediateTimeoutSignalFor({ timeoutMs: 2_000 });

    await expectPendingFetchTimeout({
      timeoutMs: 2_000,
      expectedMessage: requestTimeoutMessage("2 seconds"),
    });
  });

  it("formats non-integer second timeout durations as milliseconds", async () => {
    useImmediateTimeoutSignalFor({ timeoutMs: 1_250 });

    await expectPendingFetchTimeout({
      timeoutMs: 1_250,
      expectedMessage: requestTimeoutMessage("1250 ms"),
    });
  });

  it("returns successful API responses after body read", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return Promise.resolve(new Response("ok"));
    });

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 1_000 });
    const response = await timeoutFetch("http://server/api/v1/hosts");

    await expect(response.text()).resolves.toBe("ok");
  });

  it("preserves response metadata through the wrapper", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return Promise.resolve(
        new Response("ok", {
          headers: { "x-bb-test": "wrapped" },
          status: 202,
        }),
      );
    });

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 1_000 });
    const response = await timeoutFetch("http://server/api/v1/hosts");

    expect(response.status).toBe(202);
    expect(response.ok).toBe(true);
    expect(response.headers.get("x-bb-test")).toBe("wrapped");
  });

  it("passes request init values through while adding the timeout signal", async () => {
    const requestBody = JSON.stringify({ ok: true });
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      expect(input).toBe("http://server/api/v1/hosts");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(requestBody);
      expect(new Headers(init?.headers).get("x-bb-test")).toBe("yes");
      expect(init?.signal?.aborted).toBe(false);
      return Promise.resolve(new Response("ok"));
    });

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 1_000 });
    const response = await timeoutFetch("http://server/api/v1/hosts", {
      body: requestBody,
      headers: { "x-bb-test": "yes" },
      method: "POST",
    });

    await expect(response.text()).resolves.toBe("ok");
  });

  it("returns successful responses that intentionally have no body", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 1_000 });
    const response = await timeoutFetch("http://server/api/v1/threads/wait");

    expect(response.body).toBeNull();
    await expect(
      readVoidResponse(Promise.resolve(response)),
    ).resolves.toBeUndefined();
  });

  it("times out stalled response body reads", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return Promise.resolve(createStalledResponse({ signal: init?.signal }));
    });

    const timeoutFetch = createRequestTimeoutFetch({
      timeoutMs: IMMEDIATE_TIMEOUT_MS,
    });
    const response = await timeoutFetch("http://server/api/v1/threads/output");
    await expect(response.text()).rejects.toThrow(IMMEDIATE_TIMEOUT_MESSAGE);
  });

  it("times out stalled standard body reader paths", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return Promise.resolve(
        createStalledResponse({
          signal: init?.signal,
          responseInit: {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          },
        }),
      );
    });

    const timeoutFetch = createRequestTimeoutFetch({
      timeoutMs: IMMEDIATE_TIMEOUT_MS,
    });

    const arrayBufferResponse = await timeoutFetch(
      "http://server/api/v1/array-buffer",
    );
    await expect(arrayBufferResponse.arrayBuffer()).rejects.toThrow(
      IMMEDIATE_TIMEOUT_MESSAGE,
    );

    const blobResponse = await timeoutFetch("http://server/api/v1/blob");
    await expect(blobResponse.blob()).rejects.toThrow(
      IMMEDIATE_TIMEOUT_MESSAGE,
    );

    const formDataResponse = await timeoutFetch(
      "http://server/api/v1/form-data",
    );
    await expect(formDataResponse.formData()).rejects.toThrow(
      IMMEDIATE_TIMEOUT_MESSAGE,
    );

    const bytesResponse = await timeoutFetch("http://server/api/v1/bytes");
    await expect(getBytesReader(bytesResponse)()).rejects.toThrow(
      IMMEDIATE_TIMEOUT_MESSAGE,
    );
  });

  it("times out stalled HTTP error body reads", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return Promise.resolve(
        createStalledResponse({
          signal: init?.signal,
          responseInit: {
            status: 500,
            statusText: "Internal Server Error",
          },
        }),
      );
    });

    const timeoutFetch = createRequestTimeoutFetch({
      timeoutMs: IMMEDIATE_TIMEOUT_MS,
    });
    await expect(
      readJsonResponse(timeoutFetch("http://server/api/v1/threads")),
    ).rejects.toThrow(IMMEDIATE_TIMEOUT_MESSAGE);
  });

  it("passes through non-timeout body read errors", async () => {
    const bodyError = new Error("body read failed");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return Promise.resolve(createErroredResponse(bodyError));
    });

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 1_000 });
    const response = await timeoutFetch("http://server/api/v1/hosts");

    await expect(response.text()).rejects.toBe(bodyError);
  });

  it("propagates upstream aborts while a request is pending", async () => {
    const upstreamController = new AbortController();
    const upstreamError = new Error("request stopped");
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
    });

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 1_000 });
    const responsePromise = timeoutFetch("http://server/api/v1/hosts", {
      signal: upstreamController.signal,
    });
    upstreamController.abort(upstreamError);

    await expect(responsePromise).rejects.toBe(upstreamError);
  });

  it("maps timeout errors when timeout wins over an upstream signal", async () => {
    const upstreamController = new AbortController();
    mockPendingFetchUntilAbort();

    const timeoutFetch = createRequestTimeoutFetch({
      timeoutMs: IMMEDIATE_TIMEOUT_MS,
    });

    await expect(
      timeoutFetch("http://server/api/v1/hosts", {
        signal: upstreamController.signal,
      }),
    ).rejects.toMatchObject({
      message: IMMEDIATE_TIMEOUT_MESSAGE,
      name: REQUEST_TIMEOUT_ERROR_NAME,
    });
    expect(upstreamController.signal.aborted).toBe(false);
  });

  it("maps platform abort wrapper errors after timeout wins", async () => {
    const upstreamController = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          },
          { once: true },
        );
      });
    });

    const timeoutFetch = createRequestTimeoutFetch({
      timeoutMs: IMMEDIATE_TIMEOUT_MS,
    });

    await expect(
      timeoutFetch("http://server/api/v1/hosts", {
        signal: upstreamController.signal,
      }),
    ).rejects.toMatchObject({
      message: IMMEDIATE_TIMEOUT_MESSAGE,
      name: REQUEST_TIMEOUT_ERROR_NAME,
    });
  });

  it("propagates upstream aborts while response body is pending", async () => {
    const upstreamController = new AbortController();
    const upstreamError = new Error("body stopped");
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return Promise.resolve(createStalledResponse({ signal: init?.signal }));
    });

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 60_000 });
    const response = await timeoutFetch("http://server/api/v1/hosts", {
      signal: upstreamController.signal,
    });
    const bodyPromise = response.text();
    upstreamController.abort(upstreamError);

    await expect(bodyPromise).rejects.toBe(upstreamError);
  });

  it("preserves JSON parse failures after successful body reads", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return Promise.resolve(new Response("not json"));
    });

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 1_000 });

    await expect(
      readJsonResponse(timeoutFetch("http://server/api/v1/hosts")),
    ).rejects.toThrow(SyntaxError);
  });

  it("maps direct JSON body read timeouts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return Promise.resolve(createStalledResponse({ signal: init?.signal }));
    });

    const timeoutFetch = createRequestTimeoutFetch({
      timeoutMs: IMMEDIATE_TIMEOUT_MS,
    });
    const response = await timeoutFetch("http://server/api/v1/hosts");
    await expect(response.json()).rejects.toThrow(IMMEDIATE_TIMEOUT_MESSAGE);
  });

  it("maps raw body stream read timeouts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return Promise.resolve(createStalledResponse({ signal: init?.signal }));
    });

    const timeoutFetch = createRequestTimeoutFetch({
      timeoutMs: IMMEDIATE_TIMEOUT_MS,
    });
    const response = await timeoutFetch("http://server/api/v1/hosts");
    const body = response.body;
    if (body === null) {
      throw new Error("Expected response body");
    }
    const reader = body.getReader();

    await expect(reader.read()).rejects.toThrow(IMMEDIATE_TIMEOUT_MESSAGE);
  });

  it("propagates raw body stream cancellation reasons", async () => {
    const cancelReason = new Error("stop reading");
    let observedReason: Error | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return Promise.resolve(
        createCancelableResponse({
          onCancel(reason) {
            observedReason = reason;
          },
        }),
      );
    });

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 1_000 });
    const response = await timeoutFetch("http://server/api/v1/hosts");
    const body = response.body;
    if (body === null) {
      throw new Error("Expected response body");
    }

    await body.cancel(cancelReason);

    expect(observedReason).toBe(cancelReason);
  });

  it("preserves timeout mapping for cloned responses", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return Promise.resolve(createStalledResponse({ signal: init?.signal }));
    });

    const timeoutFetch = createRequestTimeoutFetch({
      timeoutMs: IMMEDIATE_TIMEOUT_MS,
    });
    const response = await timeoutFetch("http://server/api/v1/hosts");
    const cloned = response.clone();

    await expect(cloned.text()).rejects.toThrow(IMMEDIATE_TIMEOUT_MESSAGE);
  });

  it("preserves successful body reads for cloned responses", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return Promise.resolve(new Response("ok"));
    });

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 1_000 });
    const response = await timeoutFetch("http://server/api/v1/hosts");
    const cloned = response.clone();

    await expect(cloned.text()).resolves.toBe("ok");
  });

  it("propagates already-aborted upstream signals", async () => {
    const upstreamController = new AbortController();
    const upstreamError = new Error("already stopped");
    upstreamController.abort(upstreamError);
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return Promise.reject(init?.signal?.reason);
    });

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 1_000 });

    await expect(
      timeoutFetch("http://server/api/v1/hosts", {
        signal: upstreamController.signal,
      }),
    ).rejects.toBe(upstreamError);
  });

  it("passes through non-timeout fetch errors", async () => {
    const fetchError = new Error("socket reset");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(fetchError);

    const timeoutFetch = createRequestTimeoutFetch({ timeoutMs: 1_000 });

    await expect(timeoutFetch("http://server/api/v1/hosts")).rejects.toBe(
      fetchError,
    );
  });
});
