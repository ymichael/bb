import { describe, expect, it } from "vitest";
import {
  computeNextScheduledTime,
  parseCronScheduleDefinition,
  ScheduleValidationError,
  validateScheduleDefinition,
} from "../../src/services/scheduling/schedule-helpers.js";
import {
  createDailySchedule,
  createMonthlySchedule,
  createHourlySchedule,
  createWeeklySchedule,
} from "../helpers/schedules.js";

describe("schedule helpers", () => {
  it("moves spring-forward schedules to the next valid local time", () => {
    const nextRunAt = computeNextScheduledTime({
      now: Date.parse("2026-03-08T09:55:00.000Z"),
      ...createDailySchedule({
        times: ["02:00"],
        timezone: "America/Los_Angeles",
      }),
    });

    expect(nextRunAt).toBe(Date.parse("2026-03-08T10:00:00.000Z"));
  });

  it("picks the first repeated local time during fall-back", () => {
    const nextRunAt = computeNextScheduledTime({
      now: Date.parse("2026-11-01T08:10:00.000Z"),
      ...createDailySchedule({
        times: ["01:30"],
        timezone: "America/Los_Angeles",
      }),
    });

    expect(nextRunAt).toBe(Date.parse("2026-11-01T08:30:00.000Z"));
  });

  it("moves to the next day after the repeated fall-back hour has already passed", () => {
    const nextRunAt = computeNextScheduledTime({
      now: Date.parse("2026-11-01T09:40:00.000Z"),
      ...createDailySchedule({
        times: ["01:30"],
        timezone: "America/Los_Angeles",
      }),
    });

    expect(nextRunAt).toBe(Date.parse("2026-11-02T09:30:00.000Z"));
  });

  it("skips months that do not have the configured monthly date", () => {
    const nextRunAt = computeNextScheduledTime({
      now: Date.parse("2026-04-30T12:00:00.000Z"),
      ...createMonthlySchedule({
        dayOfMonth: 31,
        times: ["09:00"],
      }),
    });

    expect(nextRunAt).toBe(Date.parse("2026-05-31T09:00:00.000Z"));
  });

  it("rejects daily schedules that run less than five minutes apart across midnight", () => {
    expect(() =>
      validateScheduleDefinition(createDailySchedule({
        times: ["00:01", "23:58"],
      })))
      .toThrow(ScheduleValidationError);
  });

  it("rejects weekly schedules that run less than five minutes apart across adjacent days", () => {
    expect(() =>
      validateScheduleDefinition(createWeeklySchedule({
        times: ["00:01", "23:58"],
        weekdays: ["mon", "tue"],
      })))
      .toThrow(ScheduleValidationError);
  });

  it("accepts hourly schedules without sampled cron iteration", () => {
    expect(() =>
      validateScheduleDefinition(createHourlySchedule({
        intervalHours: 2,
        minute: 15,
      })))
      .not.toThrow();
  });

  it("parses supported weekly cron schedules into the internal subset model", () => {
    expect(parseCronScheduleDefinition({
      cron: "0 8 * * 1-5",
      timezone: "UTC",
    })).toEqual({
      kind: "weekly",
      times: ["08:00"],
      timezone: "UTC",
      weekdays: ["mon", "tue", "wed", "thu", "fri"],
    });
  });

  it("supports cron schedules with multiple daily times", () => {
    expect(parseCronScheduleDefinition({
      cron: "0,30 9,17 * * *",
      timezone: "UTC",
    })).toEqual({
      kind: "daily",
      times: ["09:00", "09:30", "17:00", "17:30"],
      timezone: "UTC",
    });
  });

  it("rejects unsupported cron schedules", () => {
    expect(() =>
      parseCronScheduleDefinition({
        cron: "*/5 8 * * *",
        timezone: "UTC",
      }))
      .toThrow(ScheduleValidationError);
  });
});
