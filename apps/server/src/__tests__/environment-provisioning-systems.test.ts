import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EnvironmentRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
} from "@bb/db";
import { resolveProvisioningSelection } from "../environment-provisioning-systems.js";
import { EnvironmentFactory } from "../env-factory.js";
import {
  createTestDb,
  createTestProject,
  createTestRepos,
  createTestThread,
} from "./test-factories.js";

interface SqliteClient {
  close(): void;
}

describe("resolveProvisioningSelection", () => {
  let sqlite: SqliteClient;
  let environmentRepo: EnvironmentRepository;
  let attachmentRepo: ThreadEnvironmentAttachmentRepository;
  let threadRepo: ThreadRepository;
  let project: ReturnType<typeof createTestProject>;

  beforeEach(() => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    const repos = createTestRepos(testDb.db);
    environmentRepo = repos.environmentRepo;
    attachmentRepo = repos.attachmentRepo;
    threadRepo = repos.threadRepo;
    project = createTestProject(repos.projectRepo, {
      rootPath: "/tmp/provisioning-project",
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  it("does not reuse a managed placeholder environment for direct-path project-root threads", () => {
    const factory = new EnvironmentFactory(environmentRepo, attachmentRepo);
    const managedThread = createTestThread(threadRepo, project.id);
    const directThread = createTestThread(threadRepo, project.id);

    const managedEnvironmentId = factory.reserveThreadEnvironment({
      threadId: managedThread.id,
      projectId: project.id,
      projectRootPath: project.rootPath,
      environmentCreationArgs: {
        kind: "worktree",
      },
    });

    const selection = resolveProvisioningSelection({
      projectId: project.id,
      projectRootPath: project.rootPath,
      environmentDescriptor: {
        type: "path",
        path: project.rootPath,
      },
      environmentRepo,
      threadEnvironmentAttachmentRepo: attachmentRepo,
      normalizeRuntimeKind: (value?: string) => value?.trim() || "local",
    });

    expect(managedEnvironmentId).toBeDefined();
    expect(selection.attachedEnvironmentId).toBeDefined();
    expect(selection.attachedEnvironmentId).not.toBe(managedEnvironmentId);
    expect(selection.managed).toBe(false);
    expect(selection.provisioningSystemKind).toBe("direct-path");
    expect(environmentRepo.getById(managedEnvironmentId!)).toMatchObject({
      id: managedEnvironmentId,
      managed: true,
    });
    expect(environmentRepo.getById(managedEnvironmentId!)?.descriptor).toBeUndefined();
    expect(environmentRepo.getById(selection.attachedEnvironmentId!)).toMatchObject({
      id: selection.attachedEnvironmentId,
      managed: false,
      descriptor: {
        type: "path",
        path: project.rootPath,
      },
      properties: {
        provisioningSystemKind: "direct-path",
        location: "localhost",
        workspaceKind: "primary_checkout",
      },
    });
    expect(attachmentRepo.getByThreadId(managedThread.id)?.environmentId).toBe(managedEnvironmentId);
    expect(attachmentRepo.getByThreadId(directThread.id)).toBeUndefined();
  });
});
