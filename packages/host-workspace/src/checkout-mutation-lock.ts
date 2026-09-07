import path from "node:path";
import { getAbsoluteGitDir, type GitProcessOptions } from "./git.js";
import {
  withProcessLocalQueuedLocks,
  type ProcessLocalQueuedLockSpec,
  type ProcessLocalQueuedLockWork,
} from "./process-local-queued-lock.js";

type CheckoutMutationLockWork<T> = ProcessLocalQueuedLockWork<T>;

const checkoutMutationAdmissionKeyPrefix = "checkout-mutation-admission:";

function getCheckoutMutationAdmissionLockSpec(
  checkoutPath: string,
): ProcessLocalQueuedLockSpec {
  return {
    key: `${checkoutMutationAdmissionKeyPrefix}${path.resolve(checkoutPath)}`,
  };
}

function getCheckoutMutationAdmissionLockSpecs(
  checkoutPaths: string[],
): ProcessLocalQueuedLockSpec[] {
  return checkoutPaths.map((checkoutPath) =>
    getCheckoutMutationAdmissionLockSpec(checkoutPath),
  );
}

export async function withCheckoutMutationAdmission<T>(
  checkoutPath: string,
  work: CheckoutMutationLockWork<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withProcessLocalQueuedLocks({
    locks: [getCheckoutMutationAdmissionLockSpec(checkoutPath)],
    signal,
    work,
  });
}

async function resolveCheckoutMutationLockSpec(
  checkoutPath: string,
  options: GitProcessOptions,
): Promise<ProcessLocalQueuedLockSpec> {
  return { key: await getAbsoluteGitDir(checkoutPath, options) };
}

export async function withCheckoutMutationLock<T>(
  checkoutPath: string,
  work: CheckoutMutationLockWork<T>,
  signal?: AbortSignal,
  options: GitProcessOptions = {},
): Promise<T> {
  return withCheckoutMutationAdmission(
    checkoutPath,
    async () => {
      const lock = await resolveCheckoutMutationLockSpec(checkoutPath, options);
      return withProcessLocalQueuedLocks({ locks: [lock], signal, work });
    },
    signal,
  );
}

async function withCheckoutMutationAdmissions<T>(
  checkoutPaths: string[],
  work: CheckoutMutationLockWork<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withProcessLocalQueuedLocks({
    locks: getCheckoutMutationAdmissionLockSpecs(checkoutPaths),
    signal,
    work,
  });
}

export async function withCheckoutMutationLocks<T>(
  checkoutPaths: string[],
  work: CheckoutMutationLockWork<T>,
  signal?: AbortSignal,
  options: GitProcessOptions = {},
): Promise<T> {
  return withCheckoutMutationAdmissions(
    checkoutPaths,
    async () => {
      const locks = await Promise.all(
        checkoutPaths.map((checkoutPath) =>
          resolveCheckoutMutationLockSpec(checkoutPath, options),
        ),
      );
      return withProcessLocalQueuedLocks({ locks, signal, work });
    },
    signal,
  );
}
