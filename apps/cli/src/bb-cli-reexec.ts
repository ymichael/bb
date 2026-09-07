import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const BB_CLI_REEXEC_ENV = "BB_CLI_REEXEC";

interface MaybeReexecViaBbCliArgs {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  currentExecutablePath?: string;
  reexec?: (args: {
    target: string;
    argv: string[];
    env: NodeJS.ProcessEnv;
  }) => void;
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(resolve(path));
  } catch {
    return null;
  }
}

export function maybeReexecViaBbCli(
  options: MaybeReexecViaBbCliArgs = {},
): void {
  const env = options.env ?? process.env;
  if (env[BB_CLI_REEXEC_ENV] === "1") {
    return;
  }

  const targetRaw = env.BB_CLI?.trim();
  if (!targetRaw) {
    return;
  }

  const currentRaw = options.currentExecutablePath ?? process.argv[1];
  if (!currentRaw) {
    return;
  }

  const target = tryRealpath(targetRaw);
  const current = tryRealpath(currentRaw);
  if (target === null || current === null || target === current) {
    return;
  }

  const argv = options.argv ?? process.argv.slice(2);
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    [BB_CLI_REEXEC_ENV]: "1",
  };

  if (options.reexec) {
    options.reexec({ target, argv, env: childEnv });
    return;
  }

  const result = spawnSync(target, argv, {
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(
      `bb: failed to re-exec BB_CLI=${target}: ${result.error.message}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.exit(result.status === null ? 1 : result.status);
}
