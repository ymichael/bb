import { createAutomation, createProjectSource } from "@bb/db";
import {
  automationSchema,
  AUTOMATION_NAME_MAX_LENGTH,
  SCHEDULE_CRON_MAX_LENGTH,
  SCHEDULE_TIMEZONE_MAX_LENGTH,
} from "@bb/server-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDailySchedule,
  createScheduleTrigger,
  createWeeklySchedule,
} from "./helpers/schedules.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

const weekdayMorningTrigger = createScheduleTrigger(createWeeklySchedule({
  times: ["08:00"],
  weekdays: ["mon", "tue", "wed", "thu", "fri"],
}));
const losAngelesWeekdayMorningTrigger = createScheduleTrigger(createWeeklySchedule({
  times: ["08:00"],
  timezone: "America/Los_Angeles",
  weekdays: ["mon", "tue", "wed", "thu", "fri"],
}));
const invalidTimezoneTrigger = createScheduleTrigger(createDailySchedule({
  times: ["08:00"],
  timezone: "Mars/Olympus",
}));
const tooFrequentTrigger = createScheduleTrigger(createDailySchedule({
  times: ["08:00", "08:03"],
}));
const invalidTimeTrigger = {
  cron: "0 8-9 * * *",
  timezone: "UTC",
  triggerType: "schedule",
};

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
            trigger: losAngelesWeekdayMorningTrigger,
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
      expect(createdAutomation.isValid).toBe(true);
      expect(createdAutomation.validationIssues).toEqual([]);
      expect(createdAutomation.autoArchive).toBe(false);
      expect(createdAutomation.trigger).toEqual(losAngelesWeekdayMorningTrigger);
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
          }),
        },
      );
      expect(enableResponse.status).toBe(200);
      expect(automationSchema.parse(await readJson(enableResponse))).toMatchObject({
        id: createdAutomation.id,
        enabled: true,
      });

      const updateResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations/${createdAutomation.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            autoArchive: true,
          }),
        },
      );
      expect(updateResponse.status).toBe(200);
      expect(automationSchema.parse(await readJson(updateResponse))).toMatchObject({
        id: createdAutomation.id,
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

  it("rejects invalid schedule shapes, invalid timezones, and sub-5-minute schedules", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-automation-validation" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      for (const trigger of [
        invalidTimeTrigger,
        invalidTimezoneTrigger,
        tooFrequentTrigger,
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

  it("rejects mixed enable toggles and config edits in one PATCH request", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-automation-mixed-patch" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const automation = createAutomation(harness.db, harness.hub, {
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Run mixed patch" }],
            environment: {
              type: "host",
              hostId: host.id,
              workspace: { type: "managed-clone" },
            },
          },
        }),
        autoArchive: false,
        enabled: false,
        name: "Mixed patch automation",
        nextRunAt: null,
        projectId: project.id,
        triggerConfig: JSON.stringify(weekdayMorningTrigger),
        triggerType: "schedule",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/automations/${automation.id}`,
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

      expect(response.status).toBe(400);
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
          trigger: weekdayMorningTrigger,
        },
        {
          name: "Valid name",
          trigger: createScheduleTrigger({
            cron: "0 ".repeat(SCHEDULE_CRON_MAX_LENGTH + 1).trim(),
            timezone: "UTC",
          }),
        },
        {
          name: "Valid name",
          trigger: createScheduleTrigger(createDailySchedule({
            times: ["08:00"],
            timezone: "T".repeat(SCHEDULE_TIMEZONE_MAX_LENGTH + 1),
          })),
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

  it("validates disabled automation schedules on create and config update", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-automation-disabled-validation",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const invalidCreateResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: {
              actionType: "scheduled-thread",
              threadRequest: {
                providerId: "codex",
                model: "gpt-5",
                input: [{ type: "text", text: "Disabled invalid automation" }],
                environment: {
                  type: "host",
                  hostId: host.id,
                  workspace: { type: "managed-clone" },
                },
              },
            },
            enabled: false,
            name: "Disabled invalid automation",
            trigger: tooFrequentTrigger,
          }),
        },
      );

      expect(invalidCreateResponse.status).toBe(400);

      const automation = createAutomation(harness.db, harness.hub, {
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Stay disabled" }],
            environment: {
              type: "host",
              hostId: host.id,
              workspace: { type: "managed-clone" },
            },
          },
        }),
        autoArchive: false,
        enabled: false,
        name: "Disabled automation",
        nextRunAt: null,
        projectId: project.id,
        triggerConfig: JSON.stringify(weekdayMorningTrigger),
        triggerType: "schedule",
      });

      const invalidUpdateResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations/${automation.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            trigger: tooFrequentTrigger,
          }),
        },
      );

      expect(invalidUpdateResponse.status).toBe(400);
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
            trigger: weekdayMorningTrigger,
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
            trigger: weekdayMorningTrigger,
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
            trigger: weekdayMorningTrigger,
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

  it("rejects sandbox-host automations when the project has no cloneable source", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-automation-sandbox-missing-clone-source",
      });
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
            name: "Sandbox automation",
            trigger: weekdayMorningTrigger,
            action: {
              actionType: "scheduled-thread",
              threadRequest: {
                providerId: "codex",
                model: "gpt-5",
                input: [{ type: "text", text: "Try to use a sandbox host" }],
                environment: {
                  type: "sandbox-host",
                  sandboxType: "e2b",
                },
              },
            },
          }),
        },
      );
      expect(createResponse.status).toBe(409);
      await expect(readJson(createResponse)).resolves.toMatchObject({
        code: "unsupported_operation",
        message:
          "Sandbox threads require a cloneable project source; local path sources are not supported yet",
      });

      const validAutomation = createAutomation(harness.db, harness.hub, {
        projectId: project.id,
        name: "Valid automation",
        enabled: true,
        triggerType: "schedule",
        triggerConfig: JSON.stringify(weekdayMorningTrigger),
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Run on the configured host" }],
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

      const updateResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations/${validAutomation.id}`,
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
                input: [{ type: "text", text: "Update to a sandbox host" }],
                environment: {
                  type: "sandbox-host",
                  sandboxType: "e2b",
                },
              },
            },
          }),
        },
      );
      expect(updateResponse.status).toBe(409);
      await expect(readJson(updateResponse)).resolves.toMatchObject({
        code: "unsupported_operation",
        message:
          "Sandbox threads require a cloneable project source; local path sources are not supported yet",
      });
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });

  it("allows sandbox-host automations when a non-default cloneable source exists", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-automation-sandbox-secondary-clone-source",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      createProjectSource(harness.db, harness.hub, {
        isDefault: false,
        projectId: project.id,
        repoUrl: "https://github.com/example/automation-secondary.git",
        type: "github_repo",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/automations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Sandbox automation",
            trigger: weekdayMorningTrigger,
            action: {
              actionType: "scheduled-thread",
              threadRequest: {
                providerId: "codex",
                model: "gpt-5",
                input: [{ type: "text", text: "Use the cloneable secondary source" }],
                environment: {
                  type: "sandbox-host",
                  sandboxType: "e2b",
                },
              },
            },
          }),
        },
      );

      expect(response.status).toBe(201);
      expect(automationSchema.parse(await readJson(response))).toMatchObject({
        action: {
          actionType: "scheduled-thread",
          threadRequest: {
            environment: {
              type: "sandbox-host",
            },
          },
        },
      });
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });

  it("allows unmanaged host automations with an explicit path on a host without a project source", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host: defaultHost } = seedHostSession(harness.deps, {
        id: "host-automation-unmanaged-default",
      });
      const { host: explicitPathHost } = seedHostSession(harness.deps, {
        id: "host-automation-unmanaged-explicit",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: defaultHost.id,
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/automations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Explicit unmanaged host automation",
            trigger: weekdayMorningTrigger,
            action: {
              actionType: "scheduled-thread",
              threadRequest: {
                providerId: "codex",
                model: "gpt-5",
                input: [{ type: "text", text: "Use the explicit unmanaged path" }],
                environment: {
                  type: "host",
                  hostId: explicitPathHost.id,
                  workspace: {
                    type: "unmanaged",
                    path: "/tmp/explicit-automation-workspace",
                  },
                },
              },
            },
          }),
        },
      );

      expect(response.status).toBe(201);
      expect(automationSchema.parse(await readJson(response))).toMatchObject({
        action: {
          actionType: "scheduled-thread",
          threadRequest: {
            environment: {
              hostId: explicitPathHost.id,
              type: "host",
              workspace: {
                path: "/tmp/explicit-automation-workspace",
                type: "unmanaged",
              },
            },
          },
        },
      });
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });

  it("enables invalid stored automations without failing and leaves them inert", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-automation-enable-invalid",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const automation = createAutomation(harness.db, harness.hub, {
        action: JSON.stringify({
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Enable invalid automation" }],
            environment: {
              type: "host",
              hostId: host.id,
              workspace: { type: "managed-clone" },
            },
          },
        }),
        autoArchive: false,
        enabled: false,
        name: "Invalid disabled automation",
        nextRunAt: null,
        projectId: project.id,
        triggerConfig: JSON.stringify(tooFrequentTrigger),
        triggerType: "schedule",
      });

      const enableResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/automations/${automation.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            enabled: true,
          }),
        },
      );

      expect(enableResponse.status).toBe(200);
      expect(automationSchema.parse(await readJson(enableResponse))).toMatchObject({
        enabled: true,
        id: automation.id,
        isValid: false,
        nextRunAt: null,
        validationIssues: [
          "Schedule must not run more frequently than every 5 minutes",
        ],
      });
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
        triggerConfig: JSON.stringify(weekdayMorningTrigger),
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
