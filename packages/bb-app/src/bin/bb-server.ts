#!/usr/bin/env node
import { runBbServer } from "../launcher.js";

void runBbServer().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
