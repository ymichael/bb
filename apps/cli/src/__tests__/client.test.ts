import { describe, it, expect } from "vitest";
import { unwrap } from "../client.js";

describe("unwrap()", () => {
  it("parses successful JSON response", async () => {
    const data = { id: "thread-1", title: "Hello" };
    const response = new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const result = await unwrap<typeof data>(Promise.resolve(response));

    expect(result).toEqual(data);
    expect(result.id).toBe("thread-1");
    expect(result.title).toBe("Hello");
  });

  it("returns undefined for empty response body", async () => {
    const response = new Response("", { status: 200 });

    const result = await unwrap<{ id: string } | undefined>(
      Promise.resolve(response),
    );

    expect(result).toBeUndefined();
  });

  it("returns undefined for null body (204 No Content)", async () => {
    const response = new Response(null, { status: 204 });

    const result = await unwrap<void>(Promise.resolve(response));

    expect(result).toBeUndefined();
  });

  it("throws HTTP error with status and body for non-ok response", async () => {
    const response = new Response('{"error":"Thread not found"}', {
      status: 404,
      statusText: "Not Found",
    });

    await expect(unwrap(Promise.resolve(response))).rejects.toThrow(
      'HTTP 404: {"error":"Thread not found"}',
    );
  });

  it("throws HTTP error with statusText when body is empty", async () => {
    const response = new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    });

    await expect(unwrap(Promise.resolve(response))).rejects.toThrow(
      "HTTP 500: Internal Server Error",
    );
  });

  it("throws connection error with helpful message for ECONNREFUSED", async () => {
    const connError = new TypeError("fetch failed", {
      cause: { code: "ECONNREFUSED" },
    });

    await expect(unwrap(Promise.reject(connError))).rejects.toThrow(
      "Cannot connect to Beanbag daemon. Ensure it is running and BB_DAEMON_URL is correct.",
    );
  });

  it("rethrows other errors as-is", async () => {
    const otherError = new Error("Network timeout");

    await expect(unwrap(Promise.reject(otherError))).rejects.toThrow(
      "Network timeout",
    );
  });

  it("rethrows non-TypeError connection errors", async () => {
    const error = new RangeError("something wrong");

    await expect(unwrap(Promise.reject(error))).rejects.toThrow(
      "something wrong",
    );
    await expect(unwrap(Promise.reject(error))).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
