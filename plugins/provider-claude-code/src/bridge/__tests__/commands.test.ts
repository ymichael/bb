import { describe, expect, it } from "vitest";
import { decodeClaudeCodeJsonRpcRequest } from "../commands.js";

const baseThreadStartParams = {
  threadId: "bb-thread-1",
  cwd: "/tmp/worktree",
  instructionMode: "append",
  options: {
    permissionMode: "accept-edits",
    permissionScope: "workspace",
    approvalReviewer: "user",
    permissionEscalation: "ask",
    providerOptions: { workflowsEnabled: false },
  },
};

describe("decodeClaudeCodeJsonRpcRequest", () => {
  it("decodes thread/start and keeps the provider-scoped options bag", () => {
    expect(
      decodeClaudeCodeJsonRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "thread/start",
        params: baseThreadStartParams,
      }),
    ).toMatchObject({
      kind: "request",
      request: {
        method: "thread/start",
        params: { options: { providerOptions: { workflowsEnabled: false } } },
      },
    });
  });

  it("names the missing field on invalid params", () => {
    const { options: _omitted, ...withoutOptions } = baseThreadStartParams;
    expect(
      decodeClaudeCodeJsonRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "thread/start",
        params: withoutOptions,
      }),
    ).toMatchObject({
      kind: "invalid_params",
      id: 1,
      method: "thread/start",
      issues: expect.stringContaining("options"),
    });
    expect(
      decodeClaudeCodeJsonRpcRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "thread/resume",
        params: { ...withoutOptions, providerThreadId: "claude-session-1" },
      }),
    ).toMatchObject({
      kind: "invalid_params",
      id: 2,
      method: "thread/resume",
    });
  });

  it("reports an unknown method separately from invalid params", () => {
    expect(
      decodeClaudeCodeJsonRpcRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "turn/teleport",
        params: {},
      }),
    ).toEqual({ kind: "unknown_method", id: 3, method: "turn/teleport" });
  });

  it("ignores lines that are not requests", () => {
    expect(
      decodeClaudeCodeJsonRpcRequest({ jsonrpc: "2.0", id: 4, result: {} }),
    ).toEqual({ kind: "not_a_request" });
  });
});
