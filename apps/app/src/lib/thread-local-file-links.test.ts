import { describe, expect, it } from "vitest";
import { resolveThreadLocalFileLink } from "./thread-local-file-links";

describe("resolveThreadLocalFileLink", () => {
  it("leaves app routes as normal navigation", () => {
    expect(
      resolveThreadLocalFileLink({
        hostFileLinksAvailable: true,
        link: {
          lineNumber: null,
          path: "/projects/proj_gyz9przugq/threads/thr_rq7r4uv8zg",
        },
        workspaceRootPath: "/Users/me/project",
      }),
    ).toEqual({
      kind: "app-route",
    });
  });

  it("opens host file links when there is no ready local workspace", () => {
    expect(
      resolveThreadLocalFileLink({
        hostFileLinksAvailable: true,
        link: {
          lineNumber: null,
          path: "/Users/me/project/src/file.ts",
        },
        workspaceRootPath: null,
      }),
    ).toEqual({
      kind: "open-host-path",
      request: {
        lineNumber: null,
        path: "/Users/me/project/src/file.ts",
      },
    });
  });

  it("rejects file links when host-file context is unavailable", () => {
    expect(
      resolveThreadLocalFileLink({
        hostFileLinksAvailable: false,
        link: {
          lineNumber: 12,
          path: "/Users/me/.ssh/id_rsa",
        },
        workspaceRootPath: "/Users/me/project",
      }),
    ).toEqual({
      description:
        "Thread file links are only available when the thread has an environment.",
      kind: "error",
    });
  });

  it("opens paths outside the workspace root as host files", () => {
    expect(
      resolveThreadLocalFileLink({
        hostFileLinksAvailable: true,
        link: {
          lineNumber: 12,
          path: "/Users/me/.ssh/id_rsa",
        },
        workspaceRootPath: "/Users/me/project",
      }),
    ).toEqual({
      kind: "open-host-path",
      request: {
        lineNumber: 12,
        path: "/Users/me/.ssh/id_rsa",
      },
    });
  });

  it("normalizes paths before checking workspace containment", () => {
    expect(
      resolveThreadLocalFileLink({
        hostFileLinksAvailable: true,
        link: {
          lineNumber: 12,
          path: "/Users/me/project/src/../src/file.ts",
        },
        workspaceRootPath: "/Users/me/project/",
      }),
    ).toEqual({
      kind: "open-workspace-path",
      request: {
        lineNumber: 12,
        path: "/Users/me/project/src/file.ts",
        relativePath: "src/file.ts",
        workspaceRootPath: "/Users/me/project",
      },
    });
  });

  it("rejects relative file links", () => {
    expect(
      resolveThreadLocalFileLink({
        hostFileLinksAvailable: true,
        link: {
          lineNumber: 7,
          path: "apps/app/src/main.tsx",
        },
        workspaceRootPath: "/Users/me/project",
      }),
    ).toEqual({
      description: "Thread file links must use absolute file paths.",
      kind: "error",
    });
  });

  it("rejects relative file links that escape the workspace root", () => {
    expect(
      resolveThreadLocalFileLink({
        hostFileLinksAvailable: true,
        link: {
          lineNumber: null,
          path: "../secret.txt",
        },
        workspaceRootPath: "/Users/me/project",
      }),
    ).toEqual({
      description: "Thread file links must use absolute file paths.",
      kind: "error",
    });
  });

  it("does not mistake deeper filesystem paths for project routes", () => {
    expect(
      resolveThreadLocalFileLink({
        hostFileLinksAvailable: true,
        link: {
          lineNumber: null,
          path: "/projects/my-repo/src/file.ts",
        },
        workspaceRootPath: "/projects/my-repo",
      }),
    ).toEqual({
      kind: "open-workspace-path",
      request: {
        lineNumber: null,
        path: "/projects/my-repo/src/file.ts",
        relativePath: "src/file.ts",
        workspaceRootPath: "/projects/my-repo",
      },
    });
  });
});
