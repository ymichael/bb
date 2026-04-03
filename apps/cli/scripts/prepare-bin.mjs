import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");
const indexPath = path.join(distRoot, "index.js");
const binDirectoryPath = path.join(distRoot, "bin");
const bbPath = path.join(binDirectoryPath, "bb");

async function main() {
  const indexStats = await fs.stat(indexPath).catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Missing CLI entrypoint at ${indexPath}. Run the TypeScript build first.`);
    }
    throw error;
  });

  if (!indexStats.isFile()) {
    throw new Error(`CLI entrypoint is not a file: ${indexPath}`);
  }

  await fs.mkdir(binDirectoryPath, { recursive: true });
  await fs.chmod(indexPath, 0o755);

  const wrapper = `#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SCRIPT_DIR/../index.js" "$@"
`;

  await fs.writeFile(bbPath, wrapper, {
    encoding: "utf8",
    mode: 0o755,
  });
  await fs.chmod(bbPath, 0o755);
}

void main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
