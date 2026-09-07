import {
  readFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";
import { z } from "zod";
import { installRoot, sha256File } from "./installer.js";
import { resolveRuntime, runtimeRelease } from "./runtime-pin.js";
import { createRuntime } from "./runtime.js";

const chrome = z.string().min(1).parse(process.env.DEV_BROWSER_SMOKE_CHROME);
const root = await mkdtemp(join(tmpdir(), "bb-dev-browser-install-smoke-"));
const dataDir = join(root, "data");
await mkdir(join(dataDir, "runtime"), { recursive: true });
if (process.env.DEV_BROWSER_SMOKE_NO_SANDBOX === "1") {
  const escaped = `'${resolve(chrome).replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(dataDir, "runtime", "chrome"),
    `#!/bin/sh\nexec ${escaped} --no-sandbox "$@"\n`,
    { mode: 0o700 },
  );
} else await symlink(resolve(chrome), join(dataDir, "runtime", "chrome"));
const signal = new AbortController().signal;
const progress: string[] = [];
try {
  const coldStart = Date.now();
  const cold = await resolveRuntime({
    dataDir,
    signal,
    onProgress: (detail) => progress.push(detail),
  });
  const coldMs = Date.now() - coldStart;
  assert.equal(cold.source, "release");
  assert.equal(cold.version, runtimeRelease.version);
  assert.ok(cold.binary.startsWith(installRoot(dataDir)));
  const digest = await sha256File(cold.binary);
  const warmStart = Date.now();
  const warm = await resolveRuntime({
    dataDir,
    signal,
    env: { PATH: join(root, "no-npm-here") },
  });
  const warmMs = Date.now() - warmStart;
  assert.equal(warm.binary, cold.binary);
  const session = await createRuntime({
    runtime: warm,
    dataDir,
    tempDir: join(root, "sessions"),
    signal,
  });
  try {
    const page =
      "data:text/html," +
      encodeURIComponent(
        `<h1>installed</h1><iframe srcdoc="<button id='inner'>frame-button</button>"></iframe>`,
      );
    const result = await session.run(
      `const p = await browser.getPage("main"); await p.goto(${JSON.stringify(page)}); await p.snapshot()`,
      20_000,
      signal,
    );
    assert.equal(result.exitCode, 0, result.text);
    assert.match(result.text, /installed/);
    assert.match(result.text, /frame-button/);
    const shot = await session.run(
      'const p = await browser.getPage("main"); await p.shot({ type: "jpeg", maxEdge: 640, quality: 60 }); undefined',
      20_000,
      signal,
    );
    assert.equal(shot.images.length, 1);
    assert.deepEqual(
      (await readFile(shot.images[0]!.path)).subarray(0, 3),
      Buffer.from([0xff, 0xd8, 0xff]),
    );
    console.log(
      JSON.stringify(
        {
          passed: true,
          platform: `${process.platform}-${process.arch}`,
          package: `${runtimeRelease.package}@${runtimeRelease.version}`,
          binary: cold.binary,
          sha256: digest,
          coldInstallMs: coldMs,
          warmResolveMs: warmMs,
          progress,
          checks: [
            "cold install from npm with provenance",
            "warm reuse without npm on PATH",
            "headless Chrome navigation with iframe snapshot",
            "JPEG screenshot",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await session.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
