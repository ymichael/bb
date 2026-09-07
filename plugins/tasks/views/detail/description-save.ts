export interface DescriptionSaveOutcome {
  ok: boolean;
  errorMessage?: string;
}

interface DescriptionSaverOptions {
  save(taskId: string, markdown: string): Promise<DescriptionSaveOutcome>;
  onError(message: string): void;
  delayMs: number;
  schedule?(run: () => void, delayMs: number): () => void;
}

export interface DescriptionSaver {
  onChange(taskId: string, markdown: string): void;
  flush(taskId: string): void;
  hasPending(): boolean;
}

export function createDescriptionSaver(
  options: DescriptionSaverOptions,
): DescriptionSaver {
  const schedule =
    options.schedule ??
    ((run: () => void, delayMs: number) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });

  let cancelTimer: (() => void) | undefined;
  let pending: { taskId: string; markdown: string } | undefined;

  const runSave = async (attempt: { taskId: string; markdown: string }) => {
    try {
      const result = await options.save(attempt.taskId, attempt.markdown);
      if (pending === attempt) pending = undefined;
      if (!result.ok && result.errorMessage !== undefined) {
        options.onError(result.errorMessage);
      }
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
    }
  };

  return {
    onChange(taskId, markdown) {
      pending = { taskId, markdown };
      cancelTimer?.();
      const attempt = pending;
      cancelTimer = schedule(() => {
        void runSave(pending ?? attempt);
      }, options.delayMs);
    },
    flush(taskId) {
      cancelTimer?.();
      cancelTimer = undefined;
      if (pending === undefined || pending.taskId !== taskId) return;
      const attempt = pending;
      pending = undefined;
      void options
        .save(attempt.taskId, attempt.markdown)
        .catch(() => undefined);
    },
    hasPending: () => pending !== undefined,
  };
}
