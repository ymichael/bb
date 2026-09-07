import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  getHelpOutput,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread log command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("bb thread log help describes verbose as expanded timeline output", async () => {
    const helpOutput = await getHelpOutput(["thread", "log"], register);

    expect(helpOutput).toContain("verbose (expanded timeline)");
    expect(helpOutput).not.toContain("verbose (full timeline)");
  });

  it("bb thread log --json prints raw events", async () => {
    const thread = {
      id: "thread-json-log",
      projectId: "proj-1",
      providerId: "provider-1",
      type: "task",
      status: "idle",
      createdAt: 10,
      updatedAt: 20,
    };
    const events = [
      {
        id: "evt-1",
        threadId: "thread-json-log",
        type: "system/error",
        data: { code: "provider_unavailable" },
        createdAt: 20,
        sequence: 2,
      },
    ];
    const getThread = vi.fn(async () => thread);
    const getEvents = vi.fn(async () => events);
    stubServerApi({
      "v1.threads.:id.$get": getThread,
      "v1.threads.:id.events.$get": getEvents,
    });

    await runCommand(["thread", "log", "thread-json-log", "--json"], register);

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(events);
  });

  it("bb thread log renders merged timeline rows for human output", async () => {
    const getEvents = vi.fn(async () => []);
    const getTimeline = vi.fn(async () =>
      fixtures.makeTimelineResponse([
        {
          ...fixtures.makeTimelineBase({
            id: "user-1",
            sourceSeqStart: 1,
          }),
          kind: "conversation",
          role: "user",
          text: "Say hello",
          attachments: null,
          mentions: [],
          initiator: "user",
          senderThreadId: null,
          systemMessageKind: "unlabeled",
          systemMessageSubject: null,
          turnRequest: {
            isGrouped: false,
            kind: "message",
            status: "accepted",
          },
        },
        {
          ...fixtures.makeTimelineBase({
            id: "op-1",
            sourceSeqStart: 2,
            sourceSeqEnd: 8,
            startedAt: 2,
            createdAt: 8,
          }),
          kind: "system",
          systemKind: "operation",
          operationKind: "thread-provisioning",
          title: "Provisioned thread",
          detail: null,
          status: "completed",
          completedAt: 8,
        },
        {
          ...fixtures.makeTimelineBase({
            id: "assistant-1",
            sourceSeqStart: 9,
          }),
          kind: "conversation",
          role: "assistant",
          text: "Hello!",
          attachments: null,
          turnRequest: null,
        },
      ]),
    );
    stubServerApi({
      "v1.threads.:id.events.$get": getEvents,
      "v1.threads.:id.timeline.$get": getTimeline,
    });

    await runCommand(
      ["thread", "log", "thread-log", "--format", "verbose"],
      register,
    );

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output).toContain("Provisioned thread");
    expect(output).not.toContain("Provisioning interrupted");
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("bb thread log renders pending steers for human output", async () => {
    const getEvents = vi.fn(async () => []);
    const getTimeline = vi.fn(async () =>
      fixtures.makeTimelineResponse([fixtures.makePendingSteerTimelineRow()]),
    );
    stubServerApi({
      "v1.threads.:id.events.$get": getEvents,
      "v1.threads.:id.timeline.$get": getTimeline,
    });

    await runCommand(
      ["thread", "log", "thread-log", "--format", "verbose"],
      register,
    );

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output).toContain("Please switch to the safer plan");
    expect(output).toContain("steer pending");
    expect(getTimeline).toHaveBeenCalledWith({
      param: { id: "thread-log" },
      query: { includeNestedRows: "true" },
    });
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("bb thread log renders pending steers with default formatting", async () => {
    const getEvents = vi.fn(async () => []);
    const getTimeline = vi.fn(async () =>
      fixtures.makeTimelineResponse([fixtures.makePendingSteerTimelineRow()]),
    );
    stubServerApi({
      "v1.threads.:id.events.$get": getEvents,
      "v1.threads.:id.timeline.$get": getTimeline,
    });

    await runCommand(["thread", "log", "thread-log"], register);

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output).toContain("Please switch to the safer plan");
    expect(output).toContain("steer pending");
    expect(getTimeline).toHaveBeenCalledWith({
      param: { id: "thread-log" },
      query: {},
    });
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("bb thread log renders approval state on command and file-change rows", async () => {
    const getEvents = vi.fn(async () => []);
    const getTimeline = vi.fn(async () =>
      fixtures.makeTimelineResponse([
        {
          ...fixtures.makeTimelineBase({
            id: "command-approval",
            sourceSeqStart: 1,
          }),
          kind: "work",
          workKind: "command",
          status: "pending",
          callId: "cmd-1",
          command: "git push",
          cwd: null,
          source: null,
          output: "",
          exitCode: null,
          completedAt: null,
          approvalStatus: "waiting_for_approval",
          activityIntents: [],
        },
        {
          ...fixtures.makeTimelineBase({
            id: "file-approval",
            sourceSeqStart: 2,
          }),
          kind: "work",
          workKind: "file-change",
          status: "interrupted",
          callId: "file-1",
          change: {
            path: "src/example.ts",
            kind: null,
            movePath: null,
            diff: null,
            diffStats: { added: 0, removed: 0 },
          },
          stdout: null,
          stderr: null,
          approvalStatus: "denied",
        },
      ]),
    );
    stubServerApi({
      "v1.threads.:id.events.$get": getEvents,
      "v1.threads.:id.timeline.$get": getTimeline,
    });

    await runCommand(
      ["thread", "log", "thread-log", "--format", "verbose"],
      register,
    );

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output).toContain("Waiting for approval to run git push");
    expect(output).toContain("git push");
    expect(output).toContain("denied");
    expect(output).toContain("example.ts");
    expect(output).not.toContain("Command approval started");
    expect(output).not.toContain("File-change approval started");
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("bb thread log --json caps at --limit and warns on stderr when more events exist", async () => {
    const events = Array.from({ length: 4 }, (_, index) => ({
      id: `evt-${index + 1}`,
      scope: { kind: "thread" },
      threadId: "thread-json-log",
      type: "system/error",
      data: { code: "provider_unavailable" },
      createdAt: 20 + index,
      seq: index + 1,
    }));
    const getEvents = vi.fn(async () => events);
    stubServerApi({
      "v1.threads.:id.events.$get": getEvents,
    });

    await runCommand(
      ["thread", "log", "thread-json-log", "--json", "--limit", "3"],
      register,
    );

    expect(getEvents).toHaveBeenCalledWith({
      param: { id: "thread-json-log" },
      query: { limit: "4" },
    });
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(events.slice(0, 3));
    const stderr = collectLogLines(vi.mocked(console.error)).join("\n");
    expect(stderr).toContain("oldest 3 events");
    expect(stderr).toContain("--after-seq 3");
    expect(stderr).toContain("--all");
  });

  it("bb thread log --json stays quiet when the page is not full", async () => {
    const events = [
      {
        id: "evt-1",
        scope: { kind: "thread" },
        threadId: "thread-json-log",
        type: "system/error",
        data: { code: "provider_unavailable" },
        createdAt: 20,
        seq: 1,
      },
    ];
    stubServerApi({
      "v1.threads.:id.events.$get": vi.fn(async () => events),
    });

    await runCommand(["thread", "log", "thread-json-log", "--json"], register);

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(events);
    expect(collectLogLines(vi.mocked(console.error))).toEqual([]);
  });

  it("bb thread log --json --all pages through every event with --after-seq", async () => {
    const makeEvent = (seq: number) => ({
      id: `evt-${seq}`,
      scope: { kind: "thread" },
      threadId: "thread-json-log",
      type: "system/error",
      data: { code: "provider_unavailable" },
      createdAt: 20 + seq,
      seq,
    });
    const getEvents = vi.fn(
      async (input: { query: { afterSeq?: string; limit?: string } }) => {
        const afterSeq = Number(input.query.afterSeq ?? 0);
        const limit = Number(input.query.limit);
        return Array.from({ length: 1203 }, (_, index) => makeEvent(index + 1))
          .filter((event) => event.seq > afterSeq)
          .slice(0, limit);
      },
    );
    stubServerApi({
      "v1.threads.:id.events.$get": getEvents,
    });

    await runCommand(
      ["thread", "log", "thread-json-log", "--json", "--all"],
      register,
    );

    const printed = JSON.parse(
      String(vi.mocked(console.log).mock.calls[0]?.[0]),
    ) as Array<{ seq: number }>;
    expect(printed).toHaveLength(1203);
    expect(printed[0]?.seq).toBe(1);
    expect(printed[1202]?.seq).toBe(1203);
    expect(getEvents.mock.calls.map((call) => call[0].query.afterSeq)).toEqual([
      undefined,
      "1000",
    ]);
    expect(collectLogLines(vi.mocked(console.error))).toEqual([]);
  });

  it("bb thread log prints an older-history notice when the timeline page is cut", async () => {
    const getTimeline = vi.fn(async () => ({
      ...fixtures.makeTimelineResponse([
        fixtures.makePendingSteerTimelineRow(),
      ]),
      timelinePage: {
        kind: "latest" as const,
        segmentLimit: 20,
        returnedSegmentCount: 20,
        hasOlderRows: true,
        olderCursor: { anchorSeq: 12, anchorId: "pending-steer-1" },
      },
    }));
    stubServerApi({
      "v1.threads.:id.timeline.$get": getTimeline,
    });

    await runCommand(["thread", "log", "thread-log"], register);

    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output).toContain("Please switch to the safer plan");
    expect(output).toContain("newest 20 user-message turns");
    expect(output).toContain("older history omitted");
    expect(output).toContain("--all");
  });

  it("bb thread log --limit sets the timeline segment limit for human output", async () => {
    const getTimeline = vi.fn(async () =>
      fixtures.makeTimelineResponse([fixtures.makePendingSteerTimelineRow()]),
    );
    stubServerApi({
      "v1.threads.:id.timeline.$get": getTimeline,
    });

    await runCommand(
      ["thread", "log", "thread-log", "--format", "verbose", "--limit", "50"],
      register,
    );

    expect(getTimeline).toHaveBeenCalledWith({
      param: { id: "thread-log" },
      query: { includeNestedRows: "true", segmentLimit: "50" },
    });
    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output).toContain("Please switch to the safer plan");
    expect(output).not.toContain("older history omitted");
  });

  it("bb thread log --all walks older timeline pages and prints them oldest first", async () => {
    const makeUserRow = (id: string, seq: number, text: string) => ({
      ...fixtures.makePendingSteerTimelineRow(),
      ...fixtures.makeTimelineBase({ id, sourceSeqStart: seq }),
      text,
      turnRequest: {
        isGrouped: false,
        kind: "message" as const,
        status: "accepted" as const,
      },
    });
    const getTimeline = vi.fn(
      async (input: {
        query: { beforeAnchorSeq?: string; beforeAnchorId?: string };
      }) => {
        if (input.query.beforeAnchorSeq === undefined) {
          return {
            ...fixtures.makeTimelineResponse([
              makeUserRow("user-3", 30, "third prompt"),
            ]),
            timelinePage: {
              kind: "latest" as const,
              segmentLimit: 100,
              returnedSegmentCount: 1,
              hasOlderRows: true,
              olderCursor: { anchorSeq: 30, anchorId: "user-3" },
            },
          };
        }
        if (input.query.beforeAnchorSeq === "30") {
          return {
            ...fixtures.makeTimelineResponse([
              makeUserRow("user-2", 20, "second prompt"),
            ]),
            timelinePage: {
              kind: "older" as const,
              segmentLimit: 100,
              returnedSegmentCount: 1,
              hasOlderRows: true,
              olderCursor: { anchorSeq: 20, anchorId: "user-2" },
            },
          };
        }
        return {
          ...fixtures.makeTimelineResponse([
            makeUserRow("user-1", 10, "first prompt"),
          ]),
          timelinePage: {
            kind: "older" as const,
            segmentLimit: 100,
            returnedSegmentCount: 1,
            hasOlderRows: false,
            olderCursor: null,
          },
        };
      },
    );
    stubServerApi({
      "v1.threads.:id.timeline.$get": getTimeline,
    });

    await runCommand(["thread", "log", "thread-log", "--all"], register);

    expect(getTimeline.mock.calls.map((call) => call[0].query)).toEqual([
      { segmentLimit: "100" },
      { segmentLimit: "100", beforeAnchorSeq: "30", beforeAnchorId: "user-3" },
      { segmentLimit: "100", beforeAnchorSeq: "20", beforeAnchorId: "user-2" },
    ]);
    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output.indexOf("first prompt")).toBeGreaterThan(-1);
    expect(output.indexOf("first prompt")).toBeLessThan(
      output.indexOf("second prompt"),
    );
    expect(output.indexOf("second prompt")).toBeLessThan(
      output.indexOf("third prompt"),
    );
    expect(output).not.toContain("older history omitted");
  });

  it("bb thread log rejects --all combined with --limit", async () => {
    stubServerApi({
      "v1.threads.:id.timeline.$get": vi.fn(async () =>
        fixtures.makeTimelineResponse([]),
      ),
    });

    await expect(
      runCommand(
        ["thread", "log", "thread-log", "--all", "--limit", "5"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(collectLogLines(vi.mocked(console.error)).join("\n")).toContain(
      "--all cannot be combined with --limit",
    );
  });

  it("bb thread log --self resolves from BB_THREAD_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-log-self");
    const getEvents = vi.fn(async () => []);
    const getTimeline = vi.fn(async () => fixtures.makeTimelineResponse([]));
    stubServerApi({
      "v1.threads.:id.events.$get": getEvents,
      "v1.threads.:id.timeline.$get": getTimeline,
    });

    await runCommand(["thread", "log", "--self"], register);

    expect(getEvents).not.toHaveBeenCalled();
    expect(getTimeline).toHaveBeenCalledWith({
      param: { id: "thread-log-self" },
      query: {},
    });
    expect(collectLogLines(vi.mocked(console.error))).toEqual([]);
  });
});
