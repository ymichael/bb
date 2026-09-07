import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestOriginHttp } from "../src/session.js";

interface SeenRequest {
  body: string;
  contentLength: string | undefined;
  method: string;
}

let server: Server;
let origin: string;
const seen: SeenRequest[] = [];

async function readBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString();
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        body: Buffer.concat(chunks).toString(),
        contentLength: request.headers["content-length"],
        method: request.method ?? "",
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server has no port");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("requestOriginHttp", () => {
  it.each(["DELETE", "GET", "PATCH", "POST", "PUT"])(
    "delivers a %s body to the origin",
    async (method) => {
      const body = Buffer.from(
        JSON.stringify({ childThreadsConfirmed: false }),
      );
      const response = await requestOriginHttp({
        body,
        headers: { "Content-Type": "application/json" },
        method,
        signal: new AbortController().signal,
        url: new URL(`${origin}/api/v1/threads/t1`),
      });
      expect(response.statusCode).toBe(200);
      expect(await readBody(response)).toBe('{"ok":true}');
      const last = seen.at(-1);
      expect(last?.method).toBe(method);
      expect(last?.body).toBe(body.toString());
      expect(last?.contentLength).toBe(String(body.byteLength));
    },
  );

  it("sends no Content-Length when there is no body", async () => {
    const response = await requestOriginHttp({
      body: undefined,
      headers: {},
      method: "DELETE",
      signal: new AbortController().signal,
      url: new URL(`${origin}/api/v1/threads/t1`),
    });
    expect(response.statusCode).toBe(200);
    await readBody(response);
    expect(seen.at(-1)?.contentLength).toBeUndefined();
  });
});
