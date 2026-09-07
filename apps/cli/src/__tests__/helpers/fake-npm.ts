import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { vi } from "vitest";

const FAKE_NPM = `#!/usr/bin/env node
const { mkdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const args = process.argv.slice(2);

if (args[0] === "view") {
  const mode = process.env.BB_TEST_NPM_VIEW ?? "published";
  if (mode === "e404") {
    process.stderr.write("npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/@get-bb%2fplugin-sdk\\n");
    process.exit(1);
  }
  if (mode === "error") {
    process.stderr.write("npm error code ETIMEDOUT\\nnpm error network request to the registry failed\\n");
    process.exit(1);
  }
  if (mode === "missing") {
    // npm exits 0 and prints nothing for a package whose requested version
    // does not exist.
    process.exit(0);
  }
  const spec = args[1] ?? "";
  process.stdout.write(JSON.stringify(spec.slice(spec.lastIndexOf("@") + 1)) + "\\n");
  process.exit(0);
}

// BB_TEST_NPM_INSTALL=fail stands in for the installs that die before they
// touch the tree — an unwritable cache, a refused proxy, a missing platform
// binary. npm always explains itself on stderr; the CLI has to pass that on.
if (process.env.BB_TEST_NPM_INSTALL === "fail") {
  process.stderr.write("npm error code EPERM\\nnpm error syscall open\\nnpm error Your cache folder contains root-owned files\\n");
  process.exit(1);
}

if (process.env.BB_TEST_NPM_INSTALL === "fail-noisy-stdout") {
  process.stderr.write("npm error code EPERM\\nnpm error syscall open\\n");
  for (let line = 1; line <= 9; line += 1) {
    process.stdout.write("progress line " + line + "\\n");
  }
  process.exit(1);
}

// npm treats NODE_ENV=production as omit=dev; a command-line --include=dev
// outranks it. BB_TEST_NPM_ALWAYS_OMIT_DEV forces the omission to stand in for
// an install that silently drops packages.
const omitDev =
  process.env.BB_TEST_NPM_ALWAYS_OMIT_DEV === "1" ||
  (process.env.NODE_ENV === "production" && !args.includes("--include=dev"));
const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const installed = {
  ...manifest.dependencies,
  ...(omitDev ? {} : manifest.devDependencies),
};
// npm installs the whole workspace and hoists to its root when the package is
// a workspace member; BB_TEST_NPM_HOIST_TO stands in for that root.
const installRoot = process.env.BB_TEST_NPM_HOIST_TO ?? process.cwd();
for (const name of Object.keys(installed)) {
  mkdirSync(join(installRoot, "node_modules", ...name.split("/")), {
    recursive: true,
  });
}
`;

export async function installFakeNpm(workDir: string): Promise<string> {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "npm"), FAKE_NPM, { mode: 0o755 });
  vi.stubEnv("PATH", `${binDir}${delimiter}${process.env.PATH ?? ""}`);
  return binDir;
}
