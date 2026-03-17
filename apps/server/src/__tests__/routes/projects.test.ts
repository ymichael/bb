import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import type {
  Project,
  ProjectFileSuggestion,
  Thread,
  UploadedPromptAttachment,
} from "@bb/core";
import { createProjectRoutes } from "../../routes/projects.js";
import type { EventRepository, ProjectRepository, ThreadRepository } from "@bb/db";
import { invalidRequestError } from "../../domain-errors.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "Test Project",
    rootPath: "/test/project",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "proj-1",
    providerId: "codex",
    type: "standard",
    status: "idle",
    createdAt: 1000,
    updatedAt: 1000,
    lastReadAt: 1000,
    ...overrides,
  };
}

function mockProjectRepo(): ProjectRepository {
  return {
    create: vi.fn(),
    update: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  } as unknown as ProjectRepository;
}

function mockThreadRepo(): ThreadRepository {
  return {
    list: vi.fn(),
    delete: vi.fn(),
  } as unknown as ThreadRepository;
}

function mockEventRepo(): EventRepository {
  return {
    deleteByThreadId: vi.fn(),
  } as unknown as EventRepository;
}

describe("Project routes", () => {
  type SearchProjectFilesFn = (
    rootPath: string,
    query: string,
    limit?: number,
  ) => Promise<ProjectFileSuggestion[]>;
  type StorePromptAttachmentFn = (args: {
    projectId: string;
    file: File;
  }) => Promise<UploadedPromptAttachment>;
  type DeleteThreadFn = (threadId: string) => Promise<void>;

  let projectRepo: ReturnType<typeof mockProjectRepo>;
  let findProjectFiles: ReturnType<typeof vi.fn>;
  let savePromptAttachment: ReturnType<typeof vi.fn>;
  let threadRepo: ReturnType<typeof mockThreadRepo>;
  let eventRepo: ReturnType<typeof mockEventRepo>;
  let deleteThreadAsync: ReturnType<typeof vi.fn<DeleteThreadFn>>;
  let app: Hono;
  let bbRoot: string;
  let threadManager: {
    spawn: ReturnType<typeof vi.fn>;
    systemTell: ReturnType<typeof vi.fn>;
    getRawById: ReturnType<typeof vi.fn>;
    listProviders: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
  };
  const originalBbRoot = process.env.BB_ROOT;

  beforeEach(() => {
    bbRoot = mkdtempSync(join(tmpdir(), "bb-project-routes-root-"));
    process.env.BB_ROOT = bbRoot;
    projectRepo = mockProjectRepo();
    threadRepo = mockThreadRepo();
    eventRepo = mockEventRepo();
    deleteThreadAsync = vi.fn<DeleteThreadFn>().mockResolvedValue(undefined);
    threadManager = {
      spawn: vi.fn(),
      systemTell: vi.fn().mockResolvedValue(undefined),
      getRawById: vi.fn(),
      listProviders: vi.fn().mockResolvedValue([]),
      listModels: vi.fn().mockResolvedValue([]),
    };
    findProjectFiles = vi.fn<SearchProjectFilesFn>().mockResolvedValue([]);
    savePromptAttachment = vi.fn<StorePromptAttachmentFn>().mockResolvedValue({
      type: "localImage",
      path: "/Users/test/.bb/attachments/proj-2/image.png",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 12,
    });
    const routes = createProjectRoutes(
      projectRepo,
      findProjectFiles as SearchProjectFilesFn,
      savePromptAttachment as StorePromptAttachmentFn,
      {
        threadRepo: threadRepo,
        eventRepo: eventRepo,
        threadManager: threadManager as never,
        runtimeEnv: process.env,
        deleteThreadAsync,
      },
    );
    app = new Hono().route("/projects", routes);
  });

  afterEach(() => {
    process.env.BB_ROOT = originalBbRoot;
    rmSync(bbRoot, { recursive: true, force: true });
  });

  describe("POST /projects", () => {
    it("creates a project and returns 201", async () => {
      const project = makeProject({ name: "My Project", rootPath: "/my/path" });
      (projectRepo.create as ReturnType<typeof vi.fn>).mockReturnValue(
        project,
      );

      const res = await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "My Project", rootPath: "/my/path" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("proj-1");
      expect(body.name).toBe("My Project");
      expect(body.rootPath).toBe("/my/path");
      expect(projectRepo.create).toHaveBeenCalledWith({
        name: "My Project",
        rootPath: "/my/path",
      });
    });

    it("returns 400 for invalid body (missing name)", async () => {
      const res = await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath: "/test" }),
      });

      expect(res.status).toBe(400);
      expect(projectRepo.create).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid body (missing rootPath)", async () => {
      const res = await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      });

      expect(res.status).toBe(400);
      expect(projectRepo.create).not.toHaveBeenCalled();
    });

    it("returns 500 when projectRepo.create() throws", async () => {
      (projectRepo.create as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw new Error("Unique constraint violated");
        },
      );

      const res = await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Dup", rootPath: "/test" }),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("internal_error");
      expect(body.message).toBe("Unique constraint violated");
    });
  });

  describe("GET /projects", () => {
    it("lists all projects", async () => {
      const projects = [
        makeProject({ id: "p1", name: "Project 1" }),
        makeProject({ id: "p2", name: "Project 2" }),
      ];
      (projectRepo.list as ReturnType<typeof vi.fn>).mockReturnValue(projects);

      const res = await app.request("/projects");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0].id).toBe("p1");
      expect(body[1].id).toBe("p2");
    });

    it("returns empty array when no projects exist", async () => {
      (projectRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const res = await app.request("/projects");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it("returns 500 when projectRepo.list() throws", async () => {
      (projectRepo.list as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB error");
      });

      const res = await app.request("/projects");

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("internal_error");
      expect(body.message).toBe("DB error");
    });
  });

  describe("PATCH /projects/:id", () => {
    it("updates project fields and returns the updated project", async () => {
      const updatedProject = makeProject({
        id: "proj-2",
        name: "Renamed",
        rootPath: "/new/path",
      });
      (projectRepo.update as ReturnType<typeof vi.fn>).mockReturnValue(updatedProject);

      const res = await app.request("/projects/proj-2", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed", rootPath: "/new/path" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("proj-2");
      expect(body.name).toBe("Renamed");
      expect(body.rootPath).toBe("/new/path");
      expect(projectRepo.update).toHaveBeenCalledWith("proj-2", {
        name: "Renamed",
        rootPath: "/new/path",
      });
    });

    it("returns 404 when project does not exist", async () => {
      (projectRepo.update as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const res = await app.request("/projects/unknown", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath: "/tmp/project" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("project_not_found");
      expect(body.message).toBe("Project unknown not found");
    });

    it("returns 400 when body has no updatable fields", async () => {
      const res = await app.request("/projects/proj-2", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      expect(projectRepo.update).not.toHaveBeenCalled();
    });
  });

  describe("POST /projects/:id/manager", () => {
    it("always creates a new manager", async () => {
      const project = makeProject({ id: "proj-1" });
      const managerThread = makeThread({
        id: "thread-manager-1",
        projectId: project.id,
        type: "manager",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      threadManager.spawn.mockResolvedValue(managerThread);
      threadManager.getRawById.mockReturnValue(managerThread);

      const res = await app.request("/projects/proj-1/manager", { method: "POST" });

      expect(res.status).toBe(201);
      expect(threadManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          type: "manager",
          title: "Manager",
          environmentDescriptor: {
            type: "path",
            path: project.rootPath,
          },
          developerInstructions: expect.stringContaining(
            "{{MANAGER_WORKSPACE_PATH}}",
          ),
          input: [{ type: "text", text: "[bb system] Welcome!" }],
        }),
      );
      expect(threadManager.systemTell).not.toHaveBeenCalled();
      expect(existsSync(join(bbRoot, "workspace", "thread-manager-1"))).toBe(true);
    });

    it("prefers claude-code opus for managers when available", async () => {
      const project = makeProject({ id: "proj-1" });
      const managerThread = makeThread({
        id: "thread-manager-claude",
        projectId: project.id,
        type: "manager",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      threadManager.listProviders.mockResolvedValue([
        {
          id: "codex",
          displayName: "Codex",
          capabilities: {},
        },
        {
          id: "claude-code",
          displayName: "Claude Code",
          capabilities: {},
        },
      ]);
      threadManager.listModels.mockResolvedValue([
        {
          id: "claude-sonnet-4-6",
          model: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          description: "Default",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
        {
          id: "claude-opus-4-6",
          model: "claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          description: "Preferred",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: false,
        },
      ]);
      threadManager.spawn.mockResolvedValue(managerThread);
      threadManager.getRawById.mockReturnValue(managerThread);

      const res = await app.request("/projects/proj-1/manager", { method: "POST" });

      expect(res.status).toBe(201);
      expect(threadManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "claude-code",
          model: "claude-opus-4-6",
        }),
      );
    });

    it("falls back to the existing provider resolution when claude-code is unavailable", async () => {
      const project = makeProject({ id: "proj-1" });
      const managerThread = makeThread({
        id: "thread-manager-fallback",
        projectId: project.id,
        type: "manager",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      threadManager.listProviders.mockResolvedValue([
        {
          id: "codex",
          displayName: "Codex",
          capabilities: {},
        },
      ]);
      threadManager.spawn.mockResolvedValue(managerThread);
      threadManager.getRawById.mockReturnValue(managerThread);

      const res = await app.request("/projects/proj-1/manager", { method: "POST" });

      expect(res.status).toBe(201);
      expect(threadManager.spawn).toHaveBeenCalledWith(
        expect.not.objectContaining({
          providerId: expect.anything(),
        }),
      );
      expect(threadManager.listModels).not.toHaveBeenCalled();
    });

    it("passes the optional manager title through to spawn", async () => {
      const project = makeProject({ id: "proj-1" });
      const managerThread = makeThread({
        id: "thread-manager-named",
        projectId: project.id,
        type: "manager",
        title: "Release Manager",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      threadManager.spawn.mockResolvedValue(managerThread);
      threadManager.getRawById.mockReturnValue(managerThread);

      const res = await app.request("/projects/proj-1/manager", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Release Manager" }),
      });

      expect(res.status).toBe(201);
      expect(threadManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Release Manager",
        }),
      );
    });

    it("rolls back workspace when bootstrap fails", async () => {
      const project = makeProject({ id: "proj-1" });
      const managerThread = makeThread({
        id: "thread-manager-rollback",
        projectId: project.id,
        type: "manager",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      threadManager.spawn.mockResolvedValue(managerThread);
      writeFileSync(join(bbRoot, "workspace"), "occupied");

      const res = await app.request("/projects/proj-1/manager", { method: "POST" });

      expect(res.status).toBe(500);
      expect(deleteThreadAsync).toHaveBeenCalledWith("thread-manager-rollback");
      expect(
        existsSync(join(bbRoot, "workspace", "thread-manager-rollback")),
      ).toBe(false);
    });
  });

  describe("DELETE /projects/:id", () => {
    it("removes the project after deleting thread artifacts and attachments", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ id: "proj-2" }),
      );
      (threadRepo.list as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: "thread-1" },
        { id: "thread-2" },
      ]);
      const attachmentsDir = resolve(bbRoot, "attachments", "proj-2");
      mkdirSync(attachmentsDir, { recursive: true });
      writeFileSync(resolve(attachmentsDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const res = await app.request("/projects/proj-2", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(threadRepo.list).toHaveBeenCalledWith({
        projectId: "proj-2",
        includeArchived: true,
      });
      expect(deleteThreadAsync).toHaveBeenCalledWith("thread-1");
      expect(deleteThreadAsync).toHaveBeenCalledWith("thread-2");
      expect(eventRepo.deleteByThreadId).not.toHaveBeenCalled();
      expect(threadRepo.delete).not.toHaveBeenCalled();
      expect(existsSync(attachmentsDir)).toBe(false);
      expect(projectRepo.delete).toHaveBeenCalledWith("proj-2");
    });

    it("returns 404 when project does not exist", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const res = await app.request("/projects/missing", {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        code: "project_not_found",
        message: "Project missing not found",
      });
      expect(projectRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe("GET /projects/:id/files", () => {
    it("returns file suggestions for an existing project", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ id: "proj-2", rootPath: "/repo/root" }),
      );
      findProjectFiles.mockResolvedValue([
        { path: "src/components/PromptBox.tsx" },
        { path: "src/views/ThreadDetailView.tsx" },
      ]);

      const res = await app.request("/projects/proj-2/files?query=prompt&limit=5");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([
        { path: "src/components/PromptBox.tsx" },
        { path: "src/views/ThreadDetailView.tsx" },
      ]);
      expect(findProjectFiles).toHaveBeenCalledWith("/repo/root", "prompt", 5);
    });

    it("returns empty list for blank query without invoking search", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ id: "proj-2", rootPath: "/repo/root" }),
      );

      const res = await app.request("/projects/proj-2/files?query=%20%20");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
      expect(findProjectFiles).not.toHaveBeenCalled();
    });

    it("returns 404 when project does not exist", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const res = await app.request("/projects/unknown/files?query=src");

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("project_not_found");
      expect(body.message).toBe("Project unknown not found");
      expect(findProjectFiles).not.toHaveBeenCalled();
    });

    it("returns 500 when search throws", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ id: "proj-3", rootPath: "/repo/root" }),
      );
      findProjectFiles.mockRejectedValue(new Error("Search failed"));

      const res = await app.request("/projects/proj-3/files?query=foo");

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("internal_error");
      expect(body.message).toBe("Search failed");
    });
  });

  describe("POST /projects/:id/attachments", () => {
    it("uploads a prompt attachment for an existing project", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ id: "proj-2", rootPath: "/repo/root" }),
      );

      const formData = new FormData();
      formData.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
      const res = await app.request("/projects/proj-2/attachments", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        type: "localImage",
        path: "/Users/test/.bb/attachments/proj-2/image.png",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 12,
      });
      expect(savePromptAttachment).toHaveBeenCalledWith({
        projectId: "proj-2",
        file: expect.any(File),
      });
    });

    it("returns 404 when project does not exist", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const formData = new FormData();
      formData.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
      const res = await app.request("/projects/missing/attachments", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        code: "project_not_found",
        message: "Project missing not found",
      });
      expect(savePromptAttachment).not.toHaveBeenCalled();
    });

    it("returns 400 when file field is missing", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ id: "proj-2", rootPath: "/repo/root" }),
      );

      const formData = new FormData();
      const res = await app.request("/projects/proj-2/attachments", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        code: "invalid_request",
        message: "Expected multipart file field named 'file'",
      });
      expect(savePromptAttachment).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid attachment payload errors", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ id: "proj-2", rootPath: "/repo/root" }),
      );
      savePromptAttachment.mockRejectedValueOnce(
        invalidRequestError("Attachment too large"),
      );

      const formData = new FormData();
      formData.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
      const res = await app.request("/projects/proj-2/attachments", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        code: "invalid_request",
        message: "Attachment too large",
      });
    });
  });

  describe("GET /projects/:id/attachments/content", () => {
    it("serves attachment bytes for files inside the project attachment directory", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ id: "proj-2", rootPath: "/repo/root" }),
      );

      const attachmentsDir = resolve(bbRoot, "attachments", "proj-2");
      const filePath = resolve(attachmentsDir, "image.png");
      mkdirSync(attachmentsDir, { recursive: true });
      writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      try {
        const encodedPath = encodeURIComponent(filePath);
        const res = await app.request(
          `/projects/proj-2/attachments/content?path=${encodedPath}`,
        );

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        const bytes = new Uint8Array(await res.arrayBuffer());
        expect(Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
      } finally {
        rmSync(attachmentsDir, { recursive: true, force: true });
      }
    });

    it("rejects paths outside the project attachment directory", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ id: "proj-2", rootPath: "/repo/root" }),
      );

      const res = await app.request(
        `/projects/proj-2/attachments/content?path=${encodeURIComponent("/tmp/not-allowed.png")}`,
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        code: "invalid_request",
        message: "Attachment path is outside project scope",
      });
    });
  });
});
