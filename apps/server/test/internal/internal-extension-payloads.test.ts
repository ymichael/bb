import { eq } from "drizzle-orm";
import { events } from "@bb/db";
import { threadScope, turnScope, type ExtensionKind } from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EXTENSION_PAYLOAD_MAX_BYTES } from "../../src/internal/extension-payloads.js";
import { buildPluginProviderRegistration } from "../../src/services/providers/plugin-provider-registration.js";
import { validatePluginProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { minimalProviderRegistration } from "../helpers/provider-registry.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

const PLUGIN_ID = "provider-widgets";
const PROVIDER_ID = "widgets";
const GOAL_KIND = `${PLUGIN_ID}/goal` as const;
const PRESENTATION = {
  label: { pending: "Updating goal", completed: "Goal updated" },
  icon: { glyph: "Target" },
};

function registerExtensionProvider(
  harness: TestAppHarness,
  args: {
    pluginId: string;
    providerId: string;
    displayName: string;
    extensionKinds: Parameters<
      typeof validatePluginProviderDeclaration
    >[0]["extensionKinds"];
  },
) {
  harness.deps.providerRegistry.register({
    ...buildPluginProviderRegistration({
      iconHash: null,
      available: true,
      pluginId: args.pluginId,
      declaration: validatePluginProviderDeclaration({
        id: args.providerId,
        displayName: args.displayName,
        maintenance: { health: false, usage: false, installation: false },
        capabilities: {
          supportsServiceTier: false,
          supportsNativeUserQuestion: false,
          fork: "none",
          supportsManualCompaction: false,
          supportsThreadArchive: false,
          supportsThreadRename: false,
          permissionModes: ["full"],
          reasoningLevels: ["medium"],
        },
        composerActions: [],
        extensionKinds: args.extensionKinds,
      }),
      readSettings: () => ({}),
    }),
    pluginId: args.pluginId,
    iconNames: new Set<string>(),
  });
}

async function setup() {
  const harness = await createTestAppHarness();
  registerExtensionProvider(harness, {
    pluginId: PLUGIN_ID,
    providerId: PROVIDER_ID,
    displayName: "Widgets",
    extensionKinds: {
      goal: {
        item: z.object({ objective: z.string().min(1) }),
        state: z.object({ status: z.enum(["active", "done"]) }),
      },
    },
  });
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: PROVIDER_ID,
    status: "active",
  });
  return { harness, session, thread };
}

async function post(
  harness: TestAppHarness,
  sessionId: string,
  batch: HostDaemonEventEnvelope[],
): Promise<Response> {
  return harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId,
      eventGroups: groupHostDaemonEvents(batch),
    }),
  });
}

function storedRows(harness: TestAppHarness, threadId: string) {
  return harness.db
    .select({
      type: events.type,
      itemKind: events.itemKind,
      scopeKind: events.scopeKind,
      turnId: events.turnId,
      data: events.data,
    })
    .from(events)
    .where(eq(events.threadId, threadId))
    .orderBy(events.sequence)
    .all()
    .map((row) => ({
      type: row.type,
      itemKind: row.itemKind,
      scopeKind: row.scopeKind,
      turnId: row.turnId,
      data: JSON.parse(row.data) as unknown,
    }));
}

function extensionItemEvent(
  threadId: string,
  payload: unknown,
  kind: ExtensionKind = GOAL_KIND,
): HostDaemonEventEnvelope {
  return {
    threadId,
    event: {
      type: "item/started",
      threadId,
      providerThreadId: "prov-1",
      scope: turnScope("turn-1"),
      item: {
        type: "extension",
        id: "item-1",
        kind,
        payload: payload as never,
        status: "pending",
        presentation: PRESENTATION,
        parentToolCallId: "parent-1",
      },
    },
  };
}

function extensionStateEvent(
  threadId: string,
  payload: unknown,
  kind: ExtensionKind = GOAL_KIND,
): HostDaemonEventEnvelope {
  return {
    threadId,
    event: {
      type: "thread/extensionState/updated",
      threadId,
      providerThreadId: "prov-1",
      scope: threadScope(),
      kind,
      payload: payload as never,
    },
  };
}

function turnStarted(threadId: string): HostDaemonEventEnvelope {
  return {
    threadId,
    event: {
      type: "turn/started",
      threadId,
      providerThreadId: "prov-1",
      scope: turnScope("turn-1"),
    },
  };
}

