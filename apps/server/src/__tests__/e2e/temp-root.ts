import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_TMP_ROOT_ENV = "BB_TEST_TMP_ROOT";

export function resolveBbTestTmpParent(): string {
  const configured = process.env[TEST_TMP_ROOT_ENV]?.trim();
  if (configured) {
    mkdirSync(configured, { recursive: true });
    return configured;
  }
  return tmpdir();
}

export function bbTestTmpPrefix(prefix: string): string {
  return join(resolveBbTestTmpParent(), prefix);
}
