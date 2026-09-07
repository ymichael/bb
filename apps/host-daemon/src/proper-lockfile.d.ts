declare module "proper-lockfile" {
  export interface LockRetryOptions {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
  }

  export interface LockOptions {
    realpath?: boolean;
    retries?: number | LockRetryOptions;
    stale?: number;
    update?: number;
    lockfilePath?: string;
    onCompromised?: (error: Error) => void;
  }

  export type ReleaseFn = () => Promise<void>;

  export function lock(file: string, options?: LockOptions): Promise<ReleaseFn>;

  const lockfile: {
    lock: typeof lock;
  };

  export default lockfile;
}
