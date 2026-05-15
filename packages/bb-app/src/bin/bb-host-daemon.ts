#!/usr/bin/env node
import { runBbHostDaemon } from "../launcher.js";

void runBbHostDaemon().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
