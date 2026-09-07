import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, {
  MAX_HTML_BYTES,
  requireWorkspaceHtmlFile,
  resolveContainedHtmlPath,
} from "./server";

const ROOT = "/workspace/project";
const HOST_ID = "host_1";

function threadWithEnv(overrides?: { path?: string | null; hostId?: string }) {
  return {
    id: "thr_1",
    environment: {
      id: "env_1",
      hostId: overrides?.hostId ?? HOST_ID,
      path: overrides && "path" in overrides ? overrides.path : ROOT,
    },
  };
}

async function load(sdk: {
  threads?: { get: (args: unknown) => unknown };
  files?: { read: (args: unknown) => unknown };
}) {
  const host = createFakePluginHost({
    pluginId: "inline-vis",
    sdk,
  });
  await plugin(host.bb);
  return host;
}

describe("requireWorkspaceHtmlFile", () => {
  it("accepts nested html paths", () => {
    expect(requireWorkspaceHtmlFile("demo.html")).toBe("demo.html");
    expect(requireWorkspaceHtmlFile("charts/out.HTML")).toBe("charts/out.HTML");
  });

  it("rejects absolute, traversal, and non-html paths", () => {
    expect(() => requireWorkspaceHtmlFile("/etc/passwd.html")).toThrow(
      /workspace-relative/,
    );
    expect(() => requireWorkspaceHtmlFile("../secret.html")).toThrow(
      /traversal|escape/,
    );
    expect(() => requireWorkspaceHtmlFile("..\\secret.html")).toThrow();
    expect(() => requireWorkspaceHtmlFile("charts/../secret.html")).toThrow(
      /traversal/,
    );
    expect(() => requireWorkspaceHtmlFile("demo.md")).toThrow(/\.html/);
    expect(() => requireWorkspaceHtmlFile("")).toThrow(/non-empty/);
  });
});

describe("resolveContainedHtmlPath", () => {
  it("resolves under the root", () => {
    expect(resolveContainedHtmlPath(ROOT, "demo.html")).toBe(
      path.resolve(ROOT, "demo.html"),
    );
  });

  it("rejects resolved paths outside the root", () => {
    expect(() =>
      resolveContainedHtmlPath(ROOT, path.join("..", "outside.html")),
    ).toThrow(/escape/);
  });
});

describe("prepareHtmlPreview rpc", () => {
  it("rejects unknown input fields immediately", async () => {
    const { harness } = await load({
      threads: { get: () => threadWithEnv() },
      files: { read: () => ({ content: "", contentEncoding: "utf8" }) },
    });
    await expect(
      harness.callRpc("prepareHtmlPreview", {
        threadId: "thr_1",
        file: "demo.html",
        extra: true,
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: expect.any(Array),
    });
  });

  it("rejects missing fields and non-object input", async () => {
    const { harness } = await load({
      threads: { get: () => threadWithEnv() },
      files: { read: () => ({ content: "", contentEncoding: "utf8" }) },
    });
    await expect(
      harness.callRpc("prepareHtmlPreview", null),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: expect.any(Array),
    });
    await expect(
      harness.callRpc("prepareHtmlPreview", { threadId: "thr_1" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: expect.any(Array),
    });
    await expect(
      harness.callRpc("prepareHtmlPreview", { file: "demo.html" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: expect.any(Array),
    });
  });

  it("requires a live environment path and hostId", async () => {
    const { harness } = await load({
      threads: {
        get: () => threadWithEnv({ path: null }),
      },
      files: { read: () => ({ content: "<p>x</p>", contentEncoding: "utf8" }) },
    });
    await expect(
      harness.callRpc("prepareHtmlPreview", {
        threadId: "thr_1",
        file: "demo.html",
      }),
    ).rejects.toThrow(/no workspace path/);
  });

  it("reads through bb.sdk.files with hostId + rootPath confinement", async () => {
    const { harness } = await load({
      threads: {
        get: (args) => {
          expect(args).toEqual({
            threadId: "thr_1",
            include: "environment",
          });
          return threadWithEnv();
        },
      },
      files: {
        read: (args) => {
          expect(args).toEqual({
            path: path.resolve(ROOT, "charts/demo.html"),
            rootPath: ROOT,
            hostId: HOST_ID,
          });
          return {
            content: "<html><body>ok</body></html>",
            contentEncoding: "utf8",
            sizeBytes: 32,
            sha256: "abc",
          };
        },
      },
    });

    const result = await harness.callRpc("prepareHtmlPreview", {
      threadId: "thr_1",
      file: "charts/demo.html",
    });
    expect(result).toEqual({ file: "charts/demo.html" });
    expect(harness.sdk.callsTo("files.read")).toHaveLength(1);
  });

  it("rejects absolute and traversing file attributes before reading", async () => {
    const { harness } = await load({
      threads: { get: () => threadWithEnv() },
      files: {
        read: () => {
          throw new Error("should not read");
        },
      },
    });
    await expect(
      harness.callRpc("prepareHtmlPreview", {
        threadId: "thr_1",
        file: "/tmp/x.html",
      }),
    ).rejects.toThrow(/workspace-relative/);
    await expect(
      harness.callRpc("prepareHtmlPreview", {
        threadId: "thr_1",
        file: "../etc/passwd.html",
      }),
    ).rejects.toThrow(/traversal|escape/);
    expect(harness.sdk.callsTo("files.read")).toHaveLength(0);
  });

  it("maps missing files and rejects non-utf8 or oversized content", async () => {
    const missingHost = await load({
      threads: { get: () => threadWithEnv() },
      files: {
        read: () => {
          throw Object.assign(new Error("not found"), { status: 404 });
        },
      },
    });
    await expect(
      missingHost.harness.callRpc("prepareHtmlPreview", {
        threadId: "thr_1",
        file: "gone.html",
      }),
    ).rejects.toThrow(/not found/);

    const binaryHost = await load({
      threads: { get: () => threadWithEnv() },
      files: {
        read: () => ({
          content: "????",
          contentEncoding: "base64",
          sizeBytes: 4,
        }),
      },
    });
    await expect(
      binaryHost.harness.callRpc("prepareHtmlPreview", {
        threadId: "thr_1",
        file: "bin.html",
      }),
    ).rejects.toThrow(/UTF-8/);

    const hugeHost = await load({
      threads: { get: () => threadWithEnv() },
      files: {
        read: () => ({
          content: "",
          contentEncoding: "utf8",
          sizeBytes: MAX_HTML_BYTES + 1,
        }),
      },
    });
    await expect(
      hugeHost.harness.callRpc("prepareHtmlPreview", {
        threadId: "thr_1",
        file: "big.html",
      }),
    ).rejects.toThrow(/too large/);
  });
});
