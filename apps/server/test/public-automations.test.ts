import { createAutomation } from "@bb/db";
import {
  automationSchema,
  AUTOMATION_NAME_MAX_LENGTH,
  SCHEDULE_CRON_MAX_LENGTH,
  SCHEDULE_TIMEZONE_MAX_LENGTH,
} from "@bb/server-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("public automation routes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T12:00:00.000Z"));
  });

  it("supports automation CRUD", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-automation-crud" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const createResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Daily summary",
            trigger: {
              triggerType: "schedule",
              cron: "0 8 * * 1-5",
              timezone: "America/Los_Angeles",
            },
            action: {
              actionType: "scheduled-thread",
              threadRequest: {
                providerId: "codex",
                model: "gpt-5",
                input: [{ type: "text", text: "Summarize yesterday's work" }],
                environment: {
                  type: "host",
                  hostId: host.id,
                  workspace: { type: "managed-clone" },
                },
              },
            },
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const createdAutomation = automationSchema.parse(await readJson(createResponse));
      expect(createdAutomation.enabled).toBe(true);
      expect(createdAutomation.autoArchive).toBe(false);
      expect(createdAutomation.trigger.cron).toBe("0 8 * * 1-5");
      expect(createdAutomation.nextRunAt).toBeTypeOf("number");

      const listResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations`,
      );
      expect(listResponse.status).toBe(200);
      expect(automationSchema.array().parse(await readJson(listResponse))).toEqual([
        expect.objectContaining({
          id: createdAutomation.id,
          name: "Daily summary",
        }),
      ]);

      const disableResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations/${createdAutomation.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            enabled: false,
          }),
        },
      );
      expect(disableResponse.status).toBe(200);
      expect(automationSchema.parse(await readJson(disableResponse))).toMatchObject({
        id: createdAutomation.id,
        enabled: false,
        nextRunAt: null,
      });

      const enableResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations/${createdAutomation.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            enabled: true,
            autoArchive: true,
          }),
        },
      );
      expect(enableResponse.status).toBe(200);
      expect(automationSchema.parse(await readJson(enableResponse))).toMatchObject({
        id: createdAutomation.id,
        enabled: true,
        autoArchive: true,
      });

      const deleteResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations/${createdAutomation.id}`,
        {
          method: "DELETE",
        },
      );
      expect(deleteResponse.status).toBe(200);
      await expect(readJson(deleteResponse)).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });

  it("rejects invalid cron expressions, invalid timezones, and sub-5-minute schedules", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-automation-validation" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      for (const trigger of [
        {
          triggerType: "schedule",
          cron: "not-a-cron",
          timezone: "UTC",
        },
        {
          triggerType: "schedule",
          cron: "0 8 * * 1-5",
          timezone: "Mars/Olympus",
        },
        {
          triggerType: "schedule",
          cron: "* * * * *",
          timezone: "UTC",
        },
      ] as const) {
        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/automations`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              name: "Invalid schedule",
              trigger,
              action: {
                actionType: "scheduled-thread",
                threadRequest: {
                  providerId: "codex",
                  model: "gpt-5",
                  input: [{ type: "text", text: "Run invalid schedule" }],
                  environment: {
                    type: "host",
                    hostId: host.id,
                    workspace: { type: "managed-clone" },
                  },
                },
              },
            }),
          },
        );
        expect(response.status).toBe(400);
      }
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });

  it("rejects overlong automation schedule fields at the API boundary", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-automation-max-length" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      for (const payload of [
        {
          name: "n".repeat(AUTOMATION_NAME_MAX_LENGTH + 1),
          trigger: {
            triggerType: "schedule",
            cron: "0 8 * * 1-5",
            timezone: "UTC",
          },
        },
        {
          name: "Valid name",
          trigger: {
            triggerType: "schedule",
            cron: "0".repeat(SCHEDULE_CRON_MAX_LENGTH + 1),
            timezone: "UTC",
          },
        },
        {
          name: "Valid name",
          trigger: {
            triggerType: "schedule",
            cron: "0 8 * * 1-5",
            timezone: "T".repeat(SCHEDULE_TIMEZONE_MAX_LENGTH + 1),
          },
        },
      ] as const) {
        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/automations`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              ...payload,
              action: {
                actionType: "scheduled-thread",
                threadRequest: {
                  providerId: "codex",
                  model: "gpt-5",
                  input: [{ type: "text", text: "Reject this invalid payload" }],
                  environment: {
                    type: "host",
                    hostId: host.id,
                    workspace: { type: "managed-clone" },
                  },
                },
              },
            }),
          },
        );
        expect(response.status).toBe(400);
      }
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });

  it("rejects automation actions that reference foreign project environments or hosts", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host: primaryHost } = seedHostSession(harness.deps, {
        id: "host-automation-project-scope-primary",
      });
      const { host: foreignHost } = seedHostSession(harness.deps, {
        id: "host-automation-project-scope-foreign",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: primaryHost.id,
      });
      const { project: foreignProject } = seedProjectWithSource(harness.deps, {
        hostId: foreignHost.id,
      });
      const foreignEnvironment = seedEnvironment(harness.deps, {
        hostId: foreignHost.id,
        projectId: foreignProject.id,
        path: "/tmp/automation-foreign-environment",
      });

      const reuseResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Foreign reuse environment",
            trigger: {
              triggerType: "schedule",
              cron: "0 8 * * 1-5",
              timezone: "UTC",
            },
            action: {
              actionType: "scheduled-thread",
              threadRequest: {
                providerId: "codex",
                model: "gpt-5",
                input: [{ type: "text", text: "Should be rejected" }],
                environment: {
                  type: "reuse",
                  environmentId: foreignEnvironment.id,
                },
              },
            },
          }),
        },
      );
      expect(reuseResponse.status).toBe(409);

      const hostResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Foreign host",
            trigger: {
              triggerType: "schedule",
              cron: "0 8 * * 1-5",
              timezone: "UTC",
            },
            action: {
              actionType: "scheduled-thread",
              threadRequest: {
                providerId: "codex",
                model: "gpt-5",
                input: [{ type: "text", text: "Should also be rejected" }],
                environment: {
                  type: "host",
                  hostId: foreignHost.id,
                  workspace: { type: "managed-clone" },
                },
              },
            },
          }),
        },
      );
      expect(hostResponse.status).toBe(409);

      const createResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Scoped automation",
            trigger: {
              triggerType: "schedule",
              cron: "0 8 * * 1-5",
              timezone: "UTC",
            },
            action: {
              actionType: "scheduled-thread",
              threadRequest: {
                providerId: "codex",
                model: "gpt-5",
                input: [{ type: "text", text: "Create a valid automation first" }],
                environment: {
                  type: "host",
                  hostId: primaryHost.id,
                  workspace: { type: "managed-clone" },
                },
              },
            },
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const createdAutomation = automationSchema.parse(await readJson(createResponse));

      const updateResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations/${createdAutomation.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: {
              actionType: "scheduled-thread",
              threadRequest: {
                providerId: "codex",
                model: "gpt-5",
                input: [{ type: "text", text: "Cross project update should fail" }],
                environment: {
                  type: "reuse",
                  environmentId: foreignEnvironment.id,
                },
              },
            },
          }),
        },
      );
      expect(updateResponse.status).toBe(409);
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });

  it("skips malformed stored automations while listing valid ones", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-automation-list-malformed",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const validAutomation = createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "Valid automation",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: JSON.stringify({
          triggerType: "schedule",
          cron: "0 8 * * 1-5",
          timezone: "UTC",
        }),
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Run the valid automation" }],
            environment: {
              type: "host",
              hostId: host.id,
              workspace: { type: "managed-clone" },
            },
          },
        }),
        autoArchive: false,
        nextRunAt: Date.now() + 60_000,
      });
      createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "Malformed automation",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: "{",
        action: "{",
        autoArchive: false,
        nextRunAt: Date.now() + 120_000,
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/automations`,
      );

      expect(response.status).toBe(200);
      expect(automationSchema.array().parse(await readJson(response))).toEqual([
        expect.objectContaining({
          id: validAutomation.id,
          name: "Valid automation",
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });
});
