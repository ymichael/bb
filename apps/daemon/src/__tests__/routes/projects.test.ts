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
} from "@beanbag/agent-core";
import { createProjectRoutes } from "../../routes/projects.js";
import type { EventRepository, ProjectRepository, ThreadRepository } from "@beanbag/db";
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
  let beanbagRoot: string;
  let threadManager: {
    spawn: ReturnType<typeof vi.fn>;
    systemTell: ReturnType<typeof vi.fn>;
    getRawById: ReturnType<typeof vi.fn>;
  };
  const originalBeanbagRoot = process.env.BEANBAG_ROOT;

  beforeEach(() => {
    beanbagRoot = mkdtempSync(join(tmpdir(), "beanbag-project-routes-root-"));
    process.env.BEANBAG_ROOT = beanbagRoot;
    projectRepo = mockProjectRepo();
    threadRepo = mockThreadRepo();
    eventRepo = mockEventRepo();
    deleteThreadAsync = vi.fn<DeleteThreadFn>().mockResolvedValue(undefined);
    threadManager = {
      spawn: vi.fn(),
      systemTell: vi.fn().mockResolvedValue(undefined),
      getRawById: vi.fn(),
    };
    findProjectFiles = vi.fn<SearchProjectFilesFn>().mockResolvedValue([]);
    savePromptAttachment = vi.fn<StorePromptAttachmentFn>().mockResolvedValue({
      type: "localImage",
      path: "/Users/test/.beanbag/attachments/proj-2/image.png",
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
    process.env.BEANBAG_ROOT = originalBeanbagRoot;
    rmSync(beanbagRoot, { recursive: true, force: true });
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
      expect(body.error).toBe("Unique constraint violated");
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
      expect(body.error).toBe("DB error");
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
      expect(body.error).toBe("Project unknown not found");
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
    it("returns an existing primary manager when present", async () => {
      const managerThread = makeThread({ id: "thread-manager-1", type: "manager" });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ primaryManagerThreadId: managerThread.id }),
      );
      threadManager.getRawById.mockReturnValue(managerThread);

      const res = await app.request("/projects/proj-1/manager", { method: "POST" });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: managerThread.id, type: "manager" });
      expect(threadManager.spawn).not.toHaveBeenCalled();
    });

    it("recreates the primary manager when the stored manager is archived", async () => {
      const archivedManager = makeThread({
        id: "thread-manager-archived",
        projectId: "proj-1",
        type: "manager",
        archivedAt: 123,
      });
      const replacementManager = makeThread({
        id: "thread-manager-2",
        projectId: "proj-1",
        type: "manager",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ id: "proj-1", primaryManagerThreadId: archivedManager.id }),
      );
      threadManager.getRawById
        .mockReturnValueOnce(archivedManager)
        .mockReturnValueOnce(replacementManager);
      threadManager.spawn.mockResolvedValue(replacementManager);

      const res = await app.request("/projects/proj-1/manager", { method: "POST" });

      expect(res.status).toBe(201);
      expect(projectRepo.update).toHaveBeenCalledWith("proj-1", {
        primaryManagerThreadId: null,
      });
      expect(threadManager.spawn).toHaveBeenCalled();
      expect(await res.json()).toMatchObject({ id: replacementManager.id, type: "manager" });
    });

    it("creates a primary manager, bootstraps workspace, and stores the pointer", async () => {
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
          environmentId: "local",
          developerInstructions: expect.stringContaining(
            "{{MANAGER_WORKSPACE_PATH}}",
          ),
          input: [{ type: "text", text: "[bb system] Welcome!" }],
        }),
      );
      expect(projectRepo.update).toHaveBeenCalledWith("proj-1", {
        primaryManagerThreadId: "thread-manager-1",
      });
      expect(threadManager.systemTell).not.toHaveBeenCalled();
      expect(existsSync(join(beanbagRoot, "workspace", "thread-manager-1"))).toBe(true);
    });

    it("rolls back the pointer and workspace when workspace bootstrap fails", async () => {
      const project = makeProject({ id: "proj-1" });
      const managerThread = makeThread({
        id: "thread-manager-rollback",
        projectId: project.id,
        type: "manager",
      });
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(project);
      threadManager.spawn.mockResolvedValue(managerThread);
      writeFileSync(join(beanbagRoot, "workspace"), "occupied");

      const res = await app.request("/projects/proj-1/manager", { method: "POST" });

      expect(res.status).toBe(500);
      expect(projectRepo.update).toHaveBeenNthCalledWith(1, "proj-1", {
        primaryManagerThreadId: null,
      });
      expect(deleteThreadAsync).toHaveBeenCalledWith("thread-manager-rollback");
      expect(
        existsSync(join(beanbagRoot, "workspace", "thread-manager-rollback")),
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
      const attachmentsDir = resolve(beanbagRoot, "attachments", "proj-2");
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
        error: "Project missing not found",
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
      expect(body.error).toBe("Project unknown not found");
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
      expect(body.error).toBe("Search failed");
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
        path: "/Users/test/.beanbag/attachments/proj-2/image.png",
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
        error: "Project missing not found",
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
        error: "Expected multipart file field named 'file'",
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
        error: "Attachment too large",
      });
    });
  });

  describe("GET /projects/:id/attachments/content", () => {
    it("serves attachment bytes for files inside the project attachment directory", async () => {
      (projectRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeProject({ id: "proj-2", rootPath: "/repo/root" }),
      );

      const attachmentsDir = resolve(beanbagRoot, "attachments", "proj-2");
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
        error: "Attachment path is outside project scope",
      });
    });
  });
});
