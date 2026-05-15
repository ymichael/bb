#!/usr/bin/env node
import { runBbCli } from "../launcher.js";

void runBbCli().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
