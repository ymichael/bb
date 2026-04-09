import { defineConfig } from "drizzle-kit";
import { resolve } from "node:path";
import { serverConfig } from "../config/src/server.js";

const dbPath = resolve(serverConfig.BB_DATABASE_URL);

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
});
