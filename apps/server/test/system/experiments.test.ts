import { describe, expect, it } from "vitest";
import { getExperiments } from "@bb/db";
import { experimentsSchema } from "@bb/domain";
import { systemConfigResponseSchema } from "@bb/server-contract";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("experiments settings", () => {
  it("serves the shipped experiment defaults in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      const body = systemConfigResponseSchema.parse(await readJson(response));
      expect(body.experiments).toEqual({
        changelogPreview: false,
        editMessages: true,
        mobileApp: false,
        sidebarProgressiveDisclosure: false,
        timelineWindowing: false,
      });
    });
  });

  it("persists a PUT and reflects it in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const put = await harness.app.request("/api/v1/settings/experiments", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changelogPreview: true,
          editMessages: true,
          mobileApp: true,
          sidebarProgressiveDisclosure: true,
          timelineWindowing: true,
        }),
      });
      expect(put.status).toBe(200);
      expect(experimentsSchema.parse(await readJson(put))).toEqual({
        changelogPreview: true,
        editMessages: true,
        mobileApp: true,
        sidebarProgressiveDisclosure: true,
        timelineWindowing: true,
      });
      expect(getExperiments(harness.db)).toEqual({
        changelogPreview: true,
        editMessages: true,
        mobileApp: true,
        sidebarProgressiveDisclosure: true,
        timelineWindowing: true,
      });

      const config = await harness.app.request("/api/v1/system/config");
      expect(
        systemConfigResponseSchema.parse(await readJson(config)).experiments,
      ).toEqual({
        changelogPreview: true,
        editMessages: true,
        mobileApp: true,
        sidebarProgressiveDisclosure: true,
        timelineWindowing: true,
      });
    });
  });

  it("does not expose legacy direct bb connect routes", async () => {
    await withTestHarness(async (harness) => {
      const disabled = await harness.app.request("/api/v1/connect/status");
      expect(disabled.status).toBe(404);

      const put = await harness.app.request("/api/v1/settings/experiments", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changelogPreview: false,
          editMessages: false,
          mobileApp: false,
          sidebarProgressiveDisclosure: false,
          timelineWindowing: false,
        }),
      });
      expect(put.status).toBe(200);

      const enabled = await harness.app.request("/api/v1/connect/status");
      expect(enabled.status).toBe(404);
    });
  });

  it("rejects payloads that are not the full experiments object", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/settings/experiments",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(response.status).toBe(400);
    });
  });
});
