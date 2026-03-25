import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

export const DAEMON_LOCK_FILE_NAME = "daemon.lock";

export async function acquireDaemonLock(
  dataDir: string,
): Promise<() => Promise<void>> {
  await fs.mkdir(dataDir, { recursive: true });

  const lockPath = path.join(dataDir, DAEMON_LOCK_FILE_NAME);
  await fs.writeFile(lockPath, "", { encoding: "utf8", flag: "a" });

  const release = await lockfile.lock(lockPath, {
    realpath: false,
    retries: 0,
  });

  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    await release();
  };
}
