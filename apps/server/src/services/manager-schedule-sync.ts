import path from "node:path";
import matter from "gray-matter";
import { eq } from "drizzle-orm";
import {
  createManagerThreadNudgeId,
  getEnvironment,
  getThread,
  listManagerThreadNudgesByThread,
  managerThreadNudges,
} from "@bb/db";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { queueCommandAndWait } from "./command-wait.js";
import {
  computeNextScheduledTime,
  ScheduleValidationError,
  validateScheduleDefinition,
} from "./schedule-helpers.js";
import { requireThreadStoragePath } from "./thread-storage.js";

const ASYNC_FILE_NAME = "ASYNC.md";
const DEFAULT_ASYNC_TIMEZONE = "UTC";
const MAX_MANAGER_SCHEDULES = 20;
const MAX_ASYNC_FILE_BYTES = 256 * 1024;

const asyncScheduleFrontmatterSchema = z.object({
  schedules: z.array(z.unknown()).optional(),
  timezone: z.string().min(1).optional(),
});

const asyncScheduleEntrySchema = z.object({
  cron: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1).optional(),
});

interface SyncManagerThreadSchedulesArgs {
  threadId: string;
}

interface DesiredManagerThreadNudge {
  cron: string;
  name: string;
  nextFireAt: number;
  timezone: string;
}

interface ReplaceManagerThreadNudgesArgs {
  desiredNudges: DesiredManagerThreadNudge[];
  projectId: string;
  threadId: string;
}

function hasFrontmatter(content: string): boolean {
  return content.trimStart().startsWith("---");
}

