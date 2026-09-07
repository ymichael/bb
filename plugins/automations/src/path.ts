import { dirname } from "node:path";
import type { Db } from "./data.js";

export function pluginDataDirFromDb(db: Db): string {
  const row = db
    .prepare(`PRAGMA database_list`)
    .all()
    .find((entry: unknown) => (entry as { name?: unknown }).name === "main");
  const file = (row as { file?: unknown } | undefined)?.file;
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(
      "Unable to resolve plugin data directory from SQLite handle",
    );
  }
  return dirname(file);
}
