import { createHostId } from "@bb/db";
import type { AppDeps } from "../../types.js";

type HostEnrollmentDeps = Pick<AppDeps, "db" | "machineAuth">;

interface IssuePersistentHostEnrollKeyArgs {
  enrollSource: "loopback" | "public-multi-machine";
  hostId?: string;
}

export async function issuePersistentHostEnrollKey(
  deps: HostEnrollmentDeps,
  args: IssuePersistentHostEnrollKeyArgs,
) {
  const hostId = args.hostId ?? createHostId();

  const enrollKey = await deps.machineAuth.issueHostEnrollKey({
    enrollSource: args.enrollSource,
    hostId,
    hostType: "persistent",
  });

  return { enrollKey, hostId };
}
