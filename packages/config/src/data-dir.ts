import { envsafe, makeValidator } from "envsafe";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface ResolveConfiguredDataDirArgs {
  defaultDirName: string;
  env?: NodeJS.ProcessEnv;
}

function expandHomeDirectory(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }

  if (pathValue.startsWith("~/")) {
    return resolve(homedir(), pathValue.slice(2));
  }

  return resolve(pathValue);
}

export const dataDir = makeValidator((input: string) => expandHomeDirectory(input.trim()));

export function resolveConfiguredDataDir(args: ResolveConfiguredDataDirArgs): string {
  return envsafe({
    BB_DATA_DIR: dataDir({
      default: join(homedir(), args.defaultDirName),
      desc: "Root directory for all bb data (db, logs, host-id, etc.)",
    }),
  }, {
    env: args.env,
  }).BB_DATA_DIR;
}
