import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { decodeOutput, runtimeEnvironment } from "./runtime.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const done = { type: "done", exitCode: 0, durationMs: 1 };
const endpoint = "ws://127.0.0.1:9999/cdp?token=private-secret";
const frames = (...items: object[]) =>
  items.map((item) => JSON.stringify(item)).join("\n");
describe("runtime output boundary", () => {
  it("returns a readable temporary JPEG path without embedding image bytes", async () => {
    const home = await mkdtemp(join(tmpdir(), "browser-capture-test-"));
    dirs.push(home);
    await mkdir(join(home, "tmp"));
    const path = join(home, "tmp", "capture.jpg");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await writeFile(path, jpeg);
    const result = await decodeOutput(
      frames({ type: "image", path, width: 640, height: 400 }, done),
      home,
      endpoint,
      "1.0.0-test",
    );
    expect(result.images).toEqual([
      {
        path: await realpath(path),
        mimeType: "image/jpeg",
        width: 640,
        height: 400,
      },
    ]);
    expect(await readFile(result.images[0]!.path)).toEqual(jpeg);
    expect(JSON.stringify(result)).not.toContain(jpeg.toString("base64"));
  });
  it("does not inherit unrelated credentials or DevBrowser routing overrides", () => {
    const env = runtimeEnvironment("/tmp/session-one");
    expect(env.DEV_BROWSER_HOME).toBe("/tmp/session-one");
    expect(env.DEV_BROWSER_SOCKET).toBe("/tmp/session-one/daemon.sock");
    expect(
      Object.keys(env).every((key) =>
        [
          "PATH",
          "HOME",
          "LANG",
          "LC_ALL",
          "TMPDIR",
          "XDG_RUNTIME_DIR",
          "DBUS_SESSION_BUS_ADDRESS",
          "DEV_BROWSER_HOME",
          "DEV_BROWSER_SOCKET",
        ].includes(key),
      ),
    ).toBe(true);
  });
  it("redacts connection credentials and runtime paths", async () => {
    const result = await decodeOutput(
      frames(
        {
          type: "stdout",
          data: `${endpoint} private-secret /tmp/isolated/file`,
        },
        done,
      ),
      "/tmp/isolated",
      endpoint,
      "1.0.0-test",
    );
    expect(result.text).not.toContain("private-secret");
    expect(result.text).not.toContain("/tmp/isolated");
  });
  it("redacts native path credentials alone, in paths, and in full endpoints", async () => {
    const token = "native-private-credential";
    const path = `/devtools/browser/${token}`;
    const endpoint = `ws://127.0.0.1:9999${path}`;
    const result = await decodeOutput(
      frames(
        {
          type: "stdout",
          data: `${token} ${path} ${endpoint} http://localhost:9999/health 9999`,
        },
        done,
      ),
      "/tmp/isolated",
      endpoint,
      "1.0.0-test",
    );
    expect(result.text).not.toContain(token);
    expect(result.text).not.toContain(path);
    expect(result.text).not.toContain(endpoint);
    expect(result.text).toContain("http://localhost:9999/health 9999");
  });
  it("redacts native credentials from failure diagnostics", async () => {
    const token = "failed-connection-private-token";
    const path = `/devtools/browser/${token}`;
    const endpoint = `ws://127.0.0.1:9999${path}`;
    const result = await decodeOutput(
      frames(
        {
          type: "error",
          kind: "daemon",
          name: "WebSocketError",
          message: `Failed ${endpoint}; path ${path}; credential ${token}`,
        },
        { type: "done", exitCode: 1, durationMs: 1 },
      ),
      "/tmp/isolated",
      endpoint,
      "1.0.0-test",
    );
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("WebSocketError");
    expect(result.text).not.toContain(token);
    expect(result.text).not.toContain(path);
    expect(result.text).not.toContain(endpoint);
  });
  it("rejects incomplete, malformed, and trailing frames", async () => {
    await expect(
      decodeOutput(
        frames({ type: "stdout", data: "hello" }),
        "/tmp/home",
        endpoint,
        "1.0.0-test",
      ),
    ).rejects.toThrow("completion");
    await expect(
      decodeOutput(frames(done, done), "/tmp/home", endpoint, "1.0.0-test"),
    ).rejects.toThrow("after completion");
    await expect(
      decodeOutput(
        frames({ type: "image", path: "/tmp/x", width: -1, height: 20 }, done),
        "/tmp/home",
        endpoint,
        "1.0.0-test",
      ),
    ).rejects.toThrow();
  });
  it("refuses capture-directory symlink escapes", async () => {
    const home = await mkdtemp(join(tmpdir(), "devbrowser-test-"));
    dirs.push(home);
    await mkdir(join(home, "tmp"));
    await writeFile(
      join(home, "secret.jpg"),
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    );
    await symlink(join(home, "secret.jpg"), join(home, "tmp", "image.jpg"));
    await expect(
      decodeOutput(
        frames(
          {
            type: "image",
            path: join(home, "tmp", "image.jpg"),
            width: 1,
            height: 1,
          },
          done,
        ),
        home,
        endpoint,
        "1.0.0-test",
      ),
    ).rejects.toThrow("escaped");
  });
});
