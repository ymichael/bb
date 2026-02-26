import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Project, ProjectFileSuggestion } from "@beanbag/agent-core";
import { createProjectRoutes } from "../../routes/projects.js";
import type { ProjectRepository } from "@beanbag/db";

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

function mockProjectRepo(): ProjectRepository {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  } as unknown as ProjectRepository;
}

describe("Project routes", () => {
  type SearchProjectFilesFn = (
    rootPath: string,
    query: string,
    limit?: number,
  ) => Promise<ProjectFileSuggestion[]>;

  let projectRepo: ReturnType<typeof mockProjectRepo>;
  let findProjectFiles: ReturnType<typeof vi.fn>;
  let app: Hono;

  beforeEach(() => {
    projectRepo = mockProjectRepo();
    findProjectFiles = vi.fn<SearchProjectFilesFn>().mockResolvedValue([]);
    const routes = createProjectRoutes(
      projectRepo as any,
      findProjectFiles as SearchProjectFilesFn,
    );
    app = new Hono().route("/projects", routes);
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
      expect(body.error).toBe("DB error");
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
      expect(body.error).toBe("Project not found");
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
      expect(body.error).toBe("Search failed");
    });
  });
});
