#!/usr/bin/env node
import { runBbApp } from "../launcher.js";

void runBbApp().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
