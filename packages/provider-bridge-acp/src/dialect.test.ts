import { describe, expect, it } from "vitest";
import {
  CURSOR_ACP_DIALECT,
  GENERIC_ACP_DIALECT,
  GROK_ACP_DIALECT,
  OMP_ACP_DIALECT,
  OPENCODE_ACP_DIALECT,
  resolveAcpDialect,
} from "./dialect.js";
import type { AcpToolCallUpdateEvent } from "./wire.js";

describe("resolveAcpDialect", () => {
  it("takes the dialect the registration named", () => {
    expect(
      resolveAcpDialect({ dialectId: "grok", command: "/opt/wrappers/agent" }),
    ).toBe(GROK_ACP_DIALECT);
    expect(resolveAcpDialect({ dialectId: "cursor", command: "node" })).toBe(
      CURSOR_ACP_DIALECT,
    );
    expect(resolveAcpDialect({ dialectId: "opencode", command: "node" })).toBe(
      OPENCODE_ACP_DIALECT,
    );
  });

  it("falls back to the launch executable's base name", () => {
    expect(resolveAcpDialect({ command: "grok" })).toBe(GROK_ACP_DIALECT);
    expect(resolveAcpDialect({ command: "/usr/local/bin/grok" })).toBe(
      GROK_ACP_DIALECT,
    );
    expect(resolveAcpDialect({ command: "cursor-agent" })).toBe(
      CURSOR_ACP_DIALECT,
    );
    expect(resolveAcpDialect({ command: "/opt/homebrew/bin/omp" })).toBe(
      OMP_ACP_DIALECT,
    );
    expect(resolveAcpDialect({ command: "/usr/local/bin/opencode" })).toBe(
      OPENCODE_ACP_DIALECT,
    );
  });

  it("is generic for a dialect id it does not ship", () => {
    expect(
      resolveAcpDialect({ dialectId: "amp", command: "cursor-agent" }),
    ).toBe(GENERIC_ACP_DIALECT);
  });

  it("gives an unknown agent the generic dialect, which answers nothing", () => {
    const dialect = resolveAcpDialect({ command: "amp" });
    expect(dialect).toBe(GENERIC_ACP_DIALECT);
    expect(dialect.toolIdentity).toBeUndefined();
    expect(dialect.classifyToolCall).toBeUndefined();
    expect(dialect.commandResult).toBeUndefined();
    expect(dialect.normalizeCommandEvent).toBeUndefined();
    expect(dialect.handleClientRequest).toBeUndefined();
  });
});

const toolCall = (fields: Partial<AcpToolCallUpdateEvent>) =>
  ({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    ...fields,
  }) as AcpToolCallUpdateEvent;

describe("omp command results", () => {
  const result = (fields: Partial<AcpToolCallUpdateEvent>) =>
    OMP_ACP_DIALECT.commandResult?.(
      toolCall({
        kind: "execute",
        status: "completed",
        rawInput: { command: "command" },
        ...fields,
      }),
    );

  it("preserves omp's reported non-zero exit code", () => {
    expect(
      result({
        status: "failed",
        rawOutput: {
          content: [
            {
              type: "text",
              text: "bad\n\nWall time: 0.50 seconds\n\nCommand exited with code 7",
            },
          ],
          details: { exitCode: 7, wallTimeMs: 500 },
        },
      }),
    ).toEqual({ exitCode: 7, output: "bad" });
  });

  it("does not remove suffix text that its structured details do not prove", () => {
    const output =
      "literal\n\nWall time: 1.24 seconds\n\nCommand exited with code 8";
    expect(
      result({
        status: "failed",
        rawOutput: {
          content: [{ type: "text", text: output }],
          details: { exitCode: 7, wallTimeMs: 1_250 },
        },
      }),
    ).toEqual({ exitCode: 7, output });
  });

  it("does not infer zero for a timeout or signal", () => {
    expect(
      result({
        status: "failed",
        rawOutput: {
          content: [
            {
              type: "text",
              text: "partial\n\nWall time: 1.00 seconds\n\n[Command timed out after 1 seconds]",
            },
          ],
          details: { timedOut: true, wallTimeMs: 1_000 },
        },
      }),
    ).toEqual({
      output:
        "partial\n\nWall time: 1.00 seconds\n\n[Command timed out after 1 seconds]",
    });

    expect(
      result({
        rawOutput: {
          content: [
            { type: "text", text: "killed\n\nWall time: 0.25 seconds" },
          ],
          details: { signal: "SIGTERM", wallTimeMs: 250 },
        },
      }),
    ).toEqual({ output: "killed" });
  });

  it.each<Partial<AcpToolCallUpdateEvent>>([
    {
      kind: "other",
      rawOutput: {
        content: [{ type: "text", text: "hello\n\nWall time: 0.25 seconds" }],
        details: { wallTimeMs: 250 },
      },
    },
    {
      rawInput: { cells: [{ code: "1 + 1" }] },
      rawOutput: {
        content: [{ type: "text", text: "2\n\nWall time: 0.25 seconds" }],
        details: { wallTimeMs: 250 },
      },
    },
    {
      rawOutput: {
        content: [{ type: "text", text: "hello" }],
        details: { timeoutSeconds: 10 },
      },
    },
    {
      rawOutput: {
        content: [{ type: "text", text: "hello\n\nWall time: 0.25 seconds" }],
        details: { wallTimeMs: 250 },
        exit_code: 9,
      },
    },
  ])(
    "leaves a result without the foreground Bash proof to generic ACP",
    (fields) => {
      expect(result(fields)).toBeUndefined();
    },
  );
});

