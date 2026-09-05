import { createHostId } from "@bb/db";
import type { AppDeps } from "../../types.js";

type HostEnrollmentDeps = Pick<AppDeps, "db" | "machineAuth">;

interface IssueHostEnrollKeyArgs {
  enrollSource: "loopback" | "public-multi-machine";
  hostId?: string;
}

export async function issueHostEnrollKey(
  deps: HostEnrollmentDeps,
  args: IssueHostEnrollKeyArgs,
) {
  const hostId = args.hostId ?? createHostId();

  const enrollKey = await deps.machineAuth.issueHostEnrollKey({
    enrollSource: args.enrollSource,
    hostId,
  });

  return { enrollKey, hostId };
}
