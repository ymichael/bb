
import type { ModelRerouteReason } from "./ModelRerouteReason.js";

export type ModelReroutedNotification = { threadId: string, turnId: string, fromModel: string, toModel: string, reason: ModelRerouteReason, };
