import type { Logger } from "@bb/logger";

export type HostDaemonLogger = Pick<Logger, "info" | "warn" | "error">;
