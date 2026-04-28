import { describe, expect, it } from "vitest";
import { resolveThreadLocalFileLink } from "./thread-local-file-links";

describe("resolveThreadLocalFileLink", () => {
  it("leaves app routes as normal navigation", () => {
    expect(
      resolveThreadLocalFileLink({
        link: {
          lineNumber: null,
          path: "/projects/proj_1/threads/thr_1",
        },
        workspaceRootPath: "/Users/me/project",
      }),
    ).toEqual({
      kind: "app-route",
    });
  });

  it("rejects local file links when there is no ready local workspace", () => {
    expect(
      resolveThreadLocalFileLink({
        link: {
          lineNumber: null,
          path: "/Users/me/project/src/file.ts",
        },
        workspaceRootPath: null,
      }),
    ).toEqual({
      description: "Thread file links are only available for ready local workspaces.",
      kind: "error",
    });
  });

  it("rejects paths outside the workspace root", () => {
    expect(
      resolveThreadLocalFileLink({
        link: {
          lineNumber: 12,
          path: "/Users/me/.ssh/id_rsa",
        },
        workspaceRootPath: "/Users/me/project",
      }),
    ).toEqual({
      description:
        "Thread file links can only open files inside the current workspace.",
      kind: "error",
    });
  });

  it("normalizes paths before checking workspace containment", () => {
    expect(
      resolveThreadLocalFileLink({
        link: {
          lineNumber: 12,
          path: "/Users/me/project/src/../src/file.ts",
        },
        workspaceRootPath: "/Users/me/project/",
      }),
    ).toEqual({
      kind: "open-local-path",
      request: {
        lineNumber: 12,
        path: "/Users/me/project/src/file.ts",
        workspaceRootPath: "/Users/me/project",
      },
    });
  });

  it("does not mistake deeper filesystem paths for project routes", () => {
    expect(
      resolveThreadLocalFileLink({
        link: {
          lineNumber: null,
          path: "/projects/my-repo/src/file.ts",
        },
        workspaceRootPath: "/projects/my-repo",
      }),
    ).toEqual({
      kind: "open-local-path",
      request: {
        lineNumber: null,
        path: "/projects/my-repo/src/file.ts",
        workspaceRootPath: "/projects/my-repo",
      },
    });
  });
});
