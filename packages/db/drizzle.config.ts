import { defineConfig } from "drizzle-kit";
import { DEFAULTS } from "@bb/config/defaults";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const defaultDataDirName =
  process.env.NODE_ENV === "production"
    ? DEFAULTS.dataDir.prod
    : DEFAULTS.dataDir.dev;
const defaultDataDir = join(homedir(), defaultDataDirName);
const dbPath = resolve(
  process.env.BB_DATABASE_URL ?? join(defaultDataDir, "bb.db"),
);

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
});
