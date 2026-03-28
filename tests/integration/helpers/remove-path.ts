import fs from "node:fs/promises";

const REMOVE_PATH_RETRY_LIMIT = 10;
const REMOVE_PATH_RETRY_DELAY_MS = 50;
const RETRYABLE_REMOVE_ERROR_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function isRetryableRemoveError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    typeof error.code === "string" &&
    RETRYABLE_REMOVE_ERROR_CODES.has(error.code)
  );
}

export async function removePathWithRetry(pathToRemove: string): Promise<void> {
  for (let attempt = 0; attempt <= REMOVE_PATH_RETRY_LIMIT; attempt += 1) {
    try {
      await fs.rm(pathToRemove, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        !isRetryableRemoveError(error) ||
        attempt === REMOVE_PATH_RETRY_LIMIT
      ) {
        throw error;
      }
    }

    await new Promise((resolve) =>
      setTimeout(resolve, REMOVE_PATH_RETRY_DELAY_MS * (attempt + 1)),
    );
  }
}
