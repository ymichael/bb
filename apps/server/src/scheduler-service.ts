import type {
  ScheduleRunRecord,
  SchedulerService,
  ThreadSchedule,
} from "@bb/core";

export class InMemorySchedulerService implements SchedulerService {
  private schedules = new Map<string, ThreadSchedule>();
  private runsBySchedule = new Map<string, ScheduleRunRecord[]>();

  listSchedules(): ThreadSchedule[] {
    return Array.from(this.schedules.values());
  }

  upsertSchedule(schedule: ThreadSchedule): ThreadSchedule {
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  deleteSchedule(id: string): boolean {
    this.runsBySchedule.delete(id);
    return this.schedules.delete(id);
  }

  listRuns(scheduleId: string): ScheduleRunRecord[] {
    return this.runsBySchedule.get(scheduleId) ?? [];
  }

  tick(_nowMs: number): void {
    // Phase 2 boundary contract only: scheduling engine hooks land in Phase 5.
  }
}
