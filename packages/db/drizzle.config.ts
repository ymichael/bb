import { defineConfig } from "drizzle-kit";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEFAULTS } from "../config/src/defaults.ts";

function expandHomeDirectory(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

const isDev = process.env.NODE_ENV !== "production";

function resolveDataDir(): string {
  const configured = process.env.BB_DATA_DIR?.trim();
  if (!configured) {
    return resolve(homedir(), isDev ? DEFAULTS.dataDir.dev : DEFAULTS.dataDir.prod);
  }
  return resolve(expandHomeDirectory(configured));
}

const defaultDbPath = resolve(resolveDataDir(), "bb.db");
const dbPath = process.env.BB_DATABASE_URL
  ? resolve(process.env.BB_DATABASE_URL)
  : defaultDbPath;

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
});
