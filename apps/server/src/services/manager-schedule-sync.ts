import path from "node:path";
import matter from "gray-matter";
import {
  getEnvironment,
  getThread,
  replaceManagerThreadNudges,
  type ReplaceManagerThreadNudgeInput,
} from "@bb/db";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import {
  scheduleCronSchema,
  scheduleNameSchema,
  scheduleTimezoneSchema,
} from "@bb/server-contract";
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
const ASYNC_FRONTMATTER_DELIMITER = "---";

const asyncScheduleFrontmatterSchema = z.object({
  schedules: z.array(z.unknown()).optional(),
  timezone: scheduleTimezoneSchema.optional(),
});

const asyncScheduleEntrySchema = z.object({
  cron: scheduleCronSchema,
  name: scheduleNameSchema,
  timezone: scheduleTimezoneSchema.optional(),
});

interface SyncManagerThreadSchedulesArgs {
  threadId: string;
}

function hasFrontmatterPrefix(content: string): boolean {
  return content.trimStart().startsWith(ASYNC_FRONTMATTER_DELIMITER);
}

function hasSupportedFrontmatterDelimiter(content: string): boolean {
  const trimmed = content.trimStart();
  // Only accept a plain YAML opener. gray-matter treats suffixes like
  // `---js` as engine selectors, and the JavaScript engine evals the block.
  return (
    trimmed.startsWith(`${ASYNC_FRONTMATTER_DELIMITER}\n`) ||
    trimmed.startsWith(`${ASYNC_FRONTMATTER_DELIMITER}\r\n`)
  );
}

function toDesiredManagerThreadNudges(
  deps: Pick<AppDeps, "logger">,
  args: {
    content: string;
    now: number;
    threadId: string;
  },
): ReplaceManagerThreadNudgeInput[] | null {
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
  const desiredNudges: ReplaceManagerThreadNudgeInput[] = [];
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
      replaceManagerThreadNudges(deps.db, deps.hub, {
        desiredNudges: [],
        projectId: thread.projectId,
        threadId: thread.id,
      });
      return;
    }
    throw error;
  }

  const contentSizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > MAX_ASYNC_FILE_BYTES || contentSizeBytes > MAX_ASYNC_FILE_BYTES) {
    deps.logger.warn(
      {
        contentSizeBytes,
        sizeBytes,
        threadId: thread.id,
      },
      "Skipping ASYNC.md sync because the file is too large",
    );
    return;
  }

  if (!hasFrontmatterPrefix(content)) {
    replaceManagerThreadNudges(deps.db, deps.hub, {
      desiredNudges: [],
      projectId: thread.projectId,
      threadId: thread.id,
    });
    return;
  }

  if (!hasSupportedFrontmatterDelimiter(content)) {
    deps.logger.warn(
      {
        threadId: thread.id,
      },
      "Skipping ASYNC.md sync because frontmatter must start with a plain --- delimiter",
    );
    return;
  }

  const now = Date.now();
  let desiredNudges: ReplaceManagerThreadNudgeInput[] | null;
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

  replaceManagerThreadNudges(deps.db, deps.hub, {
    desiredNudges,
    projectId: thread.projectId,
    threadId: thread.id,
  });
}
