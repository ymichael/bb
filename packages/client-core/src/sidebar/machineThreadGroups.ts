import type { Host, ThreadListEntry } from "@bb/domain";

export const NO_MACHINE_GROUP_KEY = "no-machine";

interface MachineThreadGroup {
  key: string;
  label: string;
  threads: ThreadListEntry[];
}

export function buildMachineThreadGroups(
  threads: readonly ThreadListEntry[],
  hosts: readonly Host[],
): MachineThreadGroup[] {
  const threadsByKey = new Map<string, ThreadListEntry[]>();
  for (const thread of threads) {
    const key = thread.environmentHostId ?? NO_MACHINE_GROUP_KEY;
    const existing = threadsByKey.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByKey.set(key, [thread]);
    }
  }

  const groups: MachineThreadGroup[] = [];
  for (const host of hosts) {
    const hostThreads = threadsByKey.get(host.id);
    if (!hostThreads) {
      continue;
    }
    threadsByKey.delete(host.id);
    groups.push({ key: host.id, label: host.name, threads: hostThreads });
  }

  const noMachineThreads = threadsByKey.get(NO_MACHINE_GROUP_KEY);
  threadsByKey.delete(NO_MACHINE_GROUP_KEY);

  const unknownHostIds = Array.from(threadsByKey.keys()).sort((left, right) =>
    left.localeCompare(right),
  );
  for (const hostId of unknownHostIds) {
    groups.push({
      key: hostId,
      label: "Unknown machine",
      threads: threadsByKey.get(hostId) ?? [],
    });
  }

  if (noMachineThreads) {
    groups.push({
      key: NO_MACHINE_GROUP_KEY,
      label: "No machine",
      threads: noMachineThreads,
    });
  }

  return groups;
}
