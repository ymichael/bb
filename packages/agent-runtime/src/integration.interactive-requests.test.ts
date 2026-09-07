import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { promptTextInput } from "./test/prompt-input.js";
import { resolveIntegrationBridgeLaunch } from "./test/integration-provider-bridges.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isApprovalPendingInteractionPayload,
  type PendingInteractionApprovalDecision,
  type PendingInteractionApprovalSubject,
  type PendingInteractionCreate,
} from "@bb/domain";
import {
  cleanup,
  createApprovalResolution,
  createTempFileName,
  createTestRuntime,
  createToken,
  expectWriteApprovalRequest,
  getAgentText,
  getStreamedText,
  getThreadText,
  newThreadId,
  resolveRuntimeOptions,
  waitForInteractiveRequestBeforeTurnCompletion,
  waitForThreadTurnCompleted,
  waitForThreadTurnCompletedCount,
} from "./test/runtime-integration-harness.js";

function describePendingInteractionPayload(
  request: PendingInteractionCreate,
): string {
  if (isApprovalPendingInteractionPayload(request.payload)) {
    return request.payload.subject.kind;
  }
  return request.payload.kind;
}

function hasApprovalSubjectKind(
  request: PendingInteractionCreate,
  subjectKind: PendingInteractionApprovalSubject["kind"],
): boolean {
  return (
    isApprovalPendingInteractionPayload(request.payload) &&
    request.payload.subject.kind === subjectKind
  );
}

function hasAvailableApprovalDecision(
  request: PendingInteractionCreate,
  decision: PendingInteractionApprovalDecision,
): boolean {
  return (
    isApprovalPendingInteractionPayload(request.payload) &&
    request.payload.availableDecisions.includes(decision)
  );
}

