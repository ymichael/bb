import fs from "node:fs/promises";
import path from "node:path";

function parseArgs() {
  const [sourcePath, destinationPath] = process.argv.slice(2);
  if (!sourcePath || !destinationPath) {
    throw new Error("Usage: node scripts/copy-file.mjs <source> <destination>");
  }
  return { sourcePath, destinationPath };
}

async function main() {
  const { sourcePath, destinationPath } = parseArgs();
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
