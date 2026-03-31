import { describe, expect, it } from "vitest";
import { findLocalPathProjectSourceForHost } from "@bb/domain";

describe("project source selection", () => {
  it("reuses only the local_path source for the requested host", () => {
    const source = findLocalPathProjectSourceForHost(
      [
        {
          id: "src_github",
          projectId: "proj_1",
          type: "github_repo",
          repoUrl: "https://github.com/example/repo",
          isDefault: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "src_other",
          projectId: "proj_1",
          type: "local_path",
          hostId: "host_other",
          path: "/tmp/other",
          isDefault: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "src_local",
          projectId: "proj_1",
          type: "local_path",
          hostId: "host_local",
          path: "/tmp/local",
          isDefault: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      "host_local",
    );

    expect(source).toMatchObject({
      id: "src_local",
      type: "local_path",
      hostId: "host_local",
      path: "/tmp/local",
    });
  });
});
