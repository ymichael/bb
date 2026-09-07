import { describe, expect, it } from "vitest";
import {
  CORE_ITEM_KINDS,
  THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH,
  isCoreItemKind,
  threadEventItemPresentationSchema,
  threadEventItemSchema,
  threadEventSchema,
  threadScope,
  turnScope,
  type ThreadEventItem,
  type ThreadEventItemType,
} from "../src/index.js";

const presentation = {
  label: { pending: "Reading file", completed: "Read file" },
  icon: { glyph: "FileText" },
};

describe("grammar v3 item variants", () => {
  it("parses every new core item kind with an optional presentation", () => {
    const items: ThreadEventItem[] = [
      {
        type: "fileRead",
        id: "item_1",
        path: "src/index.ts",
        status: "completed",
      },
      {
        type: "fileRead",
        id: "item_2",
        path: "src/index.ts",
        cmd: "sed -n 1,40p src/index.ts",
        status: "completed",
        presentation,
      },
      {
        type: "search",
        id: "item_3",
        mode: "content",
        query: "TODO",
        path: "src",
        status: "completed",
      },
      {
        type: "search",
        id: "item_4",
        mode: "list",
        query: "",
        cmd: "ls -la",
        status: "pending",
      },
      {
        type: "delegation",
        id: "item_5",
        childRef: "agent-7",
        label: "Explore the auth module",
        status: "pending",
        background: true,
      },
      {
        type: "planSteps",
        id: "item_6",
        steps: [{ step: "Fix bug", status: "active" }, { step: "Test" }],
        explanation: "Two steps",
        status: "completed",
      },
    ];
    for (const item of items) {
      const parsed = threadEventItemSchema.safeParse(item);
      expect(parsed.success, `expected ${item.type} to parse`).toBe(true);
    }
  });

  it("keeps presentation optional on every existing provider item", () => {
    const parsed = threadEventItemSchema.parse({
      type: "toolCall",
      id: "item_1",
      tool: "mcp__linear__create_issue",
      status: "completed",
      presentation: { ...presentation, suppress: true },
    });
    expect(parsed.type === "toolCall" && parsed.presentation?.suppress).toBe(
      true,
    );
    expect(
      threadEventItemSchema.safeParse({
        type: "toolCall",
        id: "item_1",
        tool: "Read",
        status: "completed",
      }).success,
    ).toBe(true);
  });

  it("requires presentation on extension items and validates the namespace", () => {
    const valid = {
      type: "extension",
      id: "item_1",
      kind: "codex/goal",
      payload: { objective: "Ship it", status: "active" },
      status: "pending",
      presentation,
    };
    expect(threadEventItemSchema.safeParse(valid).success).toBe(true);
    expect(
      threadEventItemSchema.safeParse({ ...valid, presentation: undefined })
        .success,
    ).toBe(false);
    for (const kind of ["goal", "Codex/goal", "codex/", "/goal", "a/b/c"]) {
      expect(
        threadEventItemSchema.safeParse({ ...valid, kind }).success,
        `expected kind ${JSON.stringify(kind)} to be rejected`,
      ).toBe(false);
    }
  });

  it("caps presentation detail and requires both labels", () => {
    expect(
      threadEventItemPresentationSchema.safeParse({
        ...presentation,
        detail: "x".repeat(THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      threadEventItemPresentationSchema.safeParse({
        ...presentation,
        detail: "x".repeat(
          THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH + 1,
        ),
      }).success,
    ).toBe(false);
    expect(
      threadEventItemPresentationSchema.safeParse({
        label: { pending: "Reading" },
        icon: { glyph: "FileText" },
      }).success,
    ).toBe(false);
    expect(
      threadEventItemPresentationSchema.safeParse({
        ...presentation,
        tint: { light: "#112233", dark: "#ddeeff" },
      }).success,
    ).toBe(true);
    expect(
      threadEventItemPresentationSchema.safeParse({
        ...presentation,
        icon: { asset: "./icons/tool.svg" },
      }).success,
    ).toBe(false);
    const namespaced = threadEventItemPresentationSchema.safeParse({
      ...presentation,
      icon: { glyph: "echo-provider/receipt" },
    });
    expect(namespaced.success).toBe(true);
    expect(namespaced.data?.icon.glyph).toBe("echo-provider/receipt");
    expect(
      threadEventItemPresentationSchema.safeParse({
        ...presentation,
        icon: { glyph: "" },
      }).success,
    ).toBe(false);
  });

  it("scopes delegation progress and completion to the thread like background tasks", () => {
    const item = {
      type: "delegation",
      id: "item_1",
      childRef: "agent-7",
      label: "Explore",
      status: "completed",
      background: true,
      summary: "Found it",
    };
    for (const type of [
      "item/delegation/progress",
      "item/delegation/completed",
    ] as const) {
      expect(
        threadEventSchema.safeParse({
          type,
          threadId: "thr_1",
          providerThreadId: "p-1",
          scope: threadScope(),
          item,
        }).success,
      ).toBe(true);
      expect(
        threadEventSchema.safeParse({
          type,
          threadId: "thr_1",
          providerThreadId: "p-1",
          scope: turnScope("turn_1"),
          item,
        }).success,
      ).toBe(false);
    }
    expect(
      threadEventSchema.safeParse({
        type: "item/completed",
        threadId: "thr_1",
        providerThreadId: "p-1",
        scope: turnScope("turn_1"),
        item: { ...item, background: false },
      }).success,
    ).toBe(true);
  });
});

describe("CORE_ITEM_KINDS (guardrail G4)", () => {
  it("enumerates every persisted item kind except extension, exactly once", () => {
    const schemaKinds = threadEventItemSchema.options
      .map((option) => option.shape.type.value)
      .filter((kind): kind is ThreadEventItemType => kind !== "extension");
    expect([...CORE_ITEM_KINDS].sort()).toEqual([...schemaKinds].sort());
    expect(new Set(CORE_ITEM_KINDS).size).toBe(CORE_ITEM_KINDS.length);
    expect(isCoreItemKind("extension")).toBe(false);
    expect(isCoreItemKind("fileRead")).toBe(true);
  });
});
