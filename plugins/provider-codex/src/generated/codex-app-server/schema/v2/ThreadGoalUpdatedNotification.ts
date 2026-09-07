
import type { ThreadGoal } from "./ThreadGoal.js";

export type ThreadGoalUpdatedNotification = { threadId: string, turnId: string | null, goal: ThreadGoal, };
