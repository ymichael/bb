import { vi } from "vitest";
import type { Thread, Project } from "@bb/core";
import {
  createConnection,
  migrate,
  ProjectRepository,
  ThreadRepository,
  EventRepository,
  EnvironmentRepository,
  ThreadEnvironmentAttachmentRepository,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import type { LlmCompletionService } from "@bb/provider-adapters";

interface SqliteClient {
  close(): void;
}

export function createTestDb(): { db: DbConnection; sqlite: SqliteClient } {
  const db = createConnection(":memory:");
  migrate(db);
  const sqlite = (db as unknown as { $client: SqliteClient }).$client;
  return { db, sqlite };
}

export function createTestRepos(db: DbConnection) {
  return {
    threadRepo: new ThreadRepository(db),
    eventRepo: new EventRepository(db),
    projectRepo: new ProjectRepository(db),
    environmentRepo: new EnvironmentRepository(db),
    attachmentRepo: new ThreadEnvironmentAttachmentRepository(db),
  };
}

export function createTestProject(
  projectRepo: ProjectRepository,
  overrides?: Partial<Pick<Project, "name" | "rootPath" | "projectInstructions">>,
): Project {
  return projectRepo.create({
    name: overrides?.name ?? "test-project",
    rootPath: overrides?.rootPath ?? "/tmp/test-project",
    projectInstructions: overrides?.projectInstructions,
  });
}

export function createTestThread(
  threadRepo: ThreadRepository,
  projectId: string,
  overrides?: {
    providerId?: string;
    type?: "standard" | "manager";
    title?: string;
    environmentId?: string;
    parentThreadId?: string;
    status?: Thread["status"];
    archivedAt?: number;
  },
): Thread {
  const thread = threadRepo.create({
    projectId,
    providerId: overrides?.providerId as any,
    type: overrides?.type,
    title: overrides?.title,
    environmentId: overrides?.environmentId,
    parentThreadId: overrides?.parentThreadId,
  });

  const updates: Record<string, unknown> = {};
  if (overrides?.status && overrides.status !== "created") {
    updates.status = overrides.status;
  }
  if (overrides?.archivedAt !== undefined) {
    updates.archivedAt = overrides.archivedAt;
  }

  if (Object.keys(updates).length > 0) {
    return threadRepo.update(thread.id, updates as Partial<Thread>) ?? thread;
  }

  return thread;
}

export function createMockLlmCompletionService(
  overrides?: Partial<LlmCompletionService>,
): LlmCompletionService {
  return {
    displayName: "Mock LLM",
    generateThreadTitle: vi.fn().mockResolvedValue(undefined),
    generateCommitMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function createTestRuntimeEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BB_ENV_DAEMON_BASE_URL: "http://127.0.0.1:4312",
    BB_ENV_DAEMON_AUTH_TOKEN: "test-token",
    ...overrides,
  };
}
