import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import type { Endpoint } from "../src/endpoint.js";
import { typedRoutes } from "../src/typed-routes.js";

type TestSchema = {
  "/search": {
    $get: Endpoint<{ query: { q: string } }, { q: string }>;
  };
  "/ping": {
    $get: Endpoint<{}, { ok: true }>;
  };
};

function createApp() {
  const app = new Hono();
  app.onError((error, context) => {
    return context.json({ message: error.message }, 400);
  });
  return app;
}

describe("typedRoutes", () => {
  it("parses GET query inputs instead of requiring a JSON body", async () => {
    const app = createApp();
    const { get } = typedRoutes<TestSchema>(app, {
      onValidationError: (message) => new Error(message),
    });

    get("/search", z.object({ q: z.string().min(1) }), (context, query) =>
      context.json({ q: query.q }),
    );

    const success = await app.request("/search?q=needle");
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ q: "needle" });

    const missingQuery = await app.request("/search", { method: "GET" });
    expect(missingQuery.status).toBe(400);
    expect(await missingQuery.json()).toEqual({ message: "Required" });
  });

  it("supports GET handlers with no query schema", async () => {
    const app = createApp();
    const { get } = typedRoutes<TestSchema>(app, {
      onValidationError: (message) => new Error(message),
    });

    get("/ping", (context) => context.json({ ok: true }));

    const response = await app.request("/ping");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