describe("OpenCode command results", () => {
  const normalize = (rawOutput: unknown) =>
    OPENCODE_ACP_DIALECT.normalizeCommandEvent?.(toolCall({ rawOutput }))
      .rawOutput;

  it("normalizes the recorded output and metadata envelope", () => {
    expect(
      normalize({
        output: "ok\n",
        metadata: { exit: 0, output: "ok\n", truncated: false },
      }),
    ).toEqual({
      output: "ok\n",
      metadata: { exit: 0, output: "ok\n", truncated: false },
      stdout: "ok\n",
      exitCode: 0,
    });
  });

  it("falls back to metadata.output when top-level output is not text", () => {
    expect(
      normalize({
        output: [{ type: "text", text: "structured" }],
        metadata: { exit: 17, output: "failed\n", truncated: false },
      }),
    ).toEqual({
      output: [{ type: "text", text: "structured" }],
      metadata: { exit: 17, output: "failed\n", truncated: false },
      stdout: "failed\n",
      exitCode: 17,
    });
  });

  it("does not replace shared ACP result shapes", () => {
    const rawOutput = {
      exit_code: 7,
      stdout: "stdout\n",
      stderr: "stderr\n",
      output_for_prompt: "prompt output\n",
      output: "OpenCode output\n",
      metadata: { exit: 0, output: "OpenCode metadata output\n" },
    };
    expect(normalize(rawOutput)).toEqual(rawOutput);
  });
});

describe("grok sub-agents", () => {
  it("maps a spawn_subagent call to a delegation", () => {
    expect(
      GROK_ACP_DIALECT.classifyToolCall?.(
        toolCall({
          title: "spawn_subagent",
          rawInput: {
            description: "Audit the config loader",
            subagent_type: "explore",
          },
          _meta: { "x.ai/tool": { name: "spawn_subagent", kind: "other" } },
        }),
      ),
    ).toEqual({
      item: {
        type: "delegation",
        childRef: "call-1",
        label: "Audit the config loader",
        background: false,
      },
      presentation: {
        label: { pending: "Running subagent", completed: "Subagent finished" },
        icon: { glyph: "UserRound" },
        title: "Audit the config loader",
        detail: "explore",
      },
    });
  });

  it("leaves every other grok tool to the shared classifier", () => {
    expect(
      GROK_ACP_DIALECT.classifyToolCall?.(
        toolCall({
          title: "run_terminal_command",
          _meta: { "x.ai/tool": { name: "run_terminal_command" } },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("cursor sub-agents", () => {
  it("maps a task tool call to a delegation from its rawInput tool name", () => {
    expect(
      CURSOR_ACP_DIALECT.classifyToolCall?.(
        toolCall({
          title: "Task: Subagent task",
          kind: "other",
          rawInput: { _toolName: "task" },
        }),
      ),
    ).toMatchObject({
      item: { type: "delegation", childRef: "call-1", background: false },
      presentation: { icon: { glyph: "UserRound" } },
    });
  });

  it("acknowledges cursor/task and reports the sub-agent it names", () => {
    expect(
      CURSOR_ACP_DIALECT.handleClientRequest?.("cursor/task", {
        toolCallId: "call-1",
        description: "Read README first line",
        prompt: "Read the file README.md…",
        subagentType: { custom: { unspecified: {} } },
        model: "default",
        agentId: "78d1cd3b-94d2-4c87-82a2-c83fe54712f1",
        durationMs: 4764,
      }),
    ).toEqual({
      result: {},
      delegation: {
        toolCallId: "call-1",
        childRef: "78d1cd3b-94d2-4c87-82a2-c83fe54712f1",
        label: "Read README first line",
        detail: "model default",
      },
    });
  });

  it("still acknowledges a cursor/task it cannot read, and claims nothing else", () => {
    expect(
      CURSOR_ACP_DIALECT.handleClientRequest?.("cursor/task", { nope: true }),
    ).toEqual({ result: {} });
    expect(
      CURSOR_ACP_DIALECT.handleClientRequest?.("cursor/other", {}),
    ).toBeUndefined();
  });
});

describe("grok dialect", () => {
  const identity = (meta: unknown) =>
    GROK_ACP_DIALECT.toolIdentity?.({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      _meta: meta,
    } as Parameters<NonNullable<typeof GROK_ACP_DIALECT.toolIdentity>>[0]);

  it("reads the tool name and kind from x.ai/tool", () => {
    expect(
      identity({
        "x.ai/tool": {
          version: 1,
          name: "run_terminal_command",
          kind: "execute",
          namespace: "grok_build",
        },
      }),
    ).toEqual({ name: "run_terminal_command", kind: "execute" });
  });

  it("ignores a kind outside the ACP vocabulary and a missing _meta", () => {
    expect(
      identity({ "x.ai/tool": { name: "deploy_thing", kind: "deploy" } }),
    ).toEqual({ name: "deploy_thing" });
    expect(identity(undefined)).toBeUndefined();
    expect(identity({ "other.vendor/tool": { name: "x" } })).toBeUndefined();
  });
});