function replaceManagerThreadNudges(
  deps: Pick<AppDeps, "db" | "hub">,
  args: ReplaceManagerThreadNudgesArgs,
): void {
  const existing = listManagerThreadNudgesByThread(deps.db, args.threadId);
  const desiredByName = new Map(
    args.desiredNudges.map((nudge) => [nudge.name, nudge]),
  );
  let changed = false;

  deps.db.transaction((tx) => {
    for (const existingNudge of existing) {
      const desired = desiredByName.get(existingNudge.name);
      if (!desired) {
        tx.delete(managerThreadNudges)
          .where(eq(managerThreadNudges.id, existingNudge.id))
          .run();
        changed = true;
        continue;
      }

      desiredByName.delete(existingNudge.name);

      if (
        existingNudge.cron === desired.cron &&
        existingNudge.timezone === desired.timezone &&
        existingNudge.enabled
      ) {
        continue;
      }

      tx.update(managerThreadNudges)
        .set({
          cron: desired.cron,
          timezone: desired.timezone,
          enabled: true,
          nextFireAt: desired.nextFireAt,
          updatedAt: Date.now(),
        })
        .where(eq(managerThreadNudges.id, existingNudge.id))
        .run();
      changed = true;
    }

    for (const desired of desiredByName.values()) {
      const now = Date.now();
      tx.insert(managerThreadNudges)
        .values({
          id: createManagerThreadNudgeId(),
          projectId: args.projectId,
          threadId: args.threadId,
          name: desired.name,
          cron: desired.cron,
          timezone: desired.timezone,
          enabled: true,
          nextFireAt: desired.nextFireAt,
          lastFiredAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      changed = true;
    }
  }, { behavior: "immediate" });

  if (changed) {
    deps.hub.notifyProject(args.projectId, ["nudges-changed"]);
  }
}

function toDesiredManagerThreadNudges(
  deps: Pick<AppDeps, "logger">,
  args: {
    content: string;
    now: number;
    threadId: string;
  },
): DesiredManagerThreadNudge[] | null {
  const parsed = matter(args.content);
  const frontmatter = asyncScheduleFrontmatterSchema.safeParse(parsed.data);
  if (!frontmatter.success) {
    deps.logger.warn(
      {
        issues: frontmatter.error.issues,
        threadId: args.threadId,
      },
      "Failed to parse ASYNC.md frontmatter",
    );
    return null;
  }

  const schedules = frontmatter.data.schedules ?? [];
  const limitedSchedules = schedules.slice(0, MAX_MANAGER_SCHEDULES);
  if (schedules.length > MAX_MANAGER_SCHEDULES) {
    deps.logger.warn(
      {
        scheduleCount: schedules.length,
        threadId: args.threadId,
      },
      "Skipping extra ASYNC.md schedules beyond the per-thread limit",
    );
  }

  const defaultTimezone = frontmatter.data.timezone ?? DEFAULT_ASYNC_TIMEZONE;
  const desiredNudges: DesiredManagerThreadNudge[] = [];
  const seenNames = new Set<string>();

  for (const rawSchedule of limitedSchedules) {
    const parsedSchedule = asyncScheduleEntrySchema.safeParse(rawSchedule);
    if (!parsedSchedule.success) {
      deps.logger.warn(
        {
          issues: parsedSchedule.error.issues,
          threadId: args.threadId,
        },
        "Skipping invalid ASYNC.md schedule entry",
      );
      continue;
    }

    const schedule = parsedSchedule.data;
    if (seenNames.has(schedule.name)) {
      deps.logger.warn(
        {
          name: schedule.name,
          threadId: args.threadId,
        },
        "Skipping duplicate ASYNC.md schedule name",
      );
      continue;
    }

    const timezone = schedule.timezone ?? defaultTimezone;
    try {
      validateScheduleDefinition({
        cron: schedule.cron,
        timezone,
      });
    } catch (error) {
      if (error instanceof ScheduleValidationError) {
        deps.logger.warn(
          {
            name: schedule.name,
            reason: error.message,
            threadId: args.threadId,
          },
          "Skipping invalid ASYNC.md schedule",
        );
        continue;
      }
      throw error;
    }

    desiredNudges.push({
      cron: schedule.cron,
      name: schedule.name,
      nextFireAt: computeNextScheduledTime({
        cron: schedule.cron,
        timezone,
        now: args.now,
      }),
      timezone,
    });
    seenNames.add(schedule.name);
  }

  return desiredNudges;
}

export async function syncManagerThreadSchedules(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  args: SyncManagerThreadSchedulesArgs,
): Promise<void> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread || thread.type !== "manager" || !thread.environmentId) {
    return;
  }

  const environment = getEnvironment(deps.db, thread.environmentId);
  if (!environment) {
    deps.logger.warn(
      {
        environmentId: thread.environmentId,
        threadId: thread.id,
      },
      "Skipping ASYNC.md sync for manager thread without an environment",
    );
    return;
  }

  const threadStoragePath = requireThreadStoragePath(deps, {
    hostId: environment.hostId,
    threadId: thread.id,
  });

  let content: string;
  let sizeBytes: number;
  try {
    const rawResult = await queueCommandAndWait(deps, {
      hostId: environment.hostId,
      timeoutMs: 10_000,
      command: {
        type: "host.read_file",
        path: path.join(threadStoragePath, ASYNC_FILE_NAME),
        rootPath: threadStoragePath,
      },
    });
    const result = hostDaemonCommandResultSchemaByType["host.read_file"].parse(rawResult);
    if (result.contentEncoding !== "utf8") {
      throw new ApiError(
        502,
        "invalid_request",
        "ASYNC.md must be UTF-8 text",
      );
    }
    sizeBytes = result.sizeBytes;
    content = result.content;
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "ENOENT") {
      replaceManagerThreadNudges(deps, {
        desiredNudges: [],
        projectId: thread.projectId,
        threadId: thread.id,
      });
      return;
    }
    throw error;
  }

  if (sizeBytes > MAX_ASYNC_FILE_BYTES) {
    deps.logger.warn(
      {
        sizeBytes,
        threadId: thread.id,
      },
      "Skipping ASYNC.md sync because the file is too large",
    );
    return;
  }

  if (!hasFrontmatter(content)) {
    replaceManagerThreadNudges(deps, {
      desiredNudges: [],
      projectId: thread.projectId,
      threadId: thread.id,
    });
    return;
  }

  const now = Date.now();
  let desiredNudges: DesiredManagerThreadNudge[] | null;
  try {
    desiredNudges = toDesiredManagerThreadNudges(deps, {
      content,
      now,
      threadId: thread.id,
    });
  } catch (error) {
    deps.logger.warn(
      {
        err: error,
        threadId: thread.id,
      },
      "Failed to parse ASYNC.md",
    );
    return;
  }

  if (desiredNudges === null) {
    return;
  }

  replaceManagerThreadNudges(deps, {
    desiredNudges,
    projectId: thread.projectId,
    threadId: thread.id,
  });
}
