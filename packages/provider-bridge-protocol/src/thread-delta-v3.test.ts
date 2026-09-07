import { describe, expect, it } from "vitest";
import {
  BRIDGE_NOTIFICATION_METHODS,
  bridgeCapabilitiesSchema,
  initializeParamsSchema,
  initializeResultSchema,
  negotiateGrammarVersion,
  providerRecoveryNotificationSchema,
} from "./index.js";
import {
  deltaItemShapeSchema,
  deltaPresentationSchema,
  threadDeltaSchema,
} from "./thread-delta.js";

const presentation = {
  label: { pending: "Reading file", completed: "Read file" },
  icon: { glyph: "FileText" },
  title: "src/index.ts",
};

describe("thread delta grammar v3", () => {
  it("parses every new item shape on item.open and item.close", () => {
    const shapes = [
      { type: "fileRead", path: "src/index.ts" },
      { type: "fileRead", path: "src/index.ts", cmd: "cat src/index.ts" },
      { type: "search", mode: "content", query: "TODO", path: "src" },
      { type: "search", mode: "path", query: "**/*.test.ts" },
      { type: "search", mode: "list", query: "", cmd: "ls -la" },
      {
        type: "delegation",
        childRef: "agent-7",
        label: "Explore the auth module",
        background: false,
      },
      {
        type: "delegation",
        childRef: "agent-8",
        label: "Run the suite",
        background: true,
        summary: "All green",
      },
      {
        type: "planSteps",
        steps: [{ step: "Fix bug", status: "active" }, { step: "Test" }],
        explanation: "Two steps",
      },
    ];
    for (const item of shapes) {
      expect(
        threadDeltaSchema.safeParse({
          kind: "item.open",
          key: { providerItemId: "tc-1" },
          item,
          presentation,
        }).success,
        `expected item.open ${item.type} to parse`,
      ).toBe(true);
      expect(
        threadDeltaSchema.safeParse({
          kind: "item.close",
          key: { providerItemId: "tc-1" },
          status: "completed",
          item,
        }).success,
        `expected item.close ${item.type} to parse`,
      ).toBe(true);
    }
  });

  it("requires the delta-level presentation for extension shapes, on open and close", () => {
    const item = {
      type: "extension",
      kind: "codex/goal",
      payload: { objective: "Ship it" },
    };
    for (const delta of [
      { kind: "item.open", key: { providerItemId: "tc-1" }, item },
      {
        kind: "item.close",
        key: { providerItemId: "tc-1" },
        status: "completed",
        item,
      },
    ]) {
      const missing = threadDeltaSchema.safeParse(delta);
      expect(missing.success, `expected ${delta.kind} to be rejected`).toBe(
        false,
      );
      expect(missing.error?.issues[0]?.path).toEqual(["presentation"]);
      expect(
        threadDeltaSchema.safeParse({ ...delta, presentation }).success,
        `expected ${delta.kind} with presentation to parse`,
      ).toBe(true);
    }
    expect(
      deltaItemShapeSchema.parse({ ...item, presentation }),
    ).not.toHaveProperty("presentation");
  });

  it("keeps v2 deltas valid: presentation is optional on open and close", () => {
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.open",
        key: { providerItemId: "tc-1" },
        item: { type: "tool", tool: "Read", args: { path: "x" } },
      }).success,
    ).toBe(true);
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.open",
        key: { providerItemId: "tc-1" },
        item: { type: "tool", tool: "Read" },
        presentation: { ...presentation, suppress: true },
      }).success,
    ).toBe(true);
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.open",
        key: { providerItemId: "tc-1" },
        item: { type: "tool", tool: "Read" },
        presentation: { label: { pending: "Reading" } },
      }).success,
    ).toBe(false);
  });

  it("rejects malformed v3 shapes", () => {
    expect(
      deltaItemShapeSchema.safeParse({
        type: "search",
        mode: "fuzzy",
        query: "x",
      }).success,
    ).toBe(false);
    expect(
      deltaItemShapeSchema.safeParse({
        type: "delegation",
        childRef: "",
        label: "x",
        background: false,
      }).success,
    ).toBe(false);
    for (const kind of ["goal", "Codex/goal", "codex/goal/x", "codex/"]) {
      expect(
        deltaItemShapeSchema.safeParse({
          type: "extension",
          kind,
          payload: {},
        }).success,
        `expected extension kind ${JSON.stringify(kind)} to be rejected`,
      ).toBe(false);
    }
    expect(
      deltaItemShapeSchema.safeParse({
        type: "extension",
        kind: "codex/goal",
        payload: { when: new Date() },
      }).success,
    ).toBe(false);
  });

  it("parses extension.state and validates its namespace only", () => {
    expect(
      threadDeltaSchema.safeParse({
        kind: "extension.state",
        extensionKind: "codex/goal",
        payload: { objective: "Ship it", tokensUsed: 12 },
      }).success,
    ).toBe(true);
    expect(
      threadDeltaSchema.safeParse({
        kind: "extension.state",
        extensionKind: "goal",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("accepts a background-delegation snapshot on item.progress beside background tasks", () => {
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.progress",
        key: { providerItemId: "tc-1" },
        snapshot: {
          type: "delegation",
          childRef: "agent-7",
          label: "Explore",
          background: true,
        },
      }).success,
    ).toBe(true);
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.progress",
        key: { providerItemId: "tc-1" },
        snapshot: {
          type: "backgroundTask",
          familyId: "task-1",
          taskType: "local_bash",
          description: "pnpm test",
          status: "pending",
          taskStatus: "running",
          skipTranscript: false,
        },
      }).success,
    ).toBe(true);
    expect(
      threadDeltaSchema.safeParse({
        kind: "item.progress",
        key: { providerItemId: "tc-1" },
        snapshot: { type: "fileRead", path: "x" },
      }).success,
    ).toBe(false);
  });

  it("shares one presentation vocabulary with the persisted item", () => {
    expect(deltaPresentationSchema.safeParse(presentation).success).toBe(true);
    expect(
      deltaPresentationSchema.safeParse({
        ...presentation,
        detail: "x".repeat(281),
      }).success,
    ).toBe(false);
  });
});

