import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  collectLogPayloads,
  getHelpOutput,
  readlineMocks,
  resolveLocalHostIdMock,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerProjectCommands } from "../../commands/project.js";

describe("bb project command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerProjectCommands(program, () => "http://server");

  it("documents that attachment upload reads the CLI machine", async () => {
    const help = await getHelpOutput(
      ["project", "attachment", "upload"],
      register,
    );

    expect(help).toContain("Upload a file read from this CLI machine");
    expect(help).toContain("--client-file <path>");
    expect(help.replace(/\s+/gu, " ")).toContain(
      "not the thread execution host",
    );
  });

  it("documents project creation machine selectors", async () => {
    const help = await getHelpOutput(["project", "create"], register);

    expect(help).toContain("--machine <id-or-name>");
    expect(help).toContain("Execution machine ID or unambiguous name");
    expect(help).toContain("--host <id-or-name>");
    expect(help).toContain("Alias for --machine");
  });

  it("uploads binary bytes read on a remote CLI machine with explicit metadata", async () => {
    const clientDir = await mkdtemp(join(tmpdir(), "bb-cli-attachment-"));
    try {
      const clientPath = join(clientDir, "payload.bin");
      const bytes = new Uint8Array([0, 255, 1, 128, 42]);
      await writeFile(clientPath, bytes);
      let request: Request | undefined;
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        request = new Request(input, init);
        return new Response(
          JSON.stringify({
            type: "localFile",
            path: "payload-uploaded.bin",
            name: "renamed.bin",
            mimeType: "application/x-bb-test",
            sizeBytes: bytes.byteLength,
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      });

      await runCommand(
        [
          "project",
          "attachment",
          "upload",
          "proj-remote",
          "--client-file",
          clientPath,
          "--filename",
          "renamed.bin",
          "--mime-type",
          "application/x-bb-test",
          "--json",
        ],
        register,
      );

      expect(request?.url).toBe(
        "http://server/api/v1/projects/proj-remote/attachments",
      );
      const form = await request?.formData();
      const file = form?.get("file");
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) {
        throw new Error("Expected multipart attachment file");
      }
      expect(file.name).toBe("renamed.bin");
      expect(file.type).toBe("application/x-bb-test");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
      expect(
        JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
      ).toEqual({
        type: "localFile",
        path: "payload-uploaded.bin",
        name: "renamed.bin",
        mimeType: "application/x-bb-test",
        sizeBytes: bytes.byteLength,
      });
    } finally {
      await rm(clientDir, { force: true, recursive: true });
    }
  });

  it("downloads attachment bytes to an explicit client-local path", async () => {
    const clientDir = await mkdtemp(join(tmpdir(), "bb-cli-attachment-"));
    try {
      const outputPath = join(clientDir, "downloaded.bin");
      const bytes = new Uint8Array([3, 2, 1, 0, 255]);
      const get = vi.fn(
        async () =>
          new Response(bytes, {
            headers: { "content-type": "application/octet-stream" },
          }),
      );
      stubServerApi({ "v1.projects.:id.attachments.content.$get": get });

      await runCommand(
        [
          "project",
          "attachment",
          "download",
          "proj-remote",
          "stored.bin",
          "--client-file",
          outputPath,
          "--json",
        ],
        register,
      );

      expect(get).toHaveBeenCalledWith({
        param: { id: "proj-remote" },
        query: { path: "stored.bin" },
      });
      expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes);
      expect(
        JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
      ).toEqual({
        attachmentPath: "stored.bin",
        clientFile: outputPath,
        mimeType: "application/octet-stream",
        sizeBytes: bytes.byteLength,
      });
    } finally {
      await rm(clientDir, { force: true, recursive: true });
    }
  });

  it("prints the server attachment limit envelope without rewriting it", async () => {
    const clientDir = await mkdtemp(join(tmpdir(), "bb-cli-attachment-"));
    try {
      const clientPath = join(clientDir, "huge.png");
      await writeFile(clientPath, new Uint8Array([1]));
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "invalid_request",
            message: "Attachment exceeds 10MB limit",
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      );

      await expect(
        runCommand(
          [
            "project",
            "attachment",
            "upload",
            "proj-remote",
            "--client-file",
            clientPath,
          ],
          register,
        ),
      ).rejects.toThrow("process.exit:1");
      expect(console.error).toHaveBeenCalledWith(
        "Error: HTTP 400: Attachment exceeds 10MB limit",
      );
    } finally {
      await rm(clientDir, { force: true, recursive: true });
    }
  });

  it("bb project list --json prints raw projects", async () => {
    const projects = [
      {
        id: "proj-1",
        name: "Alpha",
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    const get = vi.fn(async () => projects);
    stubServerApi({ "v1.projects.$get": get });

    await runCommand(["project", "list", "--json"], register);

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(projects);
    expect(get).toHaveBeenCalledWith({ query: {} });
  });

  it("bb project list can include the personal project", async () => {
    const projects = [{ id: "proj_personal", name: "Personal" }];
    const get = vi.fn(async () => projects);
    stubServerApi({ "v1.projects.$get": get });

    await runCommand(
      ["project", "list", "--include-personal", "--json"],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      query: { includePersonal: "true" },
    });
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(projects);
  });

  it("bb project branches waits for remote refs implicitly", async () => {
    const branches = { branches: ["main"], remoteBranches: ["origin/main"] };
    const get = vi.fn(async () => branches);
    stubServerApi({ "v1.projects.:id.branches.$get": get });

    await runCommand(
      ["project", "branches", "proj-1", "--host", "host-1", "--json"],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      param: { id: "proj-1" },
      query: { hostId: "host-1" },
    });
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(branches);
  });

  it("bb project list renders the shared borderless table", async () => {
    const projects = [
      {
        id: "proj-1",
        name: "Alpha",
        sources: [
          { hostId: "host-test-001", type: "local_path", path: "/tmp/alpha" },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    const get = vi.fn(async () => projects);
    stubServerApi({ "v1.projects.$get": get });

    await runCommand(["project", "list"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "ID      Name   Path\n------  -----  ----------\nproj-1  Alpha  /tmp/alpha",
      "",
    ]);
  });

  it("bb project files resolves a machine name and prints JSON", async () => {
    const getFiles = vi.fn(async () => ({
      files: [{ name: "remote.txt", path: "remote.txt" }],
      truncated: false,
    }));
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        {
          id: "host-remote",
          name: "builder",
          type: "persistent",
          status: "connected",
          lastSeenAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      "v1.projects.:id.files.$get": getFiles,
    });

    await runCommand(
      ["project", "files", "proj-1", "--machine", "builder", "--json"],
      register,
    );

    expect(getFiles).toHaveBeenCalledWith({
      param: { id: "proj-1" },
      query: { hostId: "host-remote" },
    });
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      files: [{ name: "remote.txt", path: "remote.txt" }],
      truncated: false,
    });
  });

  it("bb project content routes by environment and prints the portable DTO as JSON", async () => {
    const getContent = vi.fn(
      async () =>
        new Response("environment text", {
          headers: {
            "content-type": "text/plain",
            "x-bb-content-encoding": "utf8",
          },
        }),
    );
    stubServerApi({
      "v1.projects.:id.files.content.$get": getContent,
    });

    await runCommand(
      [
        "project",
        "content",
        "proj-1",
        "README.md",
        "--environment",
        "env-remote",
        "--json",
      ],
      register,
    );

    expect(getContent).toHaveBeenCalledWith({
      param: { id: "proj-1" },
      query: { environmentId: "env-remote", path: "README.md" },
    });
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      content: "environment text",
      contentEncoding: "utf8",
      mimeType: "text/plain",
      sizeBytes: 16,
    });
  });

  it("bb project discovery rejects simultaneous machine and environment selectors", async () => {
    await expect(
      runCommand(
        [
          "project",
          "paths",
          "proj-1",
          "--machine",
          "builder",
          "--environment",
          "env-remote",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      "Error: Cannot combine --machine or --host with --environment; the environment already selects its machine.",
    );
  });

  it("bb project create --json prints the created project", async () => {
    const created = {
      id: "proj-created",
      name: "Alpha",
      createdAt: 1,
      updatedAt: 2,
    };
    const post = vi.fn(async () => created);
    stubServerApi({ "v1.projects.$post": post });

    await runCommand(
      [
        "project",
        "create",
        "--name",
        "Alpha",
        "--root",
        "/tmp/alpha",
        "--json",
      ],
      register,
    );

    expect(resolveLocalHostIdMock).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({
      json: {
        name: "Alpha",
        source: {
          hostId: "host-test-001",
          path: "/tmp/alpha",
          type: "local_path",
        },
      },
    });
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(created);
  });

  it.each([
    ["machine name", "--machine", "builder"],
    ["host alias", "--host", "host-remote"],
  ])(
    "bb project create binds a local path through an explicit %s",
    async (_selectorKind, selectorFlag, selector) => {
      const post = vi.fn(async () => ({
        id: "proj-created",
        name: "Remote Alpha",
        createdAt: 1,
        updatedAt: 2,
      }));
      stubServerApi({
        "v1.hosts.$get": vi.fn(async () => [
          {
            id: "host-remote",
            name: "builder",
            type: "persistent",
            status: "connected",
            lastSeenAt: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
        "v1.projects.$post": post,
      });

      await runCommand(
        [
          "project",
          "create",
          "--name",
          "Remote Alpha",
          "--root",
          "/srv/alpha",
          selectorFlag,
          selector,
          "--json",
        ],
        register,
      );

      expect(resolveLocalHostIdMock).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith({
        json: {
          name: "Remote Alpha",
          source: {
            hostId: "host-remote",
            path: "/srv/alpha",
            type: "local_path",
          },
        },
      });
    },
  );

  it("bb project create rejects simultaneous machine and host selectors", async () => {
    await expect(
      runCommand(
        [
          "project",
          "create",
          "--name",
          "Alpha",
          "--root",
          "/tmp/alpha",
          "--machine",
          "builder",
          "--host",
          "host-remote",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      "Error: Cannot combine --machine with --host.",
    );
    expect(resolveLocalHostIdMock).not.toHaveBeenCalled();
  });

  it("bb project create rejects an unknown machine selection", async () => {
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        {
          id: "host-primary",
          name: "workstation",
          type: "persistent",
          status: "connected",
          lastSeenAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    });

    await expect(
      runCommand(
        [
          "project",
          "create",
          "--name",
          "Alpha",
          "--root",
          "/tmp/alpha",
          "--machine",
          "builder",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      "Error: Machine 'builder' was not found. Available machines: workstation (host-primary).",
    );
  });

  it("bb project create rejects an ambiguous machine name", async () => {
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        {
          id: "host-builder-1",
          name: "builder",
          type: "persistent",
          status: "connected",
          lastSeenAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "host-builder-2",
          name: "builder",
          type: "persistent",
          status: "connected",
          lastSeenAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    });

    await expect(
      runCommand(
        [
          "project",
          "create",
          "--name",
          "Alpha",
          "--root",
          "/tmp/alpha",
          "--host",
          "builder",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      "Error: Machine name 'builder' is ambiguous. Matches: builder (host-builder-1), builder (host-builder-2).",
    );
  });

  it("project creation and source add reject a disconnected machine", async () => {
    const hosts = [
      {
        id: "host-remote",
        name: "builder",
        type: "persistent",
        status: "disconnected",
        lastSeenAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    stubServerApi({ "v1.hosts.$get": vi.fn(async () => hosts) });

    await expect(
      runCommand(
        [
          "project",
          "create",
          "--name",
          "Alpha",
          "--root",
          "/srv/alpha",
          "--machine",
          "builder",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenLastCalledWith(
      "Error: Machine 'builder' is disconnected.",
    );

    vi.mocked(console.error).mockClear();
    await expect(
      runCommand(
        [
          "project",
          "source",
          "add",
          "proj-1",
          "--path",
          "/srv/alpha",
          "--machine",
          "builder",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenLastCalledWith(
      "Error: Machine 'builder' is disconnected.",
    );
  });

  it("bb project source add targets an unambiguous machine name", async () => {
    const post = vi.fn(async () => ({
      id: "source-remote",
      projectId: "proj-1",
      hostId: "host-remote",
      type: "local_path",
      path: "/srv/alpha",
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
    }));
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        {
          id: "host-remote",
          name: "builder",
          type: "persistent",
          status: "connected",
          lastSeenAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      "v1.projects.:id.sources.$post": post,
    });

    await runCommand(
      [
        "project",
        "source",
        "add",
        "proj-1",
        "--machine",
        "builder",
        "--path",
        "/srv/alpha",
      ],
      register,
    );

    expect(resolveLocalHostIdMock).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({
      param: { id: "proj-1" },
      json: {
        hostId: "host-remote",
        path: "/srv/alpha",
        type: "local_path",
      },
    });
  });

  it("bb project source add supports clone options through the --host alias", async () => {
    const post = vi.fn(async () => ({
      id: "source-clone",
      projectId: "proj-1",
      hostId: "host-remote",
      type: "local_path",
      path: "/srv/clones/alpha",
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
    }));
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        {
          id: "host-remote",
          name: "builder",
          type: "persistent",
          status: "connected",
          lastSeenAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      "v1.projects.:id.sources.$post": post,
    });

    await runCommand(
      [
        "project",
        "source",
        "add",
        "proj-1",
        "--host",
        "host-remote",
        "--clone",
        "--remote-url",
        "git@example.test:alpha.git",
        "--target-path",
        "/srv/clones/alpha",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "proj-1" },
      json: {
        hostId: "host-remote",
        remoteUrl: "git@example.test:alpha.git",
        targetPath: "/srv/clones/alpha",
        type: "clone",
      },
    });
  });

  it("bb project source add rejects clone-only options without --clone", async () => {
    await expect(
      runCommand(
        [
          "project",
          "source",
          "add",
          "proj-1",
          "--remote-url",
          "git@example.test:alpha.git",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      "Error: --remote-url and --target-path require --clone.",
    );
    expect(resolveLocalHostIdMock).not.toHaveBeenCalled();
  });

  it("bb project source update patches the existing source type", async () => {
    const get = vi.fn(async () => ({
      createdAt: 1,
      id: "proj-1",
      name: "Alpha",
      sources: [
        {
          createdAt: 1,
          hostId: "host-test-001",
          id: "source-1",
          isDefault: true,
          path: "/tmp/alpha",
          projectId: "proj-1",
          type: "local_path",
          updatedAt: 2,
        },
      ],
      updatedAt: 2,
    }));
    const patch = vi.fn(async () => ({
      createdAt: 1,
      hostId: "host-test-001",
      id: "source-1",
      isDefault: true,
      path: "/tmp/renamed",
      projectId: "proj-1",
      type: "local_path",
      updatedAt: 3,
    }));
    stubServerApi({
      "v1.projects.:id.$get": get,
      "v1.projects.:id.sources.:sourceId.$patch": patch,
    });

    await runCommand(
      [
        "project",
        "source",
        "update",
        "proj-1",
        "source-1",
        "--path",
        "/tmp/renamed",
      ],
      register,
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Project source updated: source-1",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "source-1  local_path  /tmp/renamed [default]",
    );
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        json: {
          path: "/tmp/renamed",
          type: "local_path",
        },
        param: { id: "proj-1", sourceId: "source-1" },
      }),
    );
  });

  it("bb project source delete deletes without prompting when --yes is passed", async () => {
    const del = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.projects.:id.sources.:sourceId.$delete": del });

    await runCommand(
      ["project", "source", "delete", "proj-1", "source-1", "--yes"],
      register,
    );

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Project source source-1 deleted",
    );
    expect(readlineMocks.question).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        param: { id: "proj-1", sourceId: "source-1" },
      }),
    );
  });
});