describe("extension payload ingest validation", () => {
  it("persists an extension item and state whose payloads match the declared schemas", async () => {
    const { harness, session, thread } = await setup();
    try {
      const response = await post(harness, session.id, [
        turnStarted(thread.id),
        extensionItemEvent(thread.id, { objective: "Ship it" }),
        {
          threadId: thread.id,
          event: {
            type: "thread/extensionState/updated",
            threadId: thread.id,
            providerThreadId: "prov-1",
            scope: threadScope(),
            kind: GOAL_KIND,
            payload: { status: "active" },
          },
        },
      ]);
      expect(response.status).toBe(200);
      expect(storedRows(harness, thread.id)).toMatchObject([
        { type: "turn/started" },
        {
          type: "item/started",
          itemKind: "extension",
          data: {
            item: { kind: GOAL_KIND, payload: { objective: "Ship it" } },
          },
        },
        {
          type: "thread/extensionState/updated",
          data: { kind: GOAL_KIND, payload: { status: "active" } },
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("replaces a schema miss with provider/unhandled in the same batch slot", async () => {
    const { harness, session, thread } = await setup();
    try {
      const response = await post(harness, session.id, [
        turnStarted(thread.id),
        extensionItemEvent(thread.id, { objective: 42 }),
        {
          threadId: thread.id,
          event: {
            type: "thread/extensionState/updated",
            threadId: thread.id,
            providerThreadId: "prov-1",
            scope: threadScope(),
            kind: GOAL_KIND,
            payload: { status: "paused" },
          },
        },
      ]);
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        acceptedEvents: [
          { eventIndex: 0 },
          { eventIndex: 1 },
          { eventIndex: 2 },
        ],
        rejectedEvents: [],
      });
      const rows = storedRows(harness, thread.id);
      expect(rows.map((row) => row.type)).toEqual([
        "turn/started",
        "provider/unhandled",
        "provider/unhandled",
      ]);
      expect(rows[1]).toMatchObject({
        itemKind: null,
        scopeKind: "turn",
        turnId: "turn-1",
        data: {
          providerId: PROVIDER_ID,
          rawType: `extension/item:${GOAL_KIND}`,
          rawEvent: {
            method: "item/started",
            params: {
              kind: GOAL_KIND,
              payload: { objective: 42 },
              reason: expect.stringContaining("objective"),
            },
          },
          parentToolCallId: "parent-1",
        },
      });
      expect(rows[2]).toMatchObject({
        scopeKind: "thread",
        turnId: null,
        data: {
          rawType: `extension/state:${GOAL_KIND}`,
          rawEvent: { method: "thread/extensionState/updated" },
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects an undeclared kind, a declared kind with no schema for the surface, and an oversized payload", async () => {
    const { harness, session, thread } = await setup();
    try {
      const response = await post(harness, session.id, [
        turnStarted(thread.id),
        extensionItemEvent(
          thread.id,
          { objective: "x" },
          "provider-nobody/goal",
        ),
        extensionItemEvent(
          thread.id,
          { objective: "x" },
          `${PLUGIN_ID}/widget`,
        ),
        extensionItemEvent(thread.id, {
          objective: "x".repeat(EXTENSION_PAYLOAD_MAX_BYTES + 1),
        }),
      ]);
      expect(response.status).toBe(200);
      const rows = storedRows(harness, thread.id);
      expect(rows.map((row) => row.type)).toEqual([
        "turn/started",
        "provider/unhandled",
        "provider/unhandled",
        "provider/unhandled",
      ]);
      expect(rows.slice(1).map((row) => row.data)).toMatchObject([
        {
          rawEvent: {
            params: {
              reason: `extension kind "provider-nobody/goal" is owned by plugin "provider-nobody", but the thread's provider "${PROVIDER_ID}" is registered by plugin "${PLUGIN_ID}"`,
            },
          },
        },
        {
          rawEvent: {
            params: { reason: expect.stringContaining("declares no") },
          },
        },
        {
          rawEvent: {
            params: { reason: expect.stringContaining("bytes; the limit is") },
          },
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("stops accepting a kind once its plugin's registration is disposed", async () => {
    const { harness, session, thread } = await setup();
    try {
      const registration = harness.deps.providerRegistry.get(PROVIDER_ID);
      expect(registration?.extensionKinds.goal?.item).toBeDefined();
      expect(
        harness.deps.providerRegistry.getExtensionKindSchemas(GOAL_KIND),
      ).toBe(registration?.extensionKinds.goal);
      const handle = harness.deps.providerRegistry.register({
        ...minimalProviderRegistration({
          pluginId: PLUGIN_ID,
          info: { ...registration!.info, id: "widgets-2" },
          serverCapabilities: registration!.serverCapabilities,
        }),
        extensionKinds: {
          badge: { item: z.object({ text: z.string() }) },
        },
      });
      expect(
        harness.deps.providerRegistry.getExtensionKindSchemas(
          `${PLUGIN_ID}/badge`,
        ),
      ).not.toBeNull();
      handle.dispose();
      expect(
        harness.deps.providerRegistry.getExtensionKindSchemas(
          `${PLUGIN_ID}/badge`,
        ),
      ).toBeNull();

      const response = await post(harness, session.id, [
        turnStarted(thread.id),
        extensionItemEvent(thread.id, { text: "hi" }, `${PLUGIN_ID}/badge`),
      ]);
      expect(response.status).toBe(200);
      expect(storedRows(harness, thread.id).map((row) => row.type)).toEqual([
        "turn/started",
        "provider/unhandled",
      ]);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("extension kind ownership at ingest", () => {
  const OTHER_PLUGIN_ID = "provider-gadgets";
  const OTHER_PROVIDER_ID = "gadgets";

  it("refuses another plugin's kind on a thread of this provider, and keeps it on the owner's own thread", async () => {
    const { harness, session, thread } = await setup();
    try {
      registerExtensionProvider(harness, {
        pluginId: OTHER_PLUGIN_ID,
        providerId: OTHER_PROVIDER_ID,
        displayName: "Gadgets",
        extensionKinds: {},
      });
      const other = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: OTHER_PROVIDER_ID,
        status: "active",
      });
      const foreign = await post(harness, session.id, [
        turnStarted(other.id),
        extensionItemEvent(other.id, { objective: "Ship it" }),
        extensionStateEvent(other.id, { status: "active" }),
      ]);
      expect(foreign.status).toBe(200);
      await expect(readJson(foreign)).resolves.toMatchObject({
        acceptedEvents: [
          { eventIndex: 0 },
          { eventIndex: 1 },
          { eventIndex: 2 },
        ],
        rejectedEvents: [],
      });
      const foreignRows = storedRows(harness, other.id);
      expect(foreignRows.map((row) => row.type)).toEqual([
        "turn/started",
        "provider/unhandled",
        "provider/unhandled",
      ]);
      const reason = `extension kind "${GOAL_KIND}" is owned by plugin "${PLUGIN_ID}", but the thread's provider "${OTHER_PROVIDER_ID}" is registered by plugin "${OTHER_PLUGIN_ID}"`;
      expect(foreignRows[1]).toMatchObject({
        itemKind: null,
        scopeKind: "turn",
        turnId: "turn-1",
        data: {
          providerId: OTHER_PROVIDER_ID,
          rawType: `extension/item:${GOAL_KIND}`,
          rawEvent: {
            method: "item/started",
            params: {
              kind: GOAL_KIND,
              payload: { objective: "Ship it" },
              reason,
            },
          },
          parentToolCallId: "parent-1",
        },
      });
      expect(foreignRows[2]).toMatchObject({
        scopeKind: "thread",
        turnId: null,
        data: {
          providerId: OTHER_PROVIDER_ID,
          rawType: `extension/state:${GOAL_KIND}`,
          rawEvent: {
            method: "thread/extensionState/updated",
            params: { kind: GOAL_KIND, payload: { status: "active" }, reason },
          },
        },
      });

      const own = await post(harness, session.id, [
        turnStarted(thread.id),
        extensionItemEvent(thread.id, { objective: "Ship it" }),
        extensionStateEvent(thread.id, { status: "active" }),
      ]);
      expect(own.status).toBe(200);
      expect(storedRows(harness, thread.id)).toMatchObject([
        { type: "turn/started" },
        {
          type: "item/started",
          itemKind: "extension",
          data: {
            item: { kind: GOAL_KIND, payload: { objective: "Ship it" } },
          },
        },
        {
          type: "thread/extensionState/updated",
          data: { kind: GOAL_KIND, payload: { status: "active" } },
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("refuses every extension kind on a thread whose provider has no live registration", async () => {
    const { harness, session, thread } = await setup();
    try {
      const orphan = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        providerId: "unregistered",
        status: "active",
      });
      const response = await post(harness, session.id, [
        turnStarted(orphan.id),
        extensionItemEvent(orphan.id, { objective: "Ship it" }),
        extensionStateEvent(orphan.id, { status: "active" }),
      ]);
      expect(response.status).toBe(200);
      const rows = storedRows(harness, orphan.id);
      expect(rows.map((row) => row.type)).toEqual([
        "turn/started",
        "provider/unhandled",
        "provider/unhandled",
      ]);
      const reason = `extension kind "${GOAL_KIND}" names plugin "${PLUGIN_ID}", but the thread's provider "unregistered" has no live registration to check it against`;
      expect(rows.slice(1)).toMatchObject([
        {
          data: {
            providerId: "unregistered",
            rawEvent: { params: { kind: GOAL_KIND, reason } },
          },
        },
        {
          data: {
            providerId: "unregistered",
            rawEvent: { params: { kind: GOAL_KIND, reason } },
          },
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });
});