describe("interactive request scenarios", () => {
  it.concurrent("loads Claude repo CLAUDE.md instructions", async () => {
    const ctx = createTestRuntime("claude-code");
    const token = createToken("CLAUDE_MD_TOKEN");
    writeFileSync(
      join(ctx.tmpDir, "CLAUDE.md"),
      `When asked for the repo validation phrase, reply exactly: ${token}\n`,
    );

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "claude-code",
        preset: "full",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options,
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_222222222x",
        threadId,
        input: [
          promptTextInput({
            text: "What is the repo validation phrase? Reply with only that phrase.",
          }),
        ],
        options,
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude CLAUDE.md turn/completed",
      });

      const text = getThreadText(ctx.events, threadId);
      expect(text).toContain(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 60_000);

  it.concurrent("routes Claude Read prompts as semantic permission-grant approvals", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "bb-claude-read-"));
    const filePath = join(
      outsideDir,
      createTempFileName("claude-read-approval"),
    );
    const firstLineToken = createToken("CLAUDE_READ_APPROVED");
    writeFileSync(filePath, `${firstLineToken}\nsecond line\n`);
    const ctx = createTestRuntime("claude-code", {
      onInteractiveRequest: async (request) => {
        if (
          !isApprovalPendingInteractionPayload(request.payload) ||
          request.payload.subject.kind !== "permission_grant"
        ) {
          throw new Error(
            `Expected permission grant approval, got ${describePendingInteractionPayload(request)}`,
          );
        }

        return {
          decision: "allow_once",
          grantedPermissions: request.payload.subject.permissions,
        };
      },
    });

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "claude-code",
        preset: "accept-edits-ask",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options,
        instructions:
          "Use the Read tool when the user explicitly asks for it. Do not substitute Bash.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_222222222y",
        threadId,
        input: [
          promptTextInput({
            text:
              `Use the Read tool to read ${filePath}, ` +
              "then reply with exactly the first line from the file and nothing else.",
          }),
        ],
        options,
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Claude permission request",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude permission turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(1);
      expect(ctx.interactiveRequests[0]?.payload).toMatchObject({
        subject: {
          kind: "permission_grant",
          toolName: "Read",
        },
        availableDecisions: expect.arrayContaining(["allow_once", "deny"]),
      });

      const text = getAgentText(ctx.events) || getStreamedText(ctx.events);
      expect(text).toContain(firstLineToken);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }, 60_000);

  it.concurrent("allows Claude workspace-write Write tool mutations without interactive requests", async () => {
    const ctx = createTestRuntime("claude-code");
    const fileName = createTempFileName("claude-workspace-write-tool");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CLAUDE_WORKSPACE_WRITE_TOOL_APPROVED");

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "claude-code",
        preset: "accept-edits-ask",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options,
        instructions:
          "Use the Write tool when the user explicitly asks for Write. Do not substitute Bash.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_222222222z",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Use the Write tool to create exactly this file: ${filePath}. ` +
              `The file content must be exactly ${token} with no trailing newline. ` +
              "Do not use Bash. After the file is written, reply with exactly DONE.",
          }),
        ],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude workspace-write Write turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("allows Claude workspace-write sandboxed Bash workspace writes without interactive requests", async () => {
    const ctx = createTestRuntime("claude-code");
    const fileName = createTempFileName("claude-workspace-write-bash");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CLAUDE_WORKSPACE_BASH_APPROVED");

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "claude-code",
        preset: "accept-edits-ask",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options,
        instructions:
          "Use the Bash tool when the user explicitly asks for Bash. Do not substitute Write.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_2222222232",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Use Bash to run exactly: printf '${token}' > ${fileName}. ` +
              "Do not use the Write tool. After the command finishes, reply with exactly DONE.",
          }),
        ],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude workspace-write sandboxed Bash turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("blocks Claude workspace-write outside-workspace Bash without interactive requests when escalation is deny", async () => {
    const ctx = createTestRuntime("claude-code");
    const outsideDir = mkdtempSync(join(tmpdir(), "bb-claude-outside-"));
    const filePath = join(
      outsideDir,
      createTempFileName("claude-outside-bash-denied"),
    );
    const token = createToken("CLAUDE_WORKSPACE_BASH_DENIED");

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "claude-code",
        preset: "accept-edits-deny",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options,
        instructions:
          "Use the Bash tool when the user explicitly asks for Bash. Do not substitute Write.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_2222222233",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Use Bash to run exactly: printf '${token}' > '${filePath}'. ` +
              "If it is denied or blocked, say DENIED.",
          }),
        ],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude workspace-write outside Bash deny turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      await ctx.runtime.shutdown();
      rmSync(outsideDir, { recursive: true, force: true });
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("allows Codex workspace-write workspace writes without interactive requests", async () => {
    const ctx = createTestRuntime("codex");
    const fileName = createTempFileName("codex-workspace-write");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CODEX_WORKSPACE_WRITE_APPROVED");

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "codex",
        preset: "accept-edits-ask",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options,
        instructions:
          "When the user asks you to run an exact shell command, run that shell command exactly once and then report DONE.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_2222222234",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Run this exact shell command: printf '${token}' > ${fileName}. ` +
              "After the command finishes, reply with exactly DONE.",
          }),
        ],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex workspace-write turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("routes Codex workspace-write outside-workspace writes through onInteractiveRequest", async () => {
    const ctx = createTestRuntime("codex", {
      onInteractiveRequest: createApprovalResolution,
    });
    const outsideDir = mkdtempSync(join(process.cwd(), ".bb-codex-outside-"));
    const filePath = join(
      outsideDir,
      createTempFileName("codex-outside-write"),
    );
    const token = createToken("CODEX_WORKSPACE_WRITE_ESCALATED");

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "codex",
        preset: "accept-edits-ask",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options,
        instructions:
          "When the user asks you to run an exact shell command, run that shell command exactly once. If approval is needed, request approval; it will be approved. Then report DONE.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_2222222235",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Run this exact shell command: printf '${token}' > '${filePath}'. ` +
              "If approval is needed, request approval. If it is denied or blocked, report the exact error. Otherwise reply DONE.",
          }),
        ],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Codex workspace-write outside-workspace approval",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex workspace-write outside-workspace turn/completed",
      });

      expectWriteApprovalRequest(ctx.interactiveRequests);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      rmSync(outsideDir, { recursive: true, force: true });
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("allows Codex automatic review to approve workspace writes without user interaction", async () => {
    const ctx = createTestRuntime("codex");
    const fileName = createTempFileName("codex-auto-write");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CODEX_AUTO_APPROVED");

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "codex",
        preset: "auto-deny",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options,
        instructions:
          "When the user asks you to run an exact shell command, run that shell command exactly once. Then report DONE.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_2222222236",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Run this exact shell command: printf '${token}' > ${fileName}. ` +
              "After the command finishes, reply with exactly DONE.",
          }),
        ],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex automatic review turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("routes Codex outside-workspace file edits through semantic approvals", async () => {
    const ctx = createTestRuntime("codex", {
      onInteractiveRequest: createApprovalResolution,
    });
    const outsideDir = mkdtempSync(
      join(process.cwd(), ".bb-codex-file-change-"),
    );
    const fileName = createTempFileName("codex-outside-file-change");
    const filePath = join(outsideDir, fileName);
    const token = createToken("CODEX_FILE_CHANGE_APPROVED");

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "codex",
        preset: "accept-edits-ask",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options,
        instructions:
          "When the user asks you to edit a file, use your file editing capability. Do not run shell commands for file edits. If approval is needed, request approval; it will be approved.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_2222222237",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Create exactly this file outside the current workspace: ${filePath}. ` +
              `The file content must be exactly ${token} with no trailing newline. ` +
              "Do not run shell commands. After the file is written, reply with exactly DONE.",
          }),
        ],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Codex outside-workspace file-change approval",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex outside-workspace file-change turn/completed",
      });

      const editApproval = ctx.interactiveRequests.find(
        (request) =>
          (hasApprovalSubjectKind(request, "file_change") ||
            hasApprovalSubjectKind(request, "command")) &&
          hasAvailableApprovalDecision(request, "allow_once"),
      );
      expect(
        editApproval,
        `Expected a Codex edit approval; got ${JSON.stringify(
          ctx.interactiveRequests.map((request) => request.payload),
        )}`,
      ).toBeDefined();
      if (
        !editApproval ||
        !isApprovalPendingInteractionPayload(editApproval.payload)
      ) {
        throw new Error("Expected a semantic edit approval");
      }
      const subject = editApproval.payload.subject;
      expect(subject.itemId).toEqual(expect.any(String));
      expect(editApproval.payload.availableDecisions).toContain("allow_once");
      if (subject.kind === "file_change") {
        expect(subject.writeScope).not.toBeUndefined();
        expect(subject.sessionGrant).not.toBeUndefined();
        expect(Object.keys(subject).sort()).toEqual([
          "itemId",
          "kind",
          "sessionGrant",
          "writeScope",
        ]);
      } else if (subject.kind === "command") {
        expect(subject.command).toEqual(expect.any(String));
        expect(subject.sessionGrant).toBeNull();
      } else {
        throw new Error("Unexpected edit approval kind");
      }
      expect(readFileSync(filePath, "utf8").trimEnd()).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      rmSync(outsideDir, { recursive: true, force: true });
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("respects user-denied Codex outside-workspace command approvals", async () => {
    const ctx = createTestRuntime("codex", {
      onInteractiveRequest: async (request) => {
        if (
          !isApprovalPendingInteractionPayload(request.payload) ||
          request.payload.subject.kind !== "command"
        ) {
          throw new Error(
            `Expected command approval, got ${describePendingInteractionPayload(request)}`,
          );
        }
        if (!request.payload.availableDecisions.includes("deny")) {
          throw new Error("Codex command approval did not offer deny");
        }
        return {
          decision: "deny",
        };
      },
    });
    const outsideDir = mkdtempSync(
      join(process.cwd(), ".bb-codex-user-denied-"),
    );
    const fileName = createTempFileName("codex-user-denied");
    const filePath = join(outsideDir, fileName);
    const token = createToken("CODEX_OUTSIDE_USER_DENIED");

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "codex",
        preset: "accept-edits-ask",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "codex",
        options,
        instructions:
          "When the user asks you to run an exact shell command, run that shell command exactly once. If approval is denied, say DENIED.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_2222222238",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Run this exact shell command: printf '${token}' > ${filePath}. ` +
              "If approval is denied, reply with exactly DENIED.",
          }),
        ],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Codex outside-workspace user-denied command approval",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Codex user-denied turn/completed",
      });

      expect(
        ctx.interactiveRequests.some((request) =>
          hasApprovalSubjectKind(request, "command"),
        ),
      ).toBe(true);
      expect(
        ctx.events.filter(
          (event) =>
            event.threadId === threadId &&
            event.type === "item/completed" &&
            event.item.type === "commandExecution" &&
            event.item.approvalStatus === "denied",
        ),
      ).toHaveLength(1);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      await ctx.runtime.shutdown();
      rmSync(outsideDir, { recursive: true, force: true });
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("routes Claude outside-workspace Bash mutations through user approval", async () => {
    const ctx = createTestRuntime("claude-code", {
      onInteractiveRequest: createApprovalResolution,
    });
    const outsideDir = mkdtempSync(join(process.cwd(), ".bb-claude-bash-"));
    const fileName = "note.txt";
    const filePath = join(outsideDir, fileName);
    const token = "sample text";

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "claude-code",
        preset: "accept-edits-ask",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options,
        instructions:
          "Use the Bash tool when the user explicitly asks for Bash. Do not use another tool.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_222222223b",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Use Bash to run exactly: printf '${token}' > ${filePath}. ` +
              "After the command finishes, reply with exactly DONE.",
          }),
        ],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Claude outside-workspace Bash permission request",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude outside-workspace Bash turn/completed",
      });

      const commandApproval = ctx.interactiveRequests.find(
        (request) =>
          hasApprovalSubjectKind(request, "command") &&
          hasAvailableApprovalDecision(request, "allow_once") &&
          hasAvailableApprovalDecision(request, "deny"),
      );
      expect(commandApproval).toBeDefined();
      if (
        !commandApproval ||
        !isApprovalPendingInteractionPayload(commandApproval.payload) ||
        commandApproval.payload.subject.kind !== "command"
      ) {
        throw new Error("Expected a semantic command approval");
      }
      expect(commandApproval.payload.subject.actions).toContainEqual({
        type: "unknown",
        command: expect.stringContaining("printf"),
      });
      expect(commandApproval.payload.subject.command).toContain("printf");
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      rmSync(outsideDir, { recursive: true, force: true });
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("routes Claude outside-workspace Write mutations through user approval", async () => {
    const ctx = createTestRuntime("claude-code", {
      onInteractiveRequest: createApprovalResolution,
    });
    const outsideDir = mkdtempSync(join(process.cwd(), ".bb-claude-write-"));
    const fileName = createTempFileName("claude-write-tool");
    const filePath = join(outsideDir, fileName);
    const token = createToken("CLAUDE_OUTSIDE_WRITE_TOOL_APPROVED");

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "claude-code",
        preset: "accept-edits-ask",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options,
        instructions:
          "Use the Write tool when the user explicitly asks for Write. Do not substitute Bash.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_222222223c",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Use the Write tool to create exactly this file: ${filePath}. ` +
              `The file content must be exactly ${token} with no trailing newline. ` +
              "Do not use Bash. After the file is written, reply with exactly DONE.",
          }),
        ],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Claude outside-workspace Write permission request",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude outside-workspace Write turn/completed",
      });

      const fileChangeApproval = ctx.interactiveRequests.find(
        (request) =>
          hasApprovalSubjectKind(request, "file_change") &&
          hasAvailableApprovalDecision(request, "allow_once") &&
          hasAvailableApprovalDecision(request, "deny"),
      );
      expect(fileChangeApproval).toBeDefined();
      if (
        !fileChangeApproval ||
        !isApprovalPendingInteractionPayload(fileChangeApproval.payload) ||
        fileChangeApproval.payload.subject.kind !== "file_change"
      ) {
        throw new Error("Expected a semantic file-change approval");
      }
      expect(fileChangeApproval.payload.subject.sessionGrant).toEqual({
        network: null,
        fileSystem: {
          read: [],
          write: expect.arrayContaining([outsideDir]),
        },
      });
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      rmSync(outsideDir, { recursive: true, force: true });
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("applies Claude allow_for_session approvals to later WebFetch calls in the same session", async () => {
    const ctx = createTestRuntime("claude-code", {
      onInteractiveRequest: createApprovalResolution,
    });
    const fetchUrl = "https://example.com";

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "claude-code",
        preset: "accept-edits-ask",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options,
        instructions:
          "Use the WebFetch tool when the user explicitly asks for WebFetch. Do not substitute Bash or any other tool.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_222222223d",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Use WebFetch to fetch ${fetchUrl}. ` +
              "After the fetch finishes, reply with exactly FIRST_DONE.",
          }),
        ],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Claude session WebFetch approval",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude session first WebFetch turn/completed",
      });

      const firstRequestCount = ctx.interactiveRequests.length;
      expect(
        ctx.interactiveRequests.some((request) => {
          if (
            !isApprovalPendingInteractionPayload(request.payload) ||
            request.payload.subject.kind !== "permission_grant"
          ) {
            return false;
          }
          return (
            request.payload.subject.toolName === "WebFetch" &&
            request.payload.availableDecisions.includes("allow_for_session")
          );
        }),
        `Expected a session-capable WebFetch permission approval; got ${JSON.stringify(
          ctx.interactiveRequests.map((request) => request.payload),
        )}`,
      ).toBe(true);

      await ctx.runtime.runTurn({
        clientRequestId: "creq_222222223e",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Use WebFetch to fetch ${fetchUrl} again. ` +
              "After the fetch finishes, reply with exactly SECOND_DONE.",
          }),
        ],
      });

      await waitForThreadTurnCompletedCount({
        ctx,
        threadId,
        count: 2,
        timeoutMs: 45_000,
        label: "Claude session second WebFetch turn/completed",
      });

      expect(
        ctx.interactiveRequests,
        `Expected no new WebFetch approvals; got ${JSON.stringify(
          ctx.interactiveRequests.map((request) => request.payload),
        )}`,
      ).toHaveLength(firstRequestCount);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 90_000);

  it.concurrent("respects user-denied Claude outside-workspace Write approvals", async () => {
    const ctx = createTestRuntime("claude-code", {
      onInteractiveRequest: async (request) => {
        return {
          decision: "deny",
        };
      },
    });
    const outsideDir = mkdtempSync(join(process.cwd(), ".bb-claude-denied-"));
    const fileName = createTempFileName("claude-user-denied");
    const filePath = join(outsideDir, fileName);
    const token = createToken("CLAUDE_OUTSIDE_USER_DENIED");

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "claude-code",
        preset: "accept-edits-ask",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options,
        instructions:
          "Use the Write tool when the user explicitly asks for Write. Do not substitute Bash or another tool.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_222222223f",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              "This is a local integration test in an empty temporary workspace. " +
              `Use Write to create exactly this file: ${filePath}. ` +
              `Its content must be exactly ${token}. Do not use Bash. ` +
              "If approval is denied by the harness, reply with exactly DENIED.",
          }),
        ],
      });

      await waitForInteractiveRequestBeforeTurnCompletion({
        ctx,
        threadId,
        count: 1,
        timeoutMs: 45_000,
        label: "Claude user-denied Write approval",
      });
      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude user-denied turn/completed",
      });

      expect(
        ctx.interactiveRequests.some((request) =>
          hasApprovalSubjectKind(request, "file_change"),
        ),
      ).toBe(true);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      await ctx.runtime.shutdown();
      rmSync(outsideDir, { recursive: true, force: true });
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("allows Claude automatic review to approve workspace writes without user interaction", async () => {
    const ctx = createTestRuntime("claude-code");
    const fileName = createTempFileName("claude-auto-write");
    const filePath = join(ctx.tmpDir, fileName);
    const token = createToken("CLAUDE_AUTO_APPROVED");

    try {
      const threadId = newThreadId();
      const options = await resolveRuntimeOptions({
        ctx,
        providerId: "claude-code",
        preset: "auto-deny",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId: "claude-code",
        options,
        instructions:
          "Use the Bash tool when the user explicitly asks for Bash. Do not use another tool.",
      });

      await ctx.runtime.runTurn({
        clientRequestId: "creq_222222223g",
        threadId,
        options,
        input: [
          promptTextInput({
            text:
              `Use Bash to run exactly: printf '${token}' > ${fileName}. ` +
              "If it is denied, say DENIED.",
          }),
        ],
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 45_000,
        label: "Claude automatic review turn/completed",
      });

      expect(ctx.interactiveRequests).toHaveLength(0);
      expect(readFileSync(filePath, "utf8")).toBe(token);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 75_000);

  it.concurrent("keeps Pi limited to full permission mode", () => {
    expect(
      resolveIntegrationBridgeLaunch("pi").capabilities.permissionModes,
    ).toEqual(["full"]);
  });
});
