import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CanUseTool,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PermissionEscalation } from "@bb/domain";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

import { buildSessionOptions, handleLine } from "../bridge.js";
import type { ClaudePermissionMode } from "../../interactive-contract.js";
import { listClaudeCodeBridgeModels } from "../model-list.js";
import {
  createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcOutputMessage,
} from "../../../test/bridge-json-rpc-test-helpers.js";

type BridgeSessionOptions = ReturnType<typeof buildSessionOptions>;
type BridgeSessionHooks = NonNullable<BridgeSessionOptions["hooks"]>;
type BridgePreToolUseHooks = NonNullable<BridgeSessionHooks["PreToolUse"]>;
type BridgePreToolUseHook = BridgePreToolUseHooks[number]["hooks"][number];
type SdkResultUsage = Extract<SDKMessage, { type: "result" }>["usage"];

interface ReadonlyBashHookArgs {
  command: string;
  hook: BridgePreToolUseHook;
}

interface AllowedReadonlyBashCase {
  command: string;
  expectedCommand: string;
}

interface DeniedReadonlyBashCase {
  command: string;
}

interface CanUseToolPolicyAllowExpectation {
  behavior: "allow";
  updatedInput: Record<string, unknown>;
}

interface CanUseToolPolicyDenyExpectation {
  behavior: "deny";
  messageIncludes: string;
}

type CanUseToolPolicyExpectation =
  | CanUseToolPolicyAllowExpectation
  | CanUseToolPolicyDenyExpectation;

interface CanUseToolPolicyCase {
  blockedPath?: string;
  decisionReason?: string;
  expected: CanUseToolPolicyExpectation;
  id: string;
  input: Record<string, unknown>;
  name: string;
  permissionEscalation: PermissionEscalation | null;
  permissionMode: ClaudePermissionMode;
  toolName: string;
}

interface ControlledClaudeQuery {
  close: ReturnType<typeof vi.fn>;
  emit(message: SDKMessage): void;
  finish(): void;
  initializationResult: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
}

interface ClaudeQueryCallOptions {
  canUseTool?: CanUseTool;
  resume?: string;
  sessionId?: string;
}

interface ClaudeQueryCall {
  options: ClaudeQueryCallOptions;
  prompt: AsyncIterable<SDKUserMessage>;
}

interface StaleResumeErrorMessageArgs {
  missingSessionId: string;
  sessionId: string;
}

interface SuccessResultMessageArgs {
  result: string;
  sessionId: string;
}

interface TempClaudeExecutable {
  binDir: string;
  executablePath: string;
}

const tempDirs: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isClaudeQueryCall(value: unknown): value is ClaudeQueryCall {
  if (!isRecord(value) || !isRecord(value.options)) {
    return false;
  }
  const { prompt } = value;
  if (
    prompt === null ||
    typeof prompt !== "object" ||
    !(Symbol.asyncIterator in prompt)
  ) {
    return false;
  }
  return (
    value.options.canUseTool === undefined ||
    typeof value.options.canUseTool === "function"
  );
}

function getProviderThreadIdFromResult(
  message: BridgeJsonRpcOutputMessage,
): string {
  if (
    !isRecord(message.result) ||
    typeof message.result.providerThreadId !== "string"
  ) {
    throw new Error("Expected response result with providerThreadId");
  }
  return message.result.providerThreadId;
}

function getLatestQueryOptions(): ClaudeQueryCallOptions {
  return getLatestQueryCall().options;
}

function getLatestQueryCall(): ClaudeQueryCall {
  const latestCall = queryMock.mock.calls.at(-1)?.[0];
  if (!isClaudeQueryCall(latestCall)) {
    throw new Error("Expected Claude SDK query options");
  }
  return latestCall;
}

function bridgeSdkMessageHasResultErrorText(
  output: BridgeJsonRpcOutputMessage,
  expectedErrorText: string,
): boolean {
  if (output.method !== "sdk/message" || !isRecord(output.params)) {
    return false;
  }
  const { message } = output.params;
  if (
    !isRecord(message) ||
    message.type !== "result" ||
    message.is_error !== true
  ) {
    return false;
  }
  if (message.result === expectedErrorText) {
    return true;
  }
  const { errors } = message;
  return (
    Array.isArray(errors) &&
    errors.length === 1 &&
    errors[0] === expectedErrorText
  );
}

function getSdkResultErrorMessages(
  messages: BridgeJsonRpcOutputMessage[],
  expectedErrorText: string,
): BridgeJsonRpcOutputMessage[] {
  return messages.filter((message) =>
    bridgeSdkMessageHasResultErrorText(message, expectedErrorText),
  );
}

function getLastCanUseTool(): CanUseTool {
  const latestCall = queryMock.mock.calls.at(-1)?.[0];
  if (!isClaudeQueryCall(latestCall) || !latestCall.options.canUseTool) {
    throw new Error("Expected Claude SDK query to receive canUseTool");
  }
  return latestCall.options.canUseTool;
}

