import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { configuredAcpProvider } from "../helpers/provider-registry.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("provider logos", () => {
  it("serves the icon a plugin registered", async () => {
    await withTestHarness({}, async (harness) => {
      const response = await harness.app.request(
        "/api/v1/system/providers/acp-cursor/logo",
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await response.text()).length).toBeGreaterThan(0);
    });
  });

  it("returns 404 for a provider that registered no icon bytes", async () => {
    await withTestHarness(
      {
        extraProviders: [
          await configuredAcpProvider({
            id: "example-agent",
            displayName: "Example Agent",
            command: "example-agent",
            args: ["acp"],
          }),
        ],
      },
      async (harness) => {
        const response = await harness.app.request(
          "/api/v1/system/providers/acp-example-agent/logo",
        );
        expect(response.status).toBe(404);
        expect(await readJson(response)).toMatchObject({
          code: "provider_logo_not_found",
        });
      },
    );
  });

  it("returns 404 for an unknown provider id", async () => {
    await withTestHarness({}, async (harness) => {
      const response = await harness.app.request(
        "/api/v1/system/providers/acp-not-a-provider/logo",
      );
      expect(response.status).toBe(404);
    });
  });
});
