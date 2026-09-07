import fs from "node:fs";
import path from "node:path";

export function resolveRepoRelativeFile(
  envName: string,
  value: string,
): string {
  if (path.isAbsolute(value)) {
    if (!fs.existsSync(value)) {
      throw new Error(`${envName} names a missing file: ${value}`);
    }
    return value;
  }
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, value);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `${envName} names a missing file: ${value} (tried ${process.cwd()} and its ancestors)`,
  );
}