function invokeReadonlyBashHook(args: ReadonlyBashHookArgs) {
  return args.hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: args.command,
        description: "Permission boundary test",
      },
      tool_use_id: "tool-1",
      session_id: "session-1",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/tmp/worktree",
    },
    "tool-1",
    { signal: new AbortController().signal },
  );
}

function createControlledClaudeQuery(): ControlledClaudeQuery {
  let finishNext: ((result: IteratorResult<SDKMessage>) => void) | undefined;
  const pendingResults: IteratorResult<SDKMessage>[] = [];
  function pushResult(result: IteratorResult<SDKMessage>): void {
    if (finishNext) {
      const resolve = finishNext;
      finishNext = undefined;
      resolve(result);
      return;
    }
    pendingResults.push(result);
  }
  const iterator: AsyncIterator<SDKMessage> = {
    next: () => {
      const result = pendingResults.shift();
      if (result) return Promise.resolve(result);
      return new Promise<IteratorResult<SDKMessage>>((resolve) => {
        finishNext = resolve;
      });
    },
    return: async () => ({ value: undefined, done: true }),
  };
  return {
    close: vi.fn(() => {
      pushResult({ value: undefined, done: true });
    }),
    emit(message: SDKMessage): void {
      pushResult({ value: message, done: false });
    },
    finish() {
      pushResult({ value: undefined, done: true });
    },
    initializationResult: vi.fn(),
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}

async function readNextPromptText(call: ClaudeQueryCall): Promise<string> {
  const result = await call.prompt[Symbol.asyncIterator]().next();
  if (result.done) {
    throw new Error("Expected Claude prompt input");
  }
  const content = result.value.message.content;
  if (typeof content !== "string") {
    throw new Error("Expected Claude prompt text content");
  }
  return content;
}

function createResultUsage(): SdkResultUsage {
  return {
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: "",
    input_tokens: 0,
    iterations: [],
    output_tokens: 0,
    server_tool_use: {
      web_fetch_requests: 0,
      web_search_requests: 0,
    },
    service_tier: "standard",
    speed: "standard",
  };
}

function createStaleResumeErrorMessage(
  args: StaleResumeErrorMessageArgs,
): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: createResultUsage(),
    modelUsage: {},
    permission_denials: [],
    errors: [`No conversation found with session ID: ${args.missingSessionId}`],
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: args.sessionId,
  };
}

function createLegacyStaleResumeResultMessage(
  args: StaleResumeErrorMessageArgs,
): SDKMessage {
  const message = createStaleResumeErrorMessage(args);
  const legacyMessage = {
    ...message,
    errors: [],
    result: `No conversation found with session ID: ${args.missingSessionId}`,
  };
  return legacyMessage;
}

function createSuccessResultMessage(args: SuccessResultMessageArgs): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    result: args.result,
    stop_reason: null,
    total_cost_usd: 0,
    usage: createResultUsage(),
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000002",
    session_id: args.sessionId,
  };
}

function createTempClaudeExecutable(): TempClaudeExecutable {
  const binDir = mkdtempSync(join(tmpdir(), "bb-claude-path-"));
  tempDirs.push(binDir);
  const executablePath = join(binDir, "claude");
  writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
  chmodSync(executablePath, 0o755);
  return { binDir, executablePath };
}

