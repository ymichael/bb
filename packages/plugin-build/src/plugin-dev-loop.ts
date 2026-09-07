const DEFAULT_DEBOUNCE_MS = 300;
const IGNORED_SEGMENTS = new Set(["dist", "node_modules", ".git"]);

export function isIgnoredPluginDevPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => IGNORED_SEGMENTS.has(segment));
}

export interface PluginDevLoopTargets {
  hasApp: boolean;
  hasHost: boolean;
}

interface PluginDevLoopDeps {
  pluginId: string;
  // Re-resolved every cycle: a plugin can add or drop its app/host entry
  // while the dev loop is watching, and a stale snapshot would demand a
  // build that can never succeed again (or skip one that now must run).
  targets: () => Promise<PluginDevLoopTargets>;
  buildApp: () => Promise<void>;
  buildHost: () => Promise<void>;
  reloadPlugin: () => Promise<void>;
  log: (line: string) => void;
  debounceMs?: number;
  now?: () => number;
}

interface PluginDevLoop {
  handleChange: (relativePath: string) => void;
  settled: () => Promise<void>;
  dispose: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPluginDevLoop(deps: PluginDevLoopDeps): PluginDevLoop {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = deps.now ?? (() => Date.now());
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let queueTail: Promise<void> = Promise.resolve();
  async function runCycle(files: readonly string[]): Promise<void> {
    if (disposed) return;
    const parts = [
      `${files.length} file${files.length === 1 ? "" : "s"} changed`,
    ];
    let targets: PluginDevLoopTargets;
    try {
      targets = await deps.targets();
    } catch (error) {
      parts.push(`manifest read failed: ${errorMessage(error)}`);
      deps.log(`${parts.join(" · ")} — fix and save to retry`);
      return;
    }
    if (targets.hasApp) {
      const startedAt = now();
      try {
        await deps.buildApp();
        parts.push(
          `rebuilt app in ${Math.max(0, Math.round(now() - startedAt))}ms`,
        );
      } catch (error) {
        parts.push(`build failed: ${errorMessage(error)}`);
        deps.log(`${parts.join(" · ")} — fix and save to retry`);
        return;
      }
    }
    if (targets.hasHost) {
      const startedAt = now();
      try {
        await deps.buildHost();
        parts.push(
          `rebuilt host in ${Math.max(0, Math.round(now() - startedAt))}ms`,
        );
      } catch (error) {
        parts.push(`host build failed: ${errorMessage(error)}`);
        deps.log(`${parts.join(" · ")} — fix and save to retry`);
        return;
      }
    }
    try {
      await deps.reloadPlugin();
      parts.push(`reloaded ${deps.pluginId}`);
    } catch (error) {
      parts.push(`reload failed: ${errorMessage(error)}`);
    }
    deps.log(parts.join(" · "));
  }
  function flush(): void {
    timer = null;
    if (pending.size === 0) return;
    const files = [...pending];
    pending.clear();
    queueTail = queueTail.then(() => runCycle(files));
  }
  return {
    handleChange(relativePath) {
      if (disposed || isIgnoredPluginDevPath(relativePath)) return;
      pending.add(relativePath);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    settled: () => queueTail,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
