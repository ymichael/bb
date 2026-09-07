import { describe, expect, it } from "vitest";
import { getAppSettings } from "@bb/db";
import { appSettingsSchema, defaultAppSettings } from "@bb/domain";
import { systemConfigResponseSchema } from "@bb/server-contract";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("general settings", () => {
  it("defaults general settings in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      const body = systemConfigResponseSchema.parse(await readJson(response));
      expect(body.generalSettings).toEqual(defaultAppSettings);
      expect(body.primaryHostId).toBeNull();
    });
  });

  it("persists a PUT and reflects it in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const put = await harness.app.request("/api/v1/settings/general", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...defaultAppSettings,
          showKeyboardHints: false,
          steerActiveThreadOnEnter: true,
          providerOrder: ["pi", "codex"],
          defaultProviderId: "pi",
        }),
      });
      expect(put.status).toBe(200);
      expect(appSettingsSchema.parse(await readJson(put))).toEqual({
        ...defaultAppSettings,
        showKeyboardHints: false,
        steerActiveThreadOnEnter: true,
        providerOrder: ["pi", "codex"],
        defaultProviderId: "pi",
      });
      expect(getAppSettings(harness.db)).toEqual({
        ...defaultAppSettings,
        showKeyboardHints: false,
        steerActiveThreadOnEnter: true,
        providerOrder: ["pi", "codex"],
        defaultProviderId: "pi",
      });

      const config = await harness.app.request("/api/v1/system/config");
      const parsedConfig = systemConfigResponseSchema.parse(
        await readJson(config),
      );
      expect(parsedConfig.generalSettings).toEqual({
        ...defaultAppSettings,
        showKeyboardHints: false,
        steerActiveThreadOnEnter: true,
        providerOrder: ["pi", "codex"],
        defaultProviderId: "pi",
      });
    });
  });

  it("rejects payloads that are not the full general settings object", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/settings/general", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });
  });

  it("rejects unknown general settings fields", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/settings/general", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...defaultAppSettings,
          unused: true,
        }),
      });
      expect(response.status).toBe(400);
    });
  });
});
