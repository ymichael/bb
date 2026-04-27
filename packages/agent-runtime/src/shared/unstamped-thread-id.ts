declare const unstampedThreadIdBrand: unique symbol;

export type UnstampedThreadId = string & {
  readonly [unstampedThreadIdBrand]: "runtime-stamped-thread-id";
};

// Adapter translations can be emitted before the runtime resolves the bb
// thread. Runtime stamping must replace this before events leave agent-runtime.
export const UNSTAMPED_THREAD_ID = "" as UnstampedThreadId;
