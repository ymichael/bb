import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_TMP_ROOT_ENV = "BEANBAG_TEST_TMP_ROOT";

export function resolveBeanbagTestTmpParent(): string {
  const configured = process.env[TEST_TMP_ROOT_ENV]?.trim();
  if (configured) {
    mkdirSync(configured, { recursive: true });
    return configured;
  }
  return tmpdir();
}

export function beanbagTestTmpPrefix(prefix: string): string {
  return join(resolveBeanbagTestTmpParent(), prefix);
}