describe("handshake v3 capabilities", () => {
  it("reads an older bridge as v2-only with queued steers", () => {
    const parsed = initializeResultSchema.parse({ protocolVersion: 2 });
    expect(parsed.capabilities.grammarVersions).toEqual([2, 2]);
    expect(parsed.capabilities.steerMode).toBe("queue");
  });

  it("accepts an explicit grammar range and steer mode", () => {
    const parsed = bridgeCapabilitiesSchema.parse({
      grammarVersions: [2, 3],
      steerMode: "inject",
    });
    expect(parsed.grammarVersions).toEqual([2, 3]);
    expect(parsed.steerMode).toBe("inject");
  });

  it("negotiates the highest common grammar version in both directions", () => {
    const params = initializeParamsSchema.parse({
      protocolVersion: 2,
      client: { name: "bb", version: "1.0.0" },
    });
    expect(params.grammarVersions).toEqual([2, 2]);
    expect(negotiateGrammarVersion(params.grammarVersions, [2, 3])).toBe(2);
    expect(negotiateGrammarVersion([2, 3], [2, 3])).toBe(3);
    expect(negotiateGrammarVersion([2, 3], [3, 5])).toBe(3);
    expect(negotiateGrammarVersion([2, 2], [3, 4])).toBeNull();
    expect(negotiateGrammarVersion([3, 4], [2, 2])).toBeNull();
  });

  it("rejects a descending range, non-integers, and unknown steer modes", () => {
    expect(
      bridgeCapabilitiesSchema.safeParse({ grammarVersions: [3, 2] }).success,
    ).toBe(false);
    expect(
      bridgeCapabilitiesSchema.safeParse({ grammarVersions: [2.5, 3] }).success,
    ).toBe(false);
    expect(
      bridgeCapabilitiesSchema.safeParse({ grammarVersions: [2] }).success,
    ).toBe(false);
    expect(
      bridgeCapabilitiesSchema.safeParse({ steerMode: "cancel" }).success,
    ).toBe(false);
  });
});

describe("provider/recovery notification", () => {
  it("is a registered bridge notification method", () => {
    expect(BRIDGE_NOTIFICATION_METHODS.providerRecovery).toBe(
      "provider/recovery",
    );
  });

  it("parses every recovery kind with and without a thread", () => {
    for (const kind of [
      "sessionArchived",
      "authRequired",
      "restartRecommended",
      "staleTurn",
      "rateLimited",
    ]) {
      expect(
        providerRecoveryNotificationSchema.safeParse({
          kind,
          message: "try again",
          retryable: true,
        }).success,
        `expected ${kind} to parse`,
      ).toBe(true);
    }
    expect(
      providerRecoveryNotificationSchema.safeParse({
        threadId: "thr_1",
        kind: "sessionArchived",
        message: "session is archived",
        retryable: true,
      }).success,
    ).toBe(true);
  });

  it("rejects free-text kinds: recovery is typed, never text-matched", () => {
    expect(
      providerRecoveryNotificationSchema.safeParse({
        kind: "thread abc is archived",
        message: "x",
        retryable: false,
      }).success,
    ).toBe(false);
    expect(
      providerRecoveryNotificationSchema.safeParse({
        kind: "authRequired",
        message: "",
        retryable: false,
      }).success,
    ).toBe(false);
    expect(
      providerRecoveryNotificationSchema.safeParse({
        kind: "authRequired",
        message: "sign in",
      }).success,
    ).toBe(false);
  });
});