describe("bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({
        account: {},
        models: [
          {
            value: "default",
            displayName: "Default (recommended)",
            description:
              "Opus 4.7 with 1M context [NEW] · Most capable for complex work",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
          },
          {
            value: "claude-haiku-4-5",
            displayName: "Haiku",
            description: "Haiku 4.5",
          },
          {
            value: "claude-sonnet-4-6",
            displayName: "Sonnet",
            description: "Sonnet 4.6 · Best for everyday tasks",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
          {
            value: "claude-sonnet-4-6[1m]",
            displayName: "Sonnet (1M context)",
            description: "Sonnet 4.6 with 1M context · Billed as extra usage",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high"],
          },
        ],
      }),
      close: vi.fn(),
    });
  });

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps manager sessions on a plain string system prompt", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a manager.",
        cwd: "/tmp/worktree",
        instructionMode: "replace",
        permissionEscalation: "ask",
        permissionMode: "default",
      },
      {},
    );

    expect(options.tools).toBeUndefined();
    expect(options.cwd).toBe("/tmp/worktree");
    expect(options.systemPrompt).toBe("You are a manager.");
  });

  it("leaves standard sessions on the default Claude tool preset", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        reasoningLevel: "xhigh",
        permissionEscalation: "ask",
        permissionMode: "default",
      },
      {},
    );

    expect(options.tools).toBeUndefined();
    expect(options.cwd).toBe("/tmp/worktree");
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are a coder.",
    });
    expect(options.effort).toBe("xhigh");
    expect(options.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  it("passes the resolved Claude permission mode through to the session", () => {
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "deny",
        permissionMode: "dontAsk",
      },
      {},
    );

    expect(options.permissionMode).toBe("dontAsk");
  });

  it("uses a Claude executable discovered from PATH for SDK sessions", () => {
    const { binDir, executablePath } = createTempClaudeExecutable();
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
      },
      { PATH: binDir },
    );

    expect(options.pathToClaudeCodeExecutable).toBe(executablePath);
  });

  it("lets an explicit Claude executable override PATH discovery", () => {
    const { executablePath } = createTempClaudeExecutable();
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
      },
      {
        BB_CLAUDE_CODE_EXECUTABLE: executablePath,
        PATH: "/usr/bin",
      },
    );

    expect(options.pathToClaudeCodeExecutable).toBe(executablePath);
  });

  it("trims explicit Claude executable overrides before forwarding", () => {
    const { executablePath } = createTempClaudeExecutable();
    const options = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
      },
      {
        BB_CLAUDE_CODE_EXECUTABLE: `  ${executablePath}  `,
        PATH: "/usr/bin",
      },
    );

    expect(options.pathToClaudeCodeExecutable).toBe(executablePath);
  });

  it("rejects explicit Claude executable overrides that are not executable", () => {
    const binDir = mkdtempSync(join(tmpdir(), "bb-claude-path-"));
    tempDirs.push(binDir);
    const executablePath = join(binDir, "claude");

    expect(() =>
      buildSessionOptions(
        {
          baseInstructions: "You are a coder.",
          cwd: "/tmp/worktree",
          instructionMode: "append",
          permissionEscalation: "ask",
          permissionMode: "default",
        },
        {
          BB_CLAUDE_CODE_EXECUTABLE: executablePath,
          PATH: "/usr/bin",
        },
      ),
    ).toThrow("BB_CLAUDE_CODE_EXECUTABLE must point to an executable");
  });

  it("configures workspace-write sessions with Claude sandbox settings", () => {
    const askOptions = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "acceptEdits",
      },
      {},
    );
    const denyOptions = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "deny",
        permissionMode: "acceptEdits",
      },
      {},
    );

    expect(askOptions.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
    });
    expect(denyOptions.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
    });
  });

  it("configures workspace-write sessions with additional writable roots", () => {
    const options = buildSessionOptions(
      {
        additionalWorkspaceWriteRoots: [
          "/repo/.git/worktrees/bb13",
          "/repo/.git/objects",
        ],
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "deny",
        permissionMode: "acceptEdits",
      },
      {},
    );

    expect(options.additionalDirectories).toEqual([
      "/repo/.git/worktrees/bb13",
      "/repo/.git/objects",
    ]);
    expect(options.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: ["/repo/.git/worktrees/bb13", "/repo/.git/objects"],
      },
    });
  });

  it("configures readonly sessions with PreToolUse policy hooks", async () => {
    const askOptions = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
      },
      {},
    );
    const denyOptions = buildSessionOptions(
      {
        baseInstructions: "You are a coder.",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "deny",
        permissionMode: "dontAsk",
      },
      {},
    );

    const askHook = askOptions.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!askHook) {
      throw new Error("Expected readonly ask PreToolUse hook");
    }
    const allowedReadonlyBashCases = [
      { command: "pwd", expectedCommand: "pwd" },
      { command: "pwd -P", expectedCommand: "pwd -P" },
      { command: "pwd -L", expectedCommand: "pwd -L" },
      {
        command: "git status --short",
        expectedCommand: "git --no-optional-locks status --short",
      },
      {
        command: "git --no-optional-locks status --short",
        expectedCommand: "git --no-optional-locks status --short",
      },
      {
        command: "git --no-pager status --short",
        expectedCommand: "git --no-optional-locks --no-pager status --short",
      },
      {
        command: "git diff --stat main...HEAD",
        expectedCommand:
          "git --no-optional-locks diff --no-ext-diff --no-textconv --stat main...HEAD",
      },
      {
        command: "git diff -U3 -- package.json",
        expectedCommand:
          "git --no-optional-locks diff --no-ext-diff --no-textconv -U3 -- package.json",
      },
      {
        command: "git diff -- file.txt",
        expectedCommand:
          "git --no-optional-locks diff --no-ext-diff --no-textconv -- file.txt",
      },
      {
        command: "git diff -- --no-ext-diff --no-textconv package.json",
        expectedCommand:
          "git --no-optional-locks diff --no-ext-diff --no-textconv -- --no-ext-diff --no-textconv package.json",
      },
      {
        command: "git show --stat --oneline -1 HEAD",
        expectedCommand:
          "git --no-optional-locks show --no-ext-diff --no-textconv --stat --oneline -1 HEAD",
      },
      {
        command: "git show HEAD -- --no-ext-diff --no-textconv package.json",
        expectedCommand:
          "git --no-optional-locks show --no-ext-diff --no-textconv HEAD -- --no-ext-diff --no-textconv package.json",
      },
      {
        command: "git merge-base main HEAD",
        expectedCommand: "git --no-optional-locks merge-base main HEAD",
      },
      {
        command: "git log --oneline --max-count=1",
        expectedCommand:
          "git --no-optional-locks log --no-ext-diff --no-textconv --oneline --max-count=1",
      },
      {
        command: "git log -- --no-ext-diff --no-textconv package.json",
        expectedCommand:
          "git --no-optional-locks log --no-ext-diff --no-textconv -- --no-ext-diff --no-textconv package.json",
      },
      {
        command: "git branch --show-current",
        expectedCommand: "git --no-optional-locks branch --show-current",
      },
      {
        command: "git branch --list bb/probe",
        expectedCommand: "git --no-optional-locks branch --list bb/probe",
      },
      {
        command: "git branch --merged main",
        expectedCommand: "git --no-optional-locks branch --merged main",
      },
      {
        command: "git ls-files --modified -- package.json",
        expectedCommand:
          "git --no-optional-locks ls-files --modified -- package.json",
      },
      {
        command: "git rev-parse --show-toplevel",
        expectedCommand: "git --no-optional-locks rev-parse --show-toplevel",
      },
      {
        command: "git grep -n TODO -- package.json",
        expectedCommand: "git --no-optional-locks grep -n TODO -- package.json",
      },
      {
        command: "git blame -L1,5 package.json",
        expectedCommand: "git --no-optional-locks blame -L1,5 package.json",
      },
    ] satisfies AllowedReadonlyBashCase[];
    for (const testCase of allowedReadonlyBashCases) {
      await expect(
        invokeReadonlyBashHook({
          command: testCase.command,
          hook: askHook,
        }),
      ).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: {
            command: testCase.expectedCommand,
            description: "Permission boundary test",
          },
        },
      });
    }

    const deniedReadonlyBashCases = [
      { command: "git add package.json" },
      { command: "git reset -- package.json" },
      { command: "git commit -m probe" },
      { command: "git checkout main" },
      { command: "git switch main" },
      { command: "git restore package.json" },
      { command: "git clean -fd" },
      { command: "git apply patch.diff" },
      { command: "git update-index --refresh" },
      { command: "git stash" },
      { command: "git fetch origin" },
      { command: "git pull" },
      { command: "git push" },
      { command: "git branch bb-probe" },
      { command: "git branch --merged main extra" },
      { command: "git -c core.pager=cat status --short" },
      { command: "git -C /tmp status" },
      { command: "git --git-dir=/tmp/repo status" },
      { command: "git diff -- ../etc/passwd" },
      { command: "git diff -- /etc/passwd" },
      { command: "git diff --textconv -- file.txt" },
      { command: "git show --ext-diff HEAD" },
      { command: "git grep -n TODO -- /etc/passwd" },
      { command: "git blame /etc/passwd" },
      { command: "GIT_DIR=/tmp/repo git status" },
      { command: "VAR=1 git diff --stat" },
      { command: "env FOO=bar git status" },
      { command: "git status --short; cat /tmp/secret" },
      { command: "git status --short && cat /tmp/secret" },
      { command: "git status --short | cat" },
      { command: "git status --short > /tmp/out" },
      { command: "git status --short $(cat /tmp/secret)" },
      { command: "git status --short `cat /tmp/secret`" },
      { command: "git blame --contents /tmp/secret package.json" },
      { command: "git blame --contents=/tmp/secret package.json" },
      { command: "git grep -f /tmp/pattern TODO" },
      { command: "git log --output=/tmp/log" },
      { command: "git show --output=/tmp/out HEAD" },
      { command: "pwd package.json" },
    ] satisfies DeniedReadonlyBashCase[];
    for (const testCase of deniedReadonlyBashCases) {
      await expect(
        invokeReadonlyBashHook({
          command: testCase.command,
          hook: askHook,
        }),
      ).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
        },
      });
    }

    await expect(
      askHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: {},
          tool_use_id: "tool-1",
          session_id: "session-1",
          transcript_path: "/tmp/transcript.jsonl",
          cwd: "/tmp/worktree",
        },
        "tool-1",
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ continue: true });

    const preToolUseHook = denyOptions.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!preToolUseHook) {
      throw new Error("Expected readonly PreToolUse hook");
    }
    await expect(
      preToolUseHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: {
            command: "git reset -- package.json",
          },
          tool_use_id: "tool-1",
          session_id: "session-1",
          transcript_path: "/tmp/transcript.jsonl",
          cwd: "/tmp/worktree",
        },
        "tool-1",
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  });

  describe("readonly Bash canUseTool policy", () => {
    const policyCases = [
      {
        id: "default-status-rewrite",
        name: "default readonly rewrites safe Git status",
        permissionMode: "default",
        permissionEscalation: "ask",
        toolName: "Bash",
        decisionReason: "This command requires approval",
        input: {
          command: "git status --short",
          description: "Permission boundary test",
        },
        expected: {
          behavior: "allow",
          updatedInput: {
            command: "git --no-optional-locks status --short",
            description: "Permission boundary test",
          },
        },
      },
      {
        id: "dontask-status-allow",
        name: "dontAsk readonly allows safe Git status",
        permissionMode: "dontAsk",
        permissionEscalation: "deny",
        toolName: "Bash",
        decisionReason: "This command requires approval",
        input: {
          command: "git --no-optional-locks status --short",
          description: "Permission boundary test",
        },
        expected: {
          behavior: "allow",
          updatedInput: {
            command: "git --no-optional-locks status --short",
            description: "Permission boundary test",
          },
        },
      },
      {
        id: "dontask-mutating-bash-deny",
        name: "dontAsk readonly denies mutating Bash",
        permissionMode: "dontAsk",
        permissionEscalation: "deny",
        toolName: "Bash",
        blockedPath: "/tmp/project/package.json",
        input: {
          command: "git add package.json",
          description: "Permission boundary test",
        },
        expected: {
          behavior: "deny",
          messageIncludes: "bb readonly mode allows reading and analysis only",
        },
      },
      {
        id: "dontask-read-deny",
        name: "dontAsk readonly does not auto-allow non-Bash tools",
        permissionMode: "dontAsk",
        permissionEscalation: "deny",
        toolName: "Read",
        blockedPath: "/tmp/project/package.json",
        input: { file_path: "/tmp/project/package.json" },
        expected: {
          behavior: "deny",
          messageIncludes: "bb readonly mode allows reading and analysis only",
        },
      },
      {
        id: "workspace-write-deny",
        name: "workspace-write does not use readonly Bash auto-allow",
        permissionMode: "acceptEdits",
        permissionEscalation: "deny",
        toolName: "Bash",
        blockedPath: "/tmp/project",
        input: {
          command: "git status --short",
          description: "Permission boundary test",
        },
        expected: {
          behavior: "deny",
          messageIncludes: "bb workspace-write mode allows work inside",
        },
      },
      {
        id: "full-bypass-allow",
        name: "full bypass does not rewrite via readonly Bash auto-allow",
        permissionMode: "bypassPermissions",
        permissionEscalation: null,
        toolName: "Bash",
        decisionReason: "This command requires approval",
        input: {
          command: "git status --short",
          description: "Permission boundary test",
        },
        expected: {
          behavior: "allow",
          updatedInput: {
            command: "git status --short",
            description: "Permission boundary test",
          },
        },
      },
    ] satisfies CanUseToolPolicyCase[];

    it.each(policyCases)("$name", async (testCase) => {
      const bridge = createBridgeJsonRpcTestHarness(handleLine);
      const queries: ControlledClaudeQuery[] = [];
      queryMock.mockImplementation(() => {
        const query = createControlledClaudeQuery();
        queries.push(query);
        return query;
      });

      try {
        const startRequestId = 1;
        const stopRequestId = startRequestId + 1;
        const threadId = `thread-readonly-bash-policy-${testCase.id}`;
        const toolUseID = `tool-readonly-policy-${testCase.id}`;
        bridge.sendRequest(startRequestId, "thread/start", {
          baseInstructions: "test",
          cwd: "/tmp/worktree",
          instructionMode: "append",
          permissionEscalation: testCase.permissionEscalation,
          permissionMode: testCase.permissionMode,
          threadId,
        });
        await bridge.waitForResponse(startRequestId);

        const canUseTool = getLastCanUseTool();
        const result = await canUseTool(testCase.toolName, testCase.input, {
          blockedPath: testCase.blockedPath,
          decisionReason: testCase.decisionReason,
          signal: new AbortController().signal,
          toolUseID,
        });

        switch (testCase.expected.behavior) {
          case "allow":
            expect(result).toMatchObject({
              behavior: "allow",
              toolUseID,
              updatedInput: testCase.expected.updatedInput,
            });
            expect("decisionClassification" in result).toBe(false);
            break;
          case "deny":
            if (result.behavior !== "deny") {
              throw new Error(`Expected ${testCase.name} to deny`);
            }
            expect(result.toolUseID).toBe(toolUseID);
            expect(result.message).toContain(testCase.expected.messageIncludes);
            break;
        }

        bridge.sendRequest(stopRequestId, "thread/stop", {
          threadId,
        });
        await bridge.flushWork();
        queries[0]?.finish();
        await bridge.waitForResponse(stopRequestId);
      } finally {
        bridge.restore();
      }
    });
  });

  it("returns the bridge-owned Claude model list from the SDK probe", async () => {
    const { models, selectedOnlyModels } = await listClaudeCodeBridgeModels();
    expect(models).toEqual([
      expect.objectContaining({
        id: "claude-opus-4-7[1m]",
        model: "claude-opus-4-7[1m]",
        displayName: "Opus 4.7 (1M)",
        isDefault: true,
      }),
      expect.objectContaining({
        id: "claude-opus-4-7",
        model: "claude-opus-4-7",
        displayName: "Opus 4.7",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "claude-opus-4-6[1m]",
        model: "claude-opus-4-6[1m]",
        displayName: "Opus 4.6 (1M)",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "claude-opus-4-6",
        model: "claude-opus-4-6",
        displayName: "Opus 4.6",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "claude-sonnet-4-6[1m]",
        model: "claude-sonnet-4-6[1m]",
        displayName: "Sonnet 4.6 (1M)",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "claude-sonnet-4-6",
        model: "claude-sonnet-4-6",
        displayName: "Sonnet 4.6",
        isDefault: false,
      }),
      expect.objectContaining({
        id: "claude-haiku-4-5",
        model: "claude-haiku-4-5",
        displayName: "Haiku 4.5",
        isDefault: false,
      }),
    ]);
    expect(selectedOnlyModels.map((model) => model.model)).toEqual([
      "opus[1m]",
      "opus",
      "sonnet[1m]",
      "sonnet",
      "haiku",
    ]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("exposes the host HOME and CLAUDE settings cascade to the Claude SDK on thread/start", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/test-bb";
    try {
      bridge.sendRequest(1, "thread/start", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        threadId: "thread-home-config",
      });
      await bridge.waitForResponse(1);

      const queryOptions = getLatestQueryOptions() as ClaudeQueryCallOptions & {
        env?: Record<string, string | undefined>;
        settingSources?: string[];
      };
      expect(queryOptions.env?.HOME).toBe("/Users/test-bb");
      expect(queryOptions.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("bb/1.0.0");
      expect(queryOptions.settingSources).toEqual([
        "user",
        "project",
        "local",
      ]);

      bridge.sendRequest(2, "thread/stop", {
        threadId: "thread-home-config",
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(2);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      bridge.restore();
    }
  });

  it("passes thread/start reasoningLevel through to Claude SDK effort and thinking display", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/start", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        reasoningLevel: "xhigh",
        threadId: "thread-reasoning",
      });
      await bridge.waitForResponse(1);

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            effort: "xhigh",
            thinking: {
              type: "adaptive",
              display: "summarized",
            },
          }),
        }),
      );

      bridge.sendRequest(2, "thread/stop", {
        threadId: "thread-reasoning",
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(2);
    } finally {
      bridge.restore();
    }
  });

  it("passes thread/start additional workspace-write roots to Claude SDK options", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/start", {
        additionalWorkspaceWriteRoots: [
          "/repo/.git/worktrees/bb13",
          "/repo/.git/objects",
        ],
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "deny",
        permissionMode: "acceptEdits",
        threadId: "thread-roots",
      });
      await bridge.waitForResponse(1);

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            additionalDirectories: [
              "/repo/.git/worktrees/bb13",
              "/repo/.git/objects",
            ],
            sandbox: expect.objectContaining({
              filesystem: {
                allowWrite: ["/repo/.git/worktrees/bb13", "/repo/.git/objects"],
              },
            }),
          }),
        }),
      );

      bridge.sendRequest(2, "thread/stop", {
        threadId: "thread-roots",
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(2);
    } finally {
      bridge.restore();
    }
  });

  it("passes thread/resume additional workspace-write roots to Claude SDK options", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/resume", {
        additionalWorkspaceWriteRoots: [
          "/repo/.git/worktrees/bb13",
          "/repo/.git/objects",
        ],
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "deny",
        permissionMode: "acceptEdits",
        providerThreadId: "provider-thread-roots",
        threadId: "thread-resume-roots",
      });
      await bridge.waitForResponse(1);

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            additionalDirectories: [
              "/repo/.git/worktrees/bb13",
              "/repo/.git/objects",
            ],
            sandbox: expect.objectContaining({
              filesystem: {
                allowWrite: ["/repo/.git/worktrees/bb13", "/repo/.git/objects"],
              },
            }),
          }),
        }),
      );

      bridge.sendRequest(2, "thread/stop", {
        threadId: "thread-resume-roots",
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(2);
    } finally {
      bridge.restore();
    }
  });

  it("retries a stale Claude resume once with a fresh session", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-stale-resume-recovery";
      const staleProviderThreadId = "stale-provider-thread";
      const staleErrorText = `No conversation found with session ID: ${staleProviderThreadId}`;
      const inputText = "Reply READY";
      bridge.sendRequest(1, "thread/resume", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      const resumeResponse = await bridge.waitForResponse(1);

      expect(getProviderThreadIdFromResult(resumeResponse)).toBe(
        staleProviderThreadId,
      );
      expect(getLatestQueryOptions()).toMatchObject({
        resume: staleProviderThreadId,
      });

      bridge.sendRequest(2, "turn/start", {
        input: [{ type: "text", text: inputText }],
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(2);

      queries[0]?.emit(
        createStaleResumeErrorMessage({
          missingSessionId: staleProviderThreadId,
          sessionId: staleProviderThreadId,
        }),
      );
      await bridge.flushWork();

      expect(queries).toHaveLength(2);
      const replacementOptions = getLatestQueryOptions();
      const replacementProviderThreadId = replacementOptions.sessionId;
      if (!replacementProviderThreadId) {
        throw new Error("Expected fresh Claude session ID");
      }
      expect(replacementProviderThreadId).not.toBe(staleProviderThreadId);
      expect(replacementOptions).not.toHaveProperty("resume");
      expect(
        bridge.messages.some(
          (message) =>
            message.method === "thread/identity" &&
            isRecord(message.params) &&
            message.params.threadId === threadId &&
            message.params.providerThreadId === replacementProviderThreadId,
        ),
      ).toBe(true);
      expect(
        getSdkResultErrorMessages(bridge.messages, staleErrorText),
      ).toHaveLength(0);
      expect(
        bridge.messages.some((message) => message.method === "error"),
      ).toBe(false);
      await expect(readNextPromptText(getLatestQueryCall())).resolves.toBe(
        inputText,
      );

      bridge.sendRequest(3, "thread/stop", {
        threadId,
      });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      bridge.restore();
    }
  });

  it("retries a stale Claude resume from the legacy result text field", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-stale-resume-legacy-result";
      const staleProviderThreadId = "stale-provider-thread-legacy-result";
      const staleErrorText = `No conversation found with session ID: ${staleProviderThreadId}`;
      bridge.sendRequest(1, "thread/resume", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(2, "turn/start", {
        input: [{ type: "text", text: "Reply READY" }],
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(2);

      queries[0]?.emit(
        createLegacyStaleResumeResultMessage({
          missingSessionId: staleProviderThreadId,
          sessionId: staleProviderThreadId,
        }),
      );
      await bridge.flushWork();

      expect(queries).toHaveLength(2);
      expect(
        getSdkResultErrorMessages(bridge.messages, staleErrorText),
      ).toHaveLength(0);

      bridge.sendRequest(3, "thread/stop", {
        threadId,
      });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      bridge.restore();
    }
  });

  it("does not retry non-matching Claude resume errors", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-stale-resume-non-match";
      const staleProviderThreadId = "stale-provider-thread-non-match";
      const differentProviderThreadId = "different-provider-thread";
      const differentErrorText = `No conversation found with session ID: ${differentProviderThreadId}`;
      bridge.sendRequest(1, "thread/resume", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(2, "turn/start", {
        input: [{ type: "text", text: "Reply READY" }],
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(2);

      queries[0]?.emit(
        createStaleResumeErrorMessage({
          missingSessionId: differentProviderThreadId,
          sessionId: staleProviderThreadId,
        }),
      );
      await bridge.flushWork();

      expect(queries).toHaveLength(1);
      expect(
        getSdkResultErrorMessages(bridge.messages, differentErrorText),
      ).toHaveLength(1);

      bridge.sendRequest(3, "thread/stop", {
        threadId,
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      bridge.restore();
    }
  });

  it("does not retry stale errors after the fresh recovery session starts", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-stale-resume-retry-cap";
      const staleProviderThreadId = "stale-provider-thread-retry-cap";
      bridge.sendRequest(1, "thread/resume", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(2, "turn/start", {
        input: [{ type: "text", text: "Reply READY" }],
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(2);

      queries[0]?.emit(
        createStaleResumeErrorMessage({
          missingSessionId: staleProviderThreadId,
          sessionId: staleProviderThreadId,
        }),
      );
      await bridge.flushWork();

      expect(queries).toHaveLength(2);
      const replacementProviderThreadId = getLatestQueryOptions().sessionId;
      if (!replacementProviderThreadId) {
        throw new Error("Expected fresh Claude session ID");
      }
      const replacementErrorText = `No conversation found with session ID: ${replacementProviderThreadId}`;

      queries[1]?.emit(
        createStaleResumeErrorMessage({
          missingSessionId: replacementProviderThreadId,
          sessionId: replacementProviderThreadId,
        }),
      );
      await bridge.flushWork();

      expect(queries).toHaveLength(2);
      expect(
        getSdkResultErrorMessages(bridge.messages, replacementErrorText),
      ).toHaveLength(1);

      bridge.sendRequest(3, "thread/stop", {
        threadId,
      });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      bridge.restore();
    }
  });

  it("clears stale resume recovery state after a non-stale result", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-stale-resume-clears-state";
      const staleProviderThreadId = "stale-provider-thread-clears-state";
      const staleErrorText = `No conversation found with session ID: ${staleProviderThreadId}`;
      bridge.sendRequest(1, "thread/resume", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(2, "turn/start", {
        input: [{ type: "text", text: "Reply READY" }],
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(2);

      queries[0]?.emit(
        createSuccessResultMessage({
          result: "ok",
          sessionId: staleProviderThreadId,
        }),
      );
      await bridge.flushWork();

      queries[0]?.emit(
        createStaleResumeErrorMessage({
          missingSessionId: staleProviderThreadId,
          sessionId: staleProviderThreadId,
        }),
      );
      await bridge.flushWork();

      expect(queries).toHaveLength(1);
      expect(
        getSdkResultErrorMessages(bridge.messages, staleErrorText),
      ).toHaveLength(1);

      bridge.sendRequest(3, "thread/stop", {
        threadId,
      });
      await bridge.flushWork();
      queries[0]?.finish();
      await bridge.waitForResponse(3);
    } finally {
      bridge.restore();
    }
  });

  it("stops the replacement session after stale resume recovery", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      const threadId = "thread-stale-resume-stop-replacement";
      const staleProviderThreadId = "stale-provider-thread-stop-replacement";
      bridge.sendRequest(1, "thread/resume", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(2, "turn/start", {
        input: [{ type: "text", text: "Reply READY" }],
        providerThreadId: staleProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(2);

      queries[0]?.emit(
        createStaleResumeErrorMessage({
          missingSessionId: staleProviderThreadId,
          sessionId: staleProviderThreadId,
        }),
      );
      await bridge.flushWork();

      const replacementProviderThreadId = getLatestQueryOptions().sessionId;
      if (!replacementProviderThreadId) {
        throw new Error("Expected fresh Claude session ID");
      }
      expect(queries).toHaveLength(2);
      expect(queries[0]?.close).toHaveBeenCalledTimes(1);

      bridge.sendRequest(3, "thread/stop", {
        threadId,
      });
      await bridge.flushWork();

      expect(bridge.hasResponse(3)).toBe(false);
      expect(queries[1]?.close).not.toHaveBeenCalled();

      queries[1]?.finish();
      await bridge.waitForResponse(3);

      bridge.sendRequest(4, "thread/resume", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        providerThreadId: replacementProviderThreadId,
        threadId,
      });
      await bridge.waitForResponse(4);

      expect(queries).toHaveLength(3);
      expect(getLatestQueryOptions()).toMatchObject({
        resume: replacementProviderThreadId,
      });

      bridge.sendRequest(5, "thread/stop", {
        threadId,
      });
      await bridge.flushWork();
      queries[2]?.finish();
      await bridge.waitForResponse(5);
    } finally {
      bridge.restore();
    }
  });

  it("holds thread stop open until the Claude SDK stream closes", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(1, "thread/start", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        threadId: "thread-stop-waits",
      });
      await bridge.waitForResponse(1);

      bridge.sendRequest(2, "thread/stop", {
        threadId: "thread-stop-waits",
      });
      await bridge.flushWork();

      expect(bridge.hasResponse(2)).toBe(false);
      expect(queries).toHaveLength(1);
      expect(queries[0]?.close).not.toHaveBeenCalled();

      queries[0]?.finish();
      await expect(bridge.waitForResponse(2)).resolves.toMatchObject({
        id: 2,
        result: { ok: true },
      });
      expect(queries[0]?.close).not.toHaveBeenCalled();
    } finally {
      bridge.restore();
    }
  });

  it("waits for an in-flight close before replacing the same thread", async () => {
    const bridge = createBridgeJsonRpcTestHarness(handleLine);
    const queries: ControlledClaudeQuery[] = [];
    queryMock.mockImplementation(() => {
      const query = createControlledClaudeQuery();
      queries.push(query);
      return query;
    });

    try {
      bridge.sendRequest(11, "thread/start", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        threadId: "thread-overlap",
      });
      await bridge.waitForResponse(11);

      bridge.sendRequest(12, "thread/stop", {
        threadId: "thread-overlap",
      });
      await bridge.flushWork();
      bridge.sendRequest(13, "thread/start", {
        baseInstructions: "test",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        permissionEscalation: "ask",
        permissionMode: "default",
        threadId: "thread-overlap",
      });
      await bridge.flushWork();

      expect(bridge.hasResponse(12)).toBe(false);
      expect(bridge.hasResponse(13)).toBe(false);
      expect(queries).toHaveLength(1);

      queries[0]?.finish();
      await expect(bridge.waitForResponse(12)).resolves.toMatchObject({
        id: 12,
        result: { ok: true },
      });
      await expect(bridge.waitForResponse(13)).resolves.toMatchObject({
        id: 13,
      });
      expect(queries).toHaveLength(2);

      bridge.sendRequest(14, "thread/stop", {
        threadId: "thread-overlap",
      });
      await bridge.flushWork();
      queries[1]?.finish();
      await bridge.waitForResponse(14);
    } finally {
      bridge.restore();
    }
  });
});
