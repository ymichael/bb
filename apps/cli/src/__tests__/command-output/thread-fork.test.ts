import { describe, expect, it, vi } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  collectLogLines,
  getHelpOutput,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread fork command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("creates an idle source-environment fork by default", async () => {
    const thread = fixtures.makeThread({
      id: "thread-fork-idle",
      originKind: "fork",
      projectId: "proj-1",
      providerId: "codex",
      sourceThreadId: "thread-source",
      status: "starting",
    });
    const post = vi.fn(async () => thread);
    stubServerApi({ "v1.threads.fork.$post": post });

    await runCommand(["thread", "fork", "thread-source"], register);

    expect(post).toHaveBeenCalledWith({
      json: {
        sourceThreadId: "thread-source",
        origin: "cli",
        visibility: "visible",
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread forked: thread-fork-idle",
    );
  });

  it("forwards input, seed, fork point, permissions, visibility, and environment", async () => {
    const thread = fixtures.makeThread({
      id: "thread-fork-input",
      originKind: "fork",
      projectId: "proj-1",
      providerId: "codex",
      sourceThreadId: "thread-source",
      visibility: "hidden",
    });
    const post = vi.fn(async () => thread);
    stubServerApi({ "v1.threads.fork.$post": post });

    await runCommand(
      [
        "thread",
        "fork",
        "thread-source",
        "--prompt",
        "Continue here",
        "--agent-context-seed",
        "Reply anchor",
        "--source-seq-end",
        "42",
        "--permission-mode",
        "accept-edits",
        "--visibility",
        "hidden",
        "--environment",
        "env-fork",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      json: expect.objectContaining({
        sourceThreadId: "thread-source",
        sourceSeqEnd: 42,
        input: [{ type: "text", text: "Continue here", mentions: [] }],
        agentContextSeed: [
          {
            type: "text",
            text: "Reply anchor",
            mentions: [],
            visibility: "agent-only",
          },
        ],
        origin: "cli",
        permissionMode: "accept-edits",
        visibility: "hidden",
        environment: { type: "reuse", environmentId: "env-fork" },
      }),
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Visibility: hidden",
    );
  });

  it("creates a worktree on the source host when no host is explicit", async () => {
    const source = fixtures.makeThread({
      id: "thread-source",
      environmentId: "env-source",
      projectId: "proj-1",
      providerId: "codex",
    });
    const sourceEnvironment = fixtures.makeEnvironment({
      id: "env-source",
      hostId: "host-source",
      projectId: "proj-1",
    });
    const thread = fixtures.makeThread({
      id: "thread-fork-worktree",
      originKind: "fork",
      projectId: "proj-1",
      providerId: "codex",
      sourceThreadId: source.id,
    });
    const post = vi.fn(async () => thread);
    stubServerApi({
      "v1.threads.:id.$get": vi.fn(async () => source),
      "v1.environments.:id.$get": vi.fn(async () => sourceEnvironment),
      "v1.threads.fork.$post": post,
    });

    await runCommand(
      [
        "thread",
        "fork",
        source.id,
        "--new-environment",
        "worktree",
        "--base-branch",
        "origin/release",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        sourceThreadId: source.id,
        origin: "cli",
        visibility: "visible",
        environment: {
          type: "host",
          hostId: "host-source",
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "named", name: "origin/release" },
          },
        },
      },
    });
  });

  it("creates a personal environment on the source host", async () => {
    const source = fixtures.makeThread({
      id: "thread-source",
      environmentId: "env-source",
      projectId: PERSONAL_PROJECT_ID,
      providerId: "codex",
    });
    const sourceEnvironment = fixtures.makeEnvironment({
      id: "env-source",
      hostId: "host-source",
      projectId: PERSONAL_PROJECT_ID,
    });
    const thread = fixtures.makeThread({
      id: "thread-fork-personal",
      originKind: "fork",
      projectId: PERSONAL_PROJECT_ID,
      providerId: "codex",
      sourceThreadId: source.id,
    });
    const post = vi.fn(async () => thread);
    stubServerApi({
      "v1.threads.:id.$get": vi.fn(async () => source),
      "v1.environments.:id.$get": vi.fn(async () => sourceEnvironment),
      "v1.threads.fork.$post": post,
    });

    await runCommand(
      ["thread", "fork", source.id, "--new-environment", "personal"],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      json: {
        sourceThreadId: source.id,
        origin: "cli",
        visibility: "visible",
        environment: {
          type: "host",
          hostId: "host-source",
          workspace: { type: "personal" },
        },
      },
    });
  });

  it("does not offer a host selector", async () => {
    const help = await getHelpOutput(["thread", "fork"], register);

    expect(help).toContain("personal or worktree");
    expect(help).not.toContain("--host");
    expect(help).not.toContain("--machine");
  });
});
