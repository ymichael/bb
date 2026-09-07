export interface FrameScheduler {
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
  setTimeout: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const DEFERRED_REALIZATION_FRAMES = 2;
const DEFERRED_REALIZATION_TIMEOUT_MS = 120;

export function scheduleDeferredRealization(
  realize: () => void,
  scheduler: FrameScheduler,
  options: { frames?: number; timeoutMs?: number } = {},
): () => void {
  const frames = options.frames ?? DEFERRED_REALIZATION_FRAMES;
  const timeoutMs = options.timeoutMs ?? DEFERRED_REALIZATION_TIMEOUT_MS;
  let done = false;
  let frameHandle: number | null = null;
  let remaining = frames;

  const finish = () => {
    if (done) return;
    done = true;
    if (frameHandle !== null) scheduler.cancelAnimationFrame(frameHandle);
    scheduler.clearTimeout(timeoutHandle);
    realize();
  };

  const tick = () => {
    frameHandle = null;
    remaining -= 1;
    if (remaining <= 0) {
      finish();
      return;
    }
    frameHandle = scheduler.requestAnimationFrame(tick);
  };

  const timeoutHandle = scheduler.setTimeout(finish, timeoutMs);
  if (frames <= 0) {
    finish();
  } else {
    frameHandle = scheduler.requestAnimationFrame(tick);
  }

  return () => {
    if (done) return;
    done = true;
    if (frameHandle !== null) scheduler.cancelAnimationFrame(frameHandle);
    scheduler.clearTimeout(timeoutHandle);
  };
}
